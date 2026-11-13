# 생성 시작 전 확인: Claude로 미션을 만들 준비가 됐는지 세 가지를 본다. 글을 만들지 않으므로 비용이 들지 않는다.
#
#   1) package: anthropic 패키지를 불러올 수 있는가
#   2) api_key: key가 있는가(셸 환경 변수 → .env.local → .env)
#   3) model:   설정한 모델을 조회할 수 있는가(models.retrieve)
#
# 앞에서부터 보고, 실패한 데서 멈춘다. 결과는 JSON 한 줄로 찍고 준비가 됐으면 종료 코드 0, 아니면 1이다.
# 설정 값이 틀려 설정을 만들 수 없으면 checks에 config 하나만 담아 같은 모양으로 알린다.
#
#   python -m src.mission_generation.preflight

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .config import RuntimeConfig, local_env_value

PREFLIGHT_SCHEMA = "generation_preflight.v1"
# 조회 한 번이면 끝나는 확인이라 오래 기다리지 않는다. 다시 부르지도 않는다.
PREFLIGHT_TIMEOUT_SECONDS = 15.0


def _import_sdk() -> Any:
    import anthropic  # 이 확인에서만 불러온다

    return anthropic


def _error_message(exc: Exception, key: str | None) -> str:
    """예외 글을 꺼내 길이를 제한한다. key 값이 들어 있으면 가린다."""

    message = str(getattr(exc, "message", None) or str(exc) or "")
    message = f"{type(exc).__name__}: {message}" if message else type(exc).__name__
    if key and key in message:
        message = message.replace(key, "***")
    return message[:500]


def check_generation_ready(config: RuntimeConfig | None = None, *, sdk: Any = None, client: Any = None) -> dict[str, Any]:
    """패키지 → key → 모델 순서로 확인한 결과를 돌려준다. sdk와 client는 테스트에서 가짜를 넣기 위한 자리다."""

    config = config or RuntimeConfig(provider="anthropic")
    if config.provider != "anthropic":
        # 다른 제공자의 설정을 받으면 그 제공자의 key가 Claude 쪽으로 나갈 수 있으므로 거절한다.
        raise ValueError(f"check_generation_ready needs an anthropic RuntimeConfig, got {config.provider!r}.")
    result: dict[str, Any] = {
        "schema_version": PREFLIGHT_SCHEMA,
        "ok": False,
        "provider": config.provider,
        "model": config.model,
        "reasoning_effort": config.reasoning_effort,
        "speed": config.speed or "standard",
        "checks": [],
    }

    def add(name: str, ok: bool, code: str | None = None, message: str = "") -> None:
        result["checks"].append({"name": name, "ok": ok, "code": code, "message": message})

    if sdk is None:
        try:
            sdk = _import_sdk()
        except ImportError:
            add("package", False, "ANTHROPIC_SDK_MISSING", "anthropic package is not installed. Run: python -m pip install -r requirements.txt")
            return result
    add("package", True)

    key = local_env_value(config.api_key_env)
    if not key:
        add("api_key", False, "LLM_API_KEY_MISSING", f"{config.api_key_env} is not set.")
        return result
    add("api_key", True)

    try:
        if client is None:
            client = sdk.Anthropic(api_key=key, timeout=PREFLIGHT_TIMEOUT_SECONDS, max_retries=0)
        client.models.retrieve(config.model)
    except (sdk.AuthenticationError, sdk.PermissionDeniedError) as exc:
        add("model", False, "ANTHROPIC_AUTH_FAILED", _error_message(exc, key))
        return result
    except sdk.NotFoundError as exc:
        add("model", False, "ANTHROPIC_MODEL_NOT_FOUND", _error_message(exc, key))
        return result
    except Exception as exc:  # 연결 실패, 시간 초과, 서버 오류, 패키지 버전 차이 등
        add("model", False, "ANTHROPIC_PREFLIGHT_FAILED", _error_message(exc, key))
        return result
    add("model", True)
    result["ok"] = True
    return result


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Claude로 미션을 만들 준비가 됐는지 확인한다(패키지, key, 모델). 글을 만들지 않는다.")
    parser.parse_args(argv)
    try:
        config = RuntimeConfig(provider="anthropic")
    except ValueError as exc:
        # 설정 값이 틀리면(예: 모르는 속도 값) 설정을 만들 수 없다. 이것도 같은 모양의 JSON 한 줄로 알린다.
        result = {
            "schema_version": PREFLIGHT_SCHEMA,
            "ok": False,
            "provider": "anthropic",
            "model": None,
            "reasoning_effort": None,
            "speed": None,
            "checks": [{"name": "config", "ok": False, "code": "GENERATION_CONFIG_INVALID", "message": str(exc)[:500]}],
        }
    else:
        result = check_generation_ready(config)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
