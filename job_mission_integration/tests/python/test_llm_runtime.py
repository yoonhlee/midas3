# 제공자 설정과 Claude 호출부(AnthropicMessagesRuntime)를 API 없이 확인한다.

from __future__ import annotations

import unittest
from types import SimpleNamespace

from envutil import isolated_env

from src.mission_generation.config import RuntimeConfig, llm_provider, local_env_value
from src.mission_generation.llm_runtime import AnthropicMessagesRuntime, OpenAIResponsesRuntime, create_runtime
from src.mission_generation.preflight import check_generation_ready

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["a"], "properties": {"a": {"type": "integer"}}}


class FakeAPIConnectionError(Exception):
    pass


class FakeAPITimeoutError(FakeAPIConnectionError):
    pass


class FakeAPIStatusError(Exception):
    def __init__(self, status_code: int, message: str = "error") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class FakeRateLimitError(FakeAPIStatusError):
    pass


class FakeAuthenticationError(FakeAPIStatusError):
    pass


class FakePermissionDeniedError(FakeAPIStatusError):
    pass


FAKE_SDK = SimpleNamespace(
    APIConnectionError=FakeAPIConnectionError,
    APITimeoutError=FakeAPITimeoutError,
    APIStatusError=FakeAPIStatusError,
    RateLimitError=FakeRateLimitError,
    AuthenticationError=FakeAuthenticationError,
    PermissionDeniedError=FakePermissionDeniedError,
)


class FakeMessages:
    def __init__(self, path: str, outcomes: list, calls: list) -> None:
        self.path, self.outcomes, self.calls = path, outcomes, calls

    def create(self, **kwargs):
        self.calls.append((self.path, kwargs))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeClient:
    """beta.messages.create와 messages.create 호출을 기록하고 준비된 결과를 차례로 준다."""

    def __init__(self, *outcomes) -> None:
        self.calls: list = []
        pending = list(outcomes)
        self.messages = FakeMessages("plain", pending, self.calls)
        self.beta = SimpleNamespace(messages=FakeMessages("beta", pending, self.calls))


def response(text: str = '{"a": 1}', stop_reason: str = "end_turn", model: str = "claude-opus-5-5", iterations=None):
    content = [SimpleNamespace(type="thinking", thinking="")]
    if text is not None:
        content.append(SimpleNamespace(type="text", text=text))
    usage = SimpleNamespace(input_tokens=10, output_tokens=5, iterations=iterations)
    return SimpleNamespace(content=content, stop_reason=stop_reason, model=model, usage=usage)


class LocalEnvValueTest(unittest.TestCase):
    def test_reads_crlf_and_quoted_values_from_dotenv(self):
        with isolated_env(dotenv=b'# comment\r\nA_KEY="abc"\r\nB_KEY = xyz \r\n') as folder:
            self.assertEqual(local_env_value("A_KEY", base_dir=folder), "abc")
            self.assertEqual(local_env_value("B_KEY", base_dir=folder), "xyz")
            self.assertEqual(local_env_value("A_KEY"), "abc")  # base_dir 기본값은 현재 작업 폴더

    def test_order_is_environ_then_env_local_then_env(self):
        with isolated_env(dotenv=b"A_KEY=from_env\n", dotenv_local=b"A_KEY=from_local\n", A_KEY="from_environ"):
            self.assertEqual(local_env_value("A_KEY"), "from_environ")
        with isolated_env(dotenv=b"A_KEY=from_env\n", dotenv_local=b"A_KEY=from_local\n"):
            self.assertEqual(local_env_value("A_KEY"), "from_local")
        with isolated_env(dotenv=b"A_KEY=from_env\n"):
            self.assertEqual(local_env_value("A_KEY"), "from_env")

    def test_empty_value_is_none(self):
        with isolated_env(dotenv=b"A_KEY=\r\n", B_KEY="  "):
            self.assertIsNone(local_env_value("A_KEY"))
            self.assertIsNone(local_env_value("B_KEY"))
            self.assertIsNone(local_env_value("MISSING_KEY"))


class ProviderConfigTest(unittest.TestCase):
    def test_default_provider_is_anthropic_with_opus(self):
        with isolated_env():
            cfg = RuntimeConfig()
            self.assertEqual(llm_provider(), "anthropic")
            self.assertEqual(
                (cfg.provider, cfg.api, cfg.model, cfg.reasoning_effort, cfg.api_key_env),
                ("anthropic", "messages", "claude-opus-5-5", "medium", "ANTHROPIC_API_KEY"),
            )
            self.assertTrue(cfg.fallbacks_enabled)
            application = cfg.temperature_application()
            self.assertFalse(application["temperature_applied"])
            self.assertEqual(application["temperature_omitted_reason"], "unsupported_by_model")

    def test_openai_provider_keeps_old_defaults(self):
        with isolated_env(MISSION_LLM_PROVIDER="openai"):
            cfg = RuntimeConfig()
            self.assertEqual(
                (cfg.provider, cfg.api, cfg.model, cfg.reasoning_effort, cfg.api_key_env),
                ("openai", "responses", "gpt-5.4-nano", "medium", "OPENAI_API_KEY"),
            )
            self.assertFalse(cfg.fallbacks_enabled)
            self.assertTrue(cfg.temperature_application()["temperature_applied"])

    def test_anthropic_settings_are_read_from_dotenv(self):
        dotenv = b"ANTHROPIC_GENERATION_MODEL=claude-sonnet-5-5\r\nANTHROPIC_GENERATION_EFFORT=high\r\nANTHROPIC_GENERATION_FALLBACKS=false\r\n"
        with isolated_env(dotenv=dotenv):
            cfg = RuntimeConfig()
            self.assertEqual((cfg.model, cfg.reasoning_effort, cfg.fallbacks_enabled), ("claude-sonnet-5-5", "high", False))

    def test_invalid_provider_raises(self):
        with isolated_env(MISSION_LLM_PROVIDER="gemini"):
            with self.assertRaisesRegex(ValueError, "MISSION_LLM_PROVIDER"):
                RuntimeConfig()


class AnthropicRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.env = isolated_env(ANTHROPIC_API_KEY="test-key-not-real")
        self.env.__enter__()
        self.addCleanup(self.env.__exit__, None, None, None)

    def call(self, client: FakeClient, **overrides) -> dict:
        runtime = AnthropicMessagesRuntime(config=RuntimeConfig(), client=client, sdk=FAKE_SDK)
        runtime._sleep = lambda seconds: None  # 재시도 사이 대기를 건너뛴다
        params = dict(
            call_type="draft_generation",
            system_prompt="system text",
            user_prompt="user text",
            json_schema=SCHEMA,
            temperature=0.8,
            max_output_tokens=12000,
        )
        params.update(overrides)
        return runtime.call_structured(**params)

    def test_success_maps_result_and_request(self):
        client = FakeClient(response())
        result = self.call(client)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output_json"], {"a": 1})
        self.assertEqual(result["usage"], {"input_tokens": 10, "output_tokens": 5, "reasoning_tokens": 0, "total_tokens": 15})
        self.assertEqual((result["provider"], result["api"], result["model"]), ("anthropic", "messages", "claude-opus-5-5"))
        self.assertEqual((result["served_model"], result["fallback_used"]), ("claude-opus-5-5", False))
        self.assertEqual((result["call_type"], result["reasoning_effort"]), ("draft_generation", "medium"))
        self.assertFalse(result["temperature_applied"])
        self.assertEqual((result["attempt_count"], len(result["attempt_elapsed_ms"]), result["errors"]), (1, 1, []))
        path, kw = client.calls[0]
        self.assertEqual(path, "beta")
        self.assertEqual((kw["model"], kw["max_tokens"], kw["system"]), ("claude-opus-5-5", 16000, "system text"))
        self.assertEqual(kw["messages"], [{"role": "user", "content": "user text"}])
        self.assertEqual(kw["output_config"], {"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}})
        self.assertEqual((kw["betas"], kw["fallbacks"]), (["server-side-fallback-2026-07-01"], "default"))
        self.assertNotIn("temperature", kw)
        self.assertNotIn("thinking", kw)

    def test_larger_max_output_tokens_is_kept(self):
        client = FakeClient(response())
        self.call(client, max_output_tokens=20000)
        self.assertEqual(client.calls[0][1]["max_tokens"], 20000)

    def test_fallbacks_disabled_uses_plain_call(self):
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real", ANTHROPIC_GENERATION_FALLBACKS="false"):
            client = FakeClient(response())
            result = self.call(client)
        path, kw = client.calls[0]
        self.assertEqual((path, result["status"]), ("plain", "completed"))
        self.assertNotIn("betas", kw)
        self.assertNotIn("fallbacks", kw)

    def test_fallback_served_model_recorded(self):
        iterations = [SimpleNamespace(type="message"), SimpleNamespace(type="fallback_message")]
        result = self.call(FakeClient(response(model="claude-opus-4-8", iterations=iterations)))
        self.assertEqual((result["model"], result["served_model"], result["fallback_used"]), ("claude-opus-5-5", "claude-opus-4-8", True))

    def test_refusal_is_failure_without_retry(self):
        client = FakeClient(response(text=None, stop_reason="refusal"))
        result = self.call(client)
        self.assertEqual((result["status"], result["output_json"], result["errors"][0]["code"]), ("failed", None, "LLM_REFUSED"))
        self.assertEqual(len(client.calls), 1)

    def test_max_tokens_is_failure(self):
        client = FakeClient(response(text='{"a": ', stop_reason="max_tokens"))
        result = self.call(client)
        self.assertEqual((result["status"], result["errors"][0]["code"]), ("failed", "OUTPUT_TRUNCATED"))
        self.assertEqual(len(client.calls), 1)

    def test_timeout_then_success_retries_and_records_attempts(self):
        client = FakeClient(FakeAPITimeoutError("timed out"), response())
        result = self.call(client)
        self.assertEqual((result["status"], result["attempt_count"], result["retry_count"]), ("completed", 2, 1))
        self.assertEqual(len(result["attempt_elapsed_ms"]), 2)
        self.assertEqual(result["retry_errors"][0]["code"], "ANTHROPIC_TIMEOUT")

    def test_rate_limit_and_server_error_are_retryable(self):
        cases = [
            (FakeRateLimitError(429), "ANTHROPIC_RATE_LIMITED"),
            (FakeAPIStatusError(503), "ANTHROPIC_SERVER_ERROR"),
            (FakeAPIConnectionError("reset"), "ANTHROPIC_SERVER_ERROR"),
        ]
        for error, code in cases:
            with self.subTest(code=code, error=type(error).__name__):
                result = self.call(FakeClient(error, response()))
                self.assertEqual((result["status"], result["retry_errors"][0]["code"]), ("completed", code))

    def test_retry_limit_ends_in_failure(self):
        client = FakeClient(FakeAPITimeoutError("t"), FakeAPITimeoutError("t"))
        result = self.call(client)
        self.assertEqual((result["status"], result["errors"][0]["code"], len(client.calls)), ("failed", "ANTHROPIC_TIMEOUT", 2))

    def test_auth_and_bad_request_do_not_retry(self):
        cases = [
            (FakeAuthenticationError(401), "ANTHROPIC_AUTH_FAILED"),
            (FakePermissionDeniedError(403), "ANTHROPIC_AUTH_FAILED"),
            (FakeAPIStatusError(400, "output_config.format: unsupported keyword"), "ANTHROPIC_BAD_REQUEST"),
        ]
        for error, code in cases:
            with self.subTest(code=code, error=type(error).__name__):
                client = FakeClient(error)
                result = self.call(client)
                self.assertEqual((result["status"], result["errors"][0]["code"], len(client.calls)), ("failed", code, 1))
        self.assertIn("unsupported keyword", result["errors"][0]["message"])

    def test_unparseable_output_is_retried(self):
        result = self.call(FakeClient(response(text="not json"), response()))
        self.assertEqual((result["status"], result["retry_errors"][0]["code"]), ("completed", "OUTPUT_PARSE_FAILED"))

    def test_missing_key_is_skipped(self):
        with isolated_env():
            client = FakeClient(response())
            result = self.call(client)
        self.assertEqual((result["status"], result["errors"][0]["code"]), ("skipped", "LLM_API_KEY_MISSING"))
        self.assertEqual(client.calls, [])

    def test_missing_sdk_package_is_reported(self):
        class NoSdkRuntime(AnthropicMessagesRuntime):
            def _import_sdk(self):
                raise ImportError("No module named 'anthropic'")

        client = FakeClient(response())
        result = NoSdkRuntime(config=RuntimeConfig(), client=client).call_structured(
            call_type="draft_generation", system_prompt="s", user_prompt="u", json_schema=SCHEMA, temperature=0.8, max_output_tokens=100
        )
        self.assertEqual((result["status"], result["errors"][0]["code"]), ("failed", "ANTHROPIC_SDK_MISSING"))
        self.assertEqual(client.calls, [])

    def test_key_is_read_from_dotenv(self):
        with isolated_env(dotenv=b'ANTHROPIC_API_KEY="from-dotenv-not-real"\r\n'):
            runtime = AnthropicMessagesRuntime(config=RuntimeConfig(), client=FakeClient(), sdk=FAKE_SDK)
            self.assertTrue(runtime.api_key_available())


class AnthropicSpeedTest(unittest.TestCase):
    """빠른 모드 설정(ANTHROPIC_GENERATION_SPEED). 요청 한도에 걸리면 보통 속도로 한 번 내려온다."""

    @staticmethod
    def call(client: FakeClient, **env: str) -> dict:
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real", **env):
            runtime = AnthropicMessagesRuntime(config=RuntimeConfig(), client=client, sdk=FAKE_SDK)
            runtime._sleep = lambda seconds: None
            return runtime.call_structured(
                call_type="draft_generation", system_prompt="s", user_prompt="u", json_schema=SCHEMA, temperature=0.8, max_output_tokens=12000
            )

    def test_speed_is_not_sent_by_default(self):
        client = FakeClient(response())
        result = self.call(client)
        _path, request = client.calls[0]
        self.assertNotIn("speed", request)
        self.assertEqual((result["speed"], result["speed_fallback"]), ("standard", False))

    def test_fast_setting_is_sent_and_recorded(self):
        client = FakeClient(response())
        result = self.call(client, ANTHROPIC_GENERATION_SPEED="fast")
        _path, request = client.calls[0]
        self.assertEqual(request["speed"], "fast")
        self.assertEqual((result["speed"], result["speed_fallback"]), ("fast", False))
        # 다른 인자는 그대로다.
        self.assertEqual((request["model"], request["fallbacks"], request["output_config"]["effort"]), ("claude-opus-5-5", "default", "medium"))
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real", ANTHROPIC_GENERATION_SPEED="fast"):
            config = RuntimeConfig(provider="anthropic")
            self.assertEqual((config.speed, config.as_manifest()["speed"], config.as_full_config()["speed"]), ("fast", "fast", "fast"))
            ready = check_generation_ready(sdk=FAKE_SDK, client=SimpleNamespace(models=SimpleNamespace(retrieve=lambda model_id: None)))
            self.assertEqual((ready["ok"], ready["speed"]), (True, "fast"))
        with isolated_env():
            config = RuntimeConfig(provider="anthropic")
            self.assertEqual((config.speed, config.as_manifest()["speed"], config.as_full_config()["speed"]), (None, "standard", "standard"))

    def test_rate_limit_on_fast_drops_to_standard_once(self):
        client = FakeClient(FakeRateLimitError(429), response())
        result = self.call(client, ANTHROPIC_GENERATION_SPEED="fast")
        self.assertEqual(["speed" in kwargs for _path, kwargs in client.calls], [True, False])
        self.assertEqual((result["status"], result["speed"], result["speed_fallback"]), ("completed", "standard", True))
        self.assertEqual((result["attempt_count"], result["retry_errors"][0]["code"]), (2, "ANTHROPIC_RATE_LIMITED"))

    def test_rate_limits_after_the_drop_follow_the_normal_retry_rule(self):
        # 재시도는 한 번(max_api_retries=1): 빠른 1 + 보통 1 + 재시도 1에서 끝난다. 끝없이 돌지 않는다.
        client = FakeClient(FakeRateLimitError(429), FakeRateLimitError(429), FakeRateLimitError(429), response())
        result = self.call(client, ANTHROPIC_GENERATION_SPEED="fast")
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(["speed" in kwargs for _path, kwargs in client.calls], [True, False, False])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["errors"][0]["code"], "ANTHROPIC_RATE_LIMITED")
        self.assertEqual((result["speed"], result["speed_fallback"]), ("standard", True))

    def test_unknown_speed_value_raises(self):
        with isolated_env(ANTHROPIC_GENERATION_SPEED="turbo"):
            with self.assertRaisesRegex(ValueError, "ANTHROPIC_GENERATION_SPEED must be fast or empty, got 'turbo'"):
                RuntimeConfig(provider="anthropic")

    def test_openai_config_has_no_speed(self):
        with isolated_env(ANTHROPIC_GENERATION_SPEED="fast"):
            self.assertIsNone(RuntimeConfig(provider="openai").speed)


class CreateRuntimeTest(unittest.TestCase):
    def test_create_runtime_follows_provider(self):
        with isolated_env():
            self.assertIsInstance(create_runtime(), AnthropicMessagesRuntime)
        with isolated_env(MISSION_LLM_PROVIDER="openai"):
            self.assertIsInstance(create_runtime(), OpenAIResponsesRuntime)


if __name__ == "__main__":
    unittest.main()
