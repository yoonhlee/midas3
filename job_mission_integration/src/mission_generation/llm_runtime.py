# LLM structured output 호출과 응답 파싱을 담당한다. 제공자별 호출부(OpenAI Responses, Claude Messages)가 같은 결과 형식을 돌려준다.

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import RuntimeConfig, local_env_value


class _CallResultMixin:
    """제공자와 상관없이 같은 llm_call_result.v1 조각(temperature·재시도 기록, JSON 파싱, 빈 usage)을 만든다."""

    config: RuntimeConfig

    def _temperature_metadata(
        self,
        configured_temperature: float,
        *,
        applied: bool | None = None,
        omitted_reason: str | None = None,
        fallback_used: bool = False,
    ) -> dict[str, Any]:
        """요청 의도와 실제 적용 여부를 분리해 기록한다.

        예를 들어 요청에는 temperature를 넣었지만 모델이 거부해 재시도한 경우,
        request_parameter는 temperature이고 temperature_applied는 False가 된다.
        """

        temperature_policy = self.config.temperature_application()
        intended_request_parameter = str(temperature_policy.get("request_parameter") or "omitted")
        actual_applied = bool(temperature_policy.get("temperature_applied")) if applied is None else applied
        actual_omitted_reason = None if actual_applied else (
            omitted_reason or temperature_policy.get("temperature_omitted_reason")
        )
        return {
            "configured_temperature": configured_temperature,
            "temperature_request_parameter": intended_request_parameter,
            "temperature_applied": actual_applied,
            "temperature_omitted_reason": actual_omitted_reason,
            "temperature_retry_without_parameter": fallback_used,
        }

    def _retry_metadata(
        self,
        attempt_count: int,
        retry_errors: list[dict[str, str]],
        attempt_elapsed_ms: list[int] | None = None,
    ) -> dict[str, Any]:
        return {
            "attempt_count": attempt_count,
            "retry_count": max(0, attempt_count - 1),
            "retry_errors": retry_errors,
            "attempt_elapsed_ms": list(attempt_elapsed_ms or []),
        }

    def _parse_json(self, text: str) -> Any:
        """모델 출력에서 JSON 객체를 파싱하고, 앞뒤 잡음이 있으면 한 번 보정한다."""

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                return json.loads(text[start : end + 1])
            raise ValueError("could not parse JSON output")

    def _empty_usage(self) -> dict[str, int]:
        """LLM 호출이 없거나 실패했을 때 사용할 빈 usage 구조를 만든다."""

        return {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0}


class OpenAIResponsesRuntime(_CallResultMixin):
    """OpenAI Responses API를 호출하고 공통 응답 메타데이터를 표준화한다."""

    endpoint = "https://api.openai.com/v1/responses"

    def __init__(self, config: RuntimeConfig | None = None) -> None:
        # 기본 제공자가 Claude여도 이 호출부는 OpenAI 설정을 쓴다. 다른 제공자의 설정을 받으면
        # 그 제공자의 key가 OpenAI로 나갈 수 있으므로 거절한다.
        self.config = config or RuntimeConfig(provider="openai")
        if self.config.provider != "openai":
            raise ValueError(
                f"OpenAIResponsesRuntime needs an openai RuntimeConfig, got {self.config.provider!r}. "
                "Use create_runtime() to follow MISSION_LLM_PROVIDER."
            )
        self._load_local_env_key()

    def api_key_available(self) -> bool:
        """환경 변수 또는 .env.local에서 사용할 API key가 준비됐는지 확인한다."""

        return bool(os.environ.get(self.config.api_key_env))

    def _load_local_env_key(self) -> None:
        """환경 변수에 key가 없을 때 .env.local에서 가져온다."""

        if os.environ.get(self.config.api_key_env):
            return
        env_path = Path.cwd() / ".env.local"
        if not env_path.exists():
            return
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                    continue
                name, value = line.split("=", 1)
                if name.strip() == self.config.api_key_env and value.strip():
                    os.environ[self.config.api_key_env] = value.strip().strip('"').strip("'")
                    return
        except OSError:
            return

    def call_structured(
        self,
        *,
        call_type: str,
        system_prompt: str,
        user_prompt: str,
        json_schema: dict[str, Any],
        temperature: float,
        max_output_tokens: int,
        schema_name: str = "mission_output_v1_draft",
    ) -> dict[str, Any]:
        """strict JSON schema를 포함해 LLM을 호출하고 파싱된 JSON 결과만 반환한다."""

        if not self.api_key_available():
            return self._missing_key_result(call_type, temperature)

        # 설정상 허용된 경우 Responses API body에 temperature를 실제로 넣는다.
        # 단, gpt 계열 중 일부는 temperature를 거부하므로 실패 시 아래에서 한 번 제거하고 재시도한다.
        temperature_policy = self.config.temperature_application()
        temperature_applied = bool(temperature_policy.get("temperature_applied"))
        temperature_omitted_reason = temperature_policy.get("temperature_omitted_reason")
        temperature_fallback_used = False
        request_body = {
            "model": self.config.model,
            "reasoning": {"effort": self.config.reasoning_effort},
            "max_output_tokens": max_output_tokens,
            "tools": [],
            "tool_choice": "none",
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_prompt}]},
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "strict": True,
                    "schema": json_schema,
                }
            },
        }
        if temperature_applied:
            request_body["temperature"] = temperature

        last_error: dict[str, str] | None = None
        retry_errors: list[dict[str, str]] = []
        # 시도마다 걸린 시간(ms). 시간 초과로 끝난 시도도 남겨 timeout_seconds를 정하는 근거로 쓴다.
        attempt_elapsed_ms: list[int] = []

        def timed_post() -> dict[str, Any]:
            started = time.monotonic()
            try:
                return self._post(request_body)
            finally:
                attempt_elapsed_ms.append(int((time.monotonic() - started) * 1000))

        attempt_count = 0
        max_attempts = self.config.max_api_retries + 1
        while attempt_count < max_attempts:
            attempt = attempt_count
            attempt_count += 1
            try:
                response = timed_post()
                output_text = self._extract_output_text(response)
                output_json = self._parse_json(output_text)
                usage = self._usage(response)
                return {
                    "schema_version": "llm_call_result.v1",
                    "provider": self.config.provider,
                    "api": self.config.api,
                    "model": self.config.model,
                    "call_type": call_type,
                    "reasoning_effort": self.config.reasoning_effort,
                    **self._temperature_metadata(
                        temperature,
                        applied=temperature_applied,
                        omitted_reason=temperature_omitted_reason,
                        fallback_used=temperature_fallback_used,
                    ),
                    **self._retry_metadata(attempt_count, retry_errors, attempt_elapsed_ms),
                    "status": response.get("status", "completed"),
                    "output_json": output_json,
                    "usage": usage,
                    "errors": [],
                }
            except urllib.error.HTTPError as exc:
                last_error = self._map_http_error(exc)
                if "temperature" in request_body and self._is_temperature_unsupported_error(last_error):
                    # 모델 미지원은 생성 실패로 보지 않고 temperature 없이 재시도해 생성 흐름의 안정성을 유지한다.
                    retry_errors.append(last_error)
                    request_body.pop("temperature", None)
                    temperature_applied = False
                    temperature_omitted_reason = "unsupported_by_model_retry_without_temperature"
                    temperature_fallback_used = True
                    if attempt_count >= max_attempts:
                        max_attempts += 1
                    time.sleep(1)
                    continue
                if not self._should_retry(last_error["code"], attempt):
                    break
                retry_errors.append(last_error)
                time.sleep(1)
            except TimeoutError:
                last_error = {"code": "OPENAI_TIMEOUT", "message": "OpenAI request timed out."}
                if not self._should_retry(last_error["code"], attempt):
                    break
                retry_errors.append(last_error)
                time.sleep(1)
            except (urllib.error.URLError, OSError) as exc:
                last_error = {"code": "OPENAI_SERVER_ERROR", "message": str(exc)}
                if not self._should_retry(last_error["code"], attempt):
                    break
                retry_errors.append(last_error)
                time.sleep(1)
            except ValueError as exc:
                last_error = {"code": "OUTPUT_PARSE_FAILED", "message": str(exc)}
                if not self._should_retry(last_error["code"], attempt):
                    break
                retry_errors.append(last_error)
                time.sleep(1)

        return {
            "schema_version": "llm_call_result.v1",
            "provider": self.config.provider,
            "api": self.config.api,
            "model": self.config.model,
            "call_type": call_type,
            "reasoning_effort": self.config.reasoning_effort,
            **self._temperature_metadata(
                temperature,
                applied=temperature_applied,
                omitted_reason=temperature_omitted_reason,
                fallback_used=temperature_fallback_used,
            ),
            **self._retry_metadata(attempt_count, retry_errors, attempt_elapsed_ms),
            "status": "failed",
            "output_json": None,
            "usage": self._empty_usage(),
            "errors": [last_error or {"code": "OPENAI_SERVER_ERROR", "message": "OpenAI request failed."}],
        }

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        """Responses API에 HTTP POST를 보내고 JSON 응답을 반환한다."""

        api_key = os.environ[self.config.api_key_env]
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )
        with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def _missing_key_result(self, call_type: str, temperature: float) -> dict[str, Any]:
        """API key가 없을 때도 저장 가능한 표준 call_result를 반환한다."""

        return {
            "schema_version": "llm_call_result.v1",
            "provider": self.config.provider,
            "api": self.config.api,
            "model": self.config.model,
            "call_type": call_type,
            "reasoning_effort": self.config.reasoning_effort,
            **self._temperature_metadata(
                temperature,
                applied=False,
                omitted_reason="api_key_missing",
            ),
            **self._retry_metadata(1, []),
            "status": "skipped",
            "output_json": None,
            "usage": self._empty_usage(),
            "errors": [{"code": "OPENAI_API_KEY_MISSING", "message": "OPENAI_API_KEY is not set."}],
        }

    def _extract_output_text(self, response: dict[str, Any]) -> str:
        """Responses API 응답 형태 차이를 흡수해 출력 텍스트만 꺼낸다."""

        if isinstance(response.get("output_text"), str):
            return response["output_text"]
        chunks: list[str] = []
        for output in response.get("output", []) or []:
            for content in output.get("content", []) or []:
                text = content.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        if chunks:
            return "".join(chunks)
        raise ValueError("response did not contain output text")

    def _usage(self, response: dict[str, Any]) -> dict[str, int]:
        """Responses API usage 필드를 프로젝트 표준 token usage 구조로 바꾼다."""

        usage = response.get("usage") or {}
        output_details = usage.get("output_tokens_details") or {}
        return {
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
            "reasoning_tokens": int(output_details.get("reasoning_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
        }

    def _map_http_error(self, exc: urllib.error.HTTPError) -> dict[str, str]:
        """HTTP status code를 프로젝트 표준 오류 코드로 바꾼다."""

        if exc.code in {401, 403}:
            code = "OPENAI_AUTH_FAILED"
        elif exc.code == 429:
            code = "OPENAI_RATE_LIMITED"
        elif 500 <= exc.code < 600:
            code = "OPENAI_SERVER_ERROR"
        else:
            code = "OPENAI_BAD_REQUEST"
        return {"code": code, "message": self._safe_http_error_message(exc)}

    def _safe_http_error_message(self, exc: urllib.error.HTTPError) -> str:
        """API 오류 응답에서 key가 노출되지 않는 안전한 메시지만 추출한다."""

        fallback = f"OpenAI HTTP error {exc.code}."
        try:
            body = exc.read().decode("utf-8", errors="replace")
            error = json.loads(body).get("error", {})
        except Exception:
            return fallback
        if not isinstance(error, dict):
            return fallback
        message = error.get("message")
        if not isinstance(message, str) or not message:
            return fallback
        details: list[str] = []
        for key in ("type", "param", "code"):
            value = error.get(key)
            if isinstance(value, str) and value:
                details.append(f"{key}={value}")
        suffix = f" ({', '.join(details)})" if details else ""
        return f"{message}{suffix}"

    def _is_temperature_unsupported_error(self, error: dict[str, str]) -> bool:
        """OpenAI 에러 문구가 temperature 미지원 케이스인지 보수적으로 판별한다."""

        message = f"{error.get('code', '')} {error.get('message', '')}".lower()
        if "temperature" not in message:
            return False
        unsupported_markers = (
            "unsupported",
            "not supported",
            "does not support",
            "unknown parameter",
            "unrecognized",
            "invalid parameter",
            "param=temperature",
        )
        return any(marker in message for marker in unsupported_markers)

    def _should_retry(self, code: str, attempt: int) -> bool:
        """일시적 오류와 출력 파싱 실패에 대해서만 설정된 횟수 안에서 재시도한다."""

        return attempt < self.config.max_api_retries and code in {
            "OPENAI_RATE_LIMITED",
            "OPENAI_TIMEOUT",
            "OPENAI_SERVER_ERROR",
            "OUTPUT_PARSE_FAILED",
        }


# Claude의 JSON 고정 출력이 받지 않는 형식 키워드(개수·크기·길이 제한). 이런 제한은 코드 검사(validator, 설계서 검사)가 본다.
_CLAUDE_UNSUPPORTED_SCHEMA_KEYWORDS = frozenset(
    {
        "minItems",
        "maxItems",
        "uniqueItems",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
    }
)
# 이 키 아래의 dict는 키가 형식 키워드가 아니라 이름(속성 이름, 정의 이름)이다.
_SCHEMA_NAME_MAPS = ("properties", "$defs", "definitions")


def sanitize_schema_for_claude(schema: Any) -> tuple[Any, list[str]]:
    """형식의 복사본에서 Claude가 받지 않는 키워드를 빼고, 뺀 키워드 이름을 함께 돌려준다.

    받은 형식은 바꾸지 않는다(저장되는 형식 제약과 GPT 요청은 그대로다). 속성 이름이 키워드와 같아도 지우지 않는다.
    문자열만 있는 enum에 type이 없으면 type을 붙인다(뜻은 같고 받아들여질 가능성이 높아진다).
    """

    removed: set[str] = set()

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out: dict[str, Any] = {}
            for key, value in node.items():
                if key in _CLAUDE_UNSUPPORTED_SCHEMA_KEYWORDS:
                    removed.add(key)
                    continue
                if key in _SCHEMA_NAME_MAPS and isinstance(value, dict):
                    out[key] = {name: walk(sub) for name, sub in value.items()}
                else:
                    out[key] = walk(value)
            enum = out.get("enum")
            if "type" not in out and isinstance(enum, list) and enum and all(isinstance(item, str) for item in enum):
                out["type"] = "string"
            return out
        if isinstance(node, list):
            return [walk(item) for item in node]
        return node

    return walk(schema), sorted(removed)


# Claude가 고정 출력 형식을 문법으로 바꿨을 때 크기 한도를 넘으면 400과 함께 이 문구를 준다.
# 실제 호출에서 미션 형식(mission_output.v1)이 여기에 걸렸다. 설계서 형식은 통과한다.
GRAMMAR_TOO_LARGE_MARKER = "compiled grammar is too large"

# 고정 출력을 못 쓸 때 사용자 프롬프트 끝에 붙이는 지시. 이 뒤에 JSON Schema를 그대로 붙인다.
PROMPTED_JSON_INSTRUCTION = (
    "\n\nOutput format:\n"
    "Return exactly one JSON object and nothing else: no Markdown code fence and no commentary before or after it.\n"
    "The object must validate against this JSON Schema. Every property listed in the schema is required, "
    "and no other properties are allowed.\n"
)


class AnthropicMessagesRuntime(_CallResultMixin):
    """Claude Messages API를 호출해 JSON을 받고 OpenAI 쪽과 같은 모양의 결과를 돌려준다.

    먼저 JSON 고정 출력(output_config.format)으로 부른다. 형식이 커서 거절되면 형식을 프롬프트에 적어
    JSON으로 받는다(결과의 structured_output_mode가 "prompted"). 이 경우 모양 검사는 뒤의 검증기가 맡는다.
    anthropic 패키지는 실제 호출 때에만 불러온다. 패키지가 없어도 GPT 경로와 mock 실행은 돈다.
    client와 sdk는 테스트에서 가짜를 넣기 위한 자리다.
    """

    fallback_beta = "server-side-fallback-2026-07-01"
    # 이 모델은 추론에 쓴 토큰도 max_tokens에 들어가므로, 호출하는 쪽이 더 작게 줘도 이 값으로 올린다.
    min_max_tokens = 16000
    retryable_codes = {
        "ANTHROPIC_RATE_LIMITED",
        "ANTHROPIC_TIMEOUT",
        "ANTHROPIC_SERVER_ERROR",
        "OUTPUT_PARSE_FAILED",
    }

    def __init__(self, config: RuntimeConfig | None = None, client: Any = None, sdk: Any = None) -> None:
        self.config = config or RuntimeConfig(provider="anthropic")
        if self.config.provider != "anthropic":
            raise ValueError(
                f"AnthropicMessagesRuntime needs an anthropic RuntimeConfig, got {self.config.provider!r}. "
                "Use create_runtime() to follow MISSION_LLM_PROVIDER."
            )
        self._client = client
        self._sdk = sdk
        self._sleep = time.sleep
        # 고정 출력이 "형식이 너무 크다"로 거절된 형식. 같은 형식은 다음부터 바로 프롬프트 방식으로 보낸다.
        self._grammar_too_large: set[str] = set()

    def api_key_available(self) -> bool:
        """셸 환경 변수, .env.local, .env 중 한 곳에 key가 있는지 확인한다."""

        return bool(local_env_value(self.config.api_key_env))

    def call_structured(
        self,
        *,
        call_type: str,
        system_prompt: str,
        user_prompt: str,
        json_schema: dict[str, Any],
        temperature: float,
        max_output_tokens: int,
        schema_name: str = "mission_output_v1_draft",
    ) -> dict[str, Any]:
        """JSON schema를 붙여 Claude를 호출하고 파싱된 JSON 결과를 반환한다.

        temperature와 schema_name은 OpenAI 호출부와 입력을 맞추려고 받는다. 이 모델은 temperature를 받지 않아 보내지 않는다.
        """

        if not self.api_key_available():
            return self._closed_result(
                call_type,
                temperature,
                status="skipped",
                error={"code": "LLM_API_KEY_MISSING", "message": f"{self.config.api_key_env} is not set."},
            )
        try:
            sdk = self._load_sdk()
        except ImportError:
            return self._closed_result(
                call_type,
                temperature,
                status="failed",
                error={
                    "code": "ANTHROPIC_SDK_MISSING",
                    "message": "anthropic package is not installed. Run: python -m pip install -r requirements.txt",
                },
            )
        try:
            client = self._get_client(sdk)
        except Exception as exc:  # 패키지 버전 차이 등으로 클라이언트를 못 만들어도 예외로 죽지 않고 실패 결과를 남긴다.
            return self._closed_result(
                call_type,
                temperature,
                status="failed",
                error=self._error("ANTHROPIC_CLIENT_FAILED", exc, with_type=True),
            )

        # 이 모델이 받지 않는 형식 키워드는 빼고 보낸다. 뺀 키워드는 결과에 남긴다.
        claude_schema, schema_keywords_removed = sanitize_schema_for_claude(json_schema)
        # 형식이 커서 고정 출력을 거절당한 적이 있으면 처음부터 형식을 프롬프트에 적어 보낸다.
        schema_key = json.dumps(json_schema, ensure_ascii=False, sort_keys=True)
        mode = "prompted" if schema_key in self._grammar_too_large else "strict"
        create = client.beta.messages.create if self.config.fallbacks_enabled else client.messages.create
        # 빠른 모드로 부르다 요청 한도에 걸리면 보통 속도(None)로 한 번 내려온다.
        speed = self.config.speed
        speed_fallback = False

        def build_request(current_mode: str, current_speed: str | None) -> dict[str, Any]:
            output_config: dict[str, Any] = {"effort": self.config.reasoning_effort}
            content = user_prompt
            if current_mode == "strict":
                output_config["format"] = {"type": "json_schema", "schema": claude_schema}
            else:
                # 개수 제한까지 모델이 알 수 있게 원래 형식을 보여 준다.
                content = f"{user_prompt}{PROMPTED_JSON_INSTRUCTION}{json.dumps(json_schema, ensure_ascii=False)}"
            request: dict[str, Any] = {
                "model": self.config.model,
                "max_tokens": max(int(max_output_tokens), self.min_max_tokens),
                "system": system_prompt,
                "messages": [{"role": "user", "content": content}],
                "output_config": output_config,
            }
            if self.config.fallbacks_enabled:
                request["betas"] = [self.fallback_beta]
                request["fallbacks"] = "default"
            if current_speed == "fast":
                request["speed"] = "fast"
            return request

        last_error: dict[str, str] | None = None
        retry_errors: list[dict[str, str]] = []
        attempt_elapsed_ms: list[int] = []
        attempt_count = 0
        retries_used = 0
        while True:
            attempt_count += 1
            started = time.monotonic()
            response = None
            error: dict[str, str] | None = None
            try:
                response = create(**build_request(mode, speed))
            except sdk.APITimeoutError as exc:
                error = self._error("ANTHROPIC_TIMEOUT", exc)
            except sdk.RateLimitError as exc:
                error = self._error("ANTHROPIC_RATE_LIMITED", exc)
            except (sdk.AuthenticationError, sdk.PermissionDeniedError) as exc:
                error = self._error("ANTHROPIC_AUTH_FAILED", exc)
            except sdk.APIStatusError as exc:
                status_code = int(getattr(exc, "status_code", 0) or 0)
                error = self._error("ANTHROPIC_SERVER_ERROR" if status_code >= 500 else "ANTHROPIC_BAD_REQUEST", exc)
                if mode == "strict" and status_code == 400 and GRAMMAR_TOO_LARGE_MARKER in error["message"].lower():
                    error["code"] = "ANTHROPIC_GRAMMAR_TOO_LARGE"
            except sdk.APIConnectionError as exc:
                error = self._error("ANTHROPIC_SERVER_ERROR", exc)
            except Exception as exc:
                # 패키지가 모르는 인자(TypeError), 응답 형식 오류 같은 예상 밖의 예외. 다시 불러도 같으므로 재시도하지 않는다.
                error = self._error("ANTHROPIC_UNEXPECTED_ERROR", exc, with_type=True)
            finally:
                attempt_elapsed_ms.append(int((time.monotonic() - started) * 1000))

            if error is None:
                # 내용을 읽기 전에 멈춘 이유부터 본다. 거절과 잘림은 다시 불러도 같으므로 재시도하지 않는다.
                stop_reason = getattr(response, "stop_reason", None)
                if stop_reason == "refusal":
                    details = getattr(response, "stop_details", None)
                    category = getattr(details, "category", None)
                    last_error = {
                        "code": "LLM_REFUSED",
                        "message": f"Model refused the request (category={category or 'unknown'}).",
                    }
                    break
                if stop_reason == "max_tokens":
                    last_error = {"code": "OUTPUT_TRUNCATED", "message": "Output hit max_tokens before the JSON was complete."}
                    break
                try:
                    output_json = self._parse_json(self._output_text(response))
                except ValueError as exc:
                    error = {"code": "OUTPUT_PARSE_FAILED", "message": str(exc)}
                else:
                    if mode == "prompted":
                        output_json = self._keep_schema_fields(output_json, json_schema)
                    return {
                        **self._base_result(call_type, temperature),
                        **self._retry_metadata(attempt_count, retry_errors, attempt_elapsed_ms),
                        "served_model": getattr(response, "model", None) or self.config.model,
                        "fallback_used": self._fallback_used(response),
                        "status": "completed",
                        "output_json": output_json,
                        "usage": self._usage(response),
                        "errors": [],
                        "schema_keywords_removed": schema_keywords_removed,
                        "structured_output_mode": mode,
                        "speed": speed or "standard",
                        "speed_fallback": speed_fallback,
                    }

            if error["code"] == "ANTHROPIC_RATE_LIMITED" and speed == "fast":
                # 빠른 모드는 요청 한도가 따로 있다. 보통 속도로 내려 바로 다시 부른다. 이 한 번은 재시도 횟수에 넣지 않는다.
                # 내려온 뒤에 또 한도에 걸리면 아래의 보통 재시도 규칙을 따른다.
                speed = None
                speed_fallback = True
                retry_errors.append(error)
                continue

            if error["code"] == "ANTHROPIC_GRAMMAR_TOO_LARGE":
                # 형식이 커서 고정 출력을 못 쓴다. 형식을 프롬프트에 적어 JSON으로 받는 방식으로 바꿔 바로 다시 부른다.
                # 일시적 오류가 아니므로 재시도 횟수에 넣지 않는다. 받은 JSON은 뒤의 검증기가 검사한다.
                self._grammar_too_large.add(schema_key)
                retry_errors.append(error)
                mode = "prompted"
                continue

            last_error = error
            if not (retries_used < self.config.max_api_retries and error["code"] in self.retryable_codes):
                break
            retries_used += 1
            retry_errors.append(error)
            self._sleep(1)

        return {
            **self._base_result(call_type, temperature),
            **self._retry_metadata(attempt_count, retry_errors, attempt_elapsed_ms),
            "served_model": None,
            "fallback_used": False,
            "status": "failed",
            "output_json": None,
            "usage": self._empty_usage(),
            "errors": [last_error or {"code": "ANTHROPIC_SERVER_ERROR", "message": "Claude request failed."}],
            "schema_keywords_removed": schema_keywords_removed,
            "structured_output_mode": mode,
            "speed": speed or "standard",
            "speed_fallback": speed_fallback,
        }

    @staticmethod
    def _keep_schema_fields(output_json: Any, json_schema: dict[str, Any]) -> Any:
        """형식을 프롬프트로만 알렸을 때, 형식에 없는 최상위 칸이 섞여 오면 버린다(저장되는 파일 모양을 지키려고)."""

        properties = json_schema.get("properties") if isinstance(json_schema, dict) else None
        if not isinstance(output_json, dict) or not isinstance(properties, dict):
            return output_json
        return {key: value for key, value in output_json.items() if key in properties}

    def _import_sdk(self) -> Any:
        import anthropic  # 이 호출부에서만 불러온다

        return anthropic

    def _load_sdk(self) -> Any:
        if self._sdk is None:
            self._sdk = self._import_sdk()
        return self._sdk

    def _get_client(self, sdk: Any) -> Any:
        """재시도와 시도별 시간 기록을 직접 하므로 패키지의 자동 재시도는 끈다."""

        if self._client is None:
            self._client = sdk.Anthropic(
                api_key=local_env_value(self.config.api_key_env),
                timeout=float(self.config.timeout_seconds),
                max_retries=0,
            )
        return self._client

    def _base_result(self, call_type: str, temperature: float) -> dict[str, Any]:
        return {
            "schema_version": "llm_call_result.v1",
            "provider": self.config.provider,
            "api": self.config.api,
            "model": self.config.model,
            "call_type": call_type,
            "reasoning_effort": self.config.reasoning_effort,
            **self._temperature_metadata(temperature, applied=False, omitted_reason="unsupported_by_model"),
        }

    def _closed_result(self, call_type: str, temperature: float, *, status: str, error: dict[str, str]) -> dict[str, Any]:
        """API를 부르지 않고 끝난 경우(key 없음, 패키지 없음)의 표준 결과."""

        return {
            **self._base_result(call_type, temperature),
            **self._retry_metadata(1, []),
            "served_model": None,
            "fallback_used": False,
            "status": status,
            "output_json": None,
            "usage": self._empty_usage(),
            "errors": [error],
            "schema_keywords_removed": [],
            "structured_output_mode": None,
            "speed": self.config.speed or "standard",
            "speed_fallback": False,
        }

    def _error(self, code: str, exc: Exception, *, with_type: bool = False) -> dict[str, str]:
        """예외 메시지를 꺼내 길이를 제한한다. 혹시 key 값이 들어 있으면 가린다."""

        message = str(getattr(exc, "message", None) or str(exc) or type(exc).__name__)
        if with_type:
            message = f"{type(exc).__name__}: {message}"
        key = local_env_value(self.config.api_key_env)
        if key and key in message:
            message = message.replace(key, "***")
        return {"code": code, "message": message[:500]}

    def _output_text(self, response: Any) -> str:
        """응답의 첫 text 블록을 꺼낸다(앞에 thinking 블록이 올 수 있다)."""

        for block in getattr(response, "content", None) or []:
            if getattr(block, "type", None) == "text" and isinstance(getattr(block, "text", None), str):
                return block.text
        raise ValueError("response did not contain a text block")

    def _usage(self, response: Any) -> dict[str, int]:
        """추론에 쓴 토큰은 output_tokens에 들어 있고 따로 나오지 않는다."""

        usage = getattr(response, "usage", None)
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": 0,
            "total_tokens": input_tokens + output_tokens,
        }

    def _fallback_used(self, response: Any) -> bool:
        """거절 뒤 다른 모델이 이어받았는지. usage.iterations의 fallback_message 항목으로 판단한다."""

        iterations = getattr(getattr(response, "usage", None), "iterations", None) or []
        return any(getattr(entry, "type", None) == "fallback_message" for entry in iterations)


def create_runtime(config: RuntimeConfig | None = None) -> Any:
    """설정의 제공자에 맞는 호출부를 만든다."""

    config = config or RuntimeConfig()
    if config.provider == "anthropic":
        return AnthropicMessagesRuntime(config)
    return OpenAIResponsesRuntime(config)
