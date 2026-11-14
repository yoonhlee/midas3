# 최종 검토에서 나온 호출부 문제의 재현 테스트:
# 다른 제공자의 key가 섞이지 않는지, Claude가 받지 않는 형식 키워드를 빼는지, 예상 못 한 예외에도 결과를 돌려주는지.

from __future__ import annotations

import copy
import importlib.util
import unittest
from types import SimpleNamespace

from basis_fixtures import PROJECT_ROOT
from envutil import isolated_env
from test_llm_runtime import FAKE_SDK, SCHEMA, FakeClient, response

from src.mission_generation.config import RuntimeConfig, local_env_value
from src.mission_generation.llm_runtime import (
    AnthropicMessagesRuntime,
    OpenAIResponsesRuntime,
    sanitize_schema_for_claude,
)
from src.mission_generation.schema_constraints_builder import SchemaConstraintsBuilder

UNSUPPORTED = {
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


def schema_keywords(node):
    """형식에서 키워드 자리에 있는 키만 모은다(properties 아래의 이름은 속성 이름이라 뺀다)."""

    found = set()
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            if key in ("properties", "$defs", "definitions") and isinstance(value, dict):
                for sub in value.values():
                    found |= schema_keywords(sub)
            else:
                found |= schema_keywords(value)
    elif isinstance(node, list):
        for value in node:
            found |= schema_keywords(value)
    return found


class ProviderConsistencyTest(unittest.TestCase):
    def test_explicit_provider_sets_its_own_dependent_fields(self):
        with isolated_env():  # 기본 제공자는 anthropic
            cfg = RuntimeConfig(provider="openai")
            self.assertEqual(
                (cfg.api, cfg.model, cfg.reasoning_effort, cfg.api_key_env, cfg.fallbacks_enabled),
                ("responses", "gpt-5.4-nano", "medium", "OPENAI_API_KEY", False),
            )
            self.assertTrue(cfg.temperature_application()["temperature_applied"])
        with isolated_env(MISSION_LLM_PROVIDER="openai"):
            cfg = RuntimeConfig(provider="anthropic")
            self.assertEqual(
                (cfg.api, cfg.model, cfg.api_key_env, cfg.fallbacks_enabled),
                ("messages", "claude-opus-5-5", "ANTHROPIC_API_KEY", True),
            )

    def test_explicit_values_are_kept(self):
        with isolated_env():
            cfg = RuntimeConfig(model="claude-haiku-5-5", reasoning_effort="low", fallbacks_enabled=False)
            self.assertEqual((cfg.model, cfg.reasoning_effort, cfg.fallbacks_enabled), ("claude-haiku-5-5", "low", False))

    def test_unknown_provider_is_rejected(self):
        with isolated_env():
            with self.assertRaisesRegex(ValueError, "anthropic or openai"):
                RuntimeConfig(provider="gemini")

    def test_runtimes_reject_a_config_of_the_other_provider(self):
        with isolated_env(ANTHROPIC_API_KEY="anthropic-key-not-real", OPENAI_API_KEY="openai-key-not-real"):
            with self.assertRaisesRegex(ValueError, "openai"):
                OpenAIResponsesRuntime(RuntimeConfig(provider="anthropic"))
            with self.assertRaisesRegex(ValueError, "anthropic"):
                AnthropicMessagesRuntime(RuntimeConfig(provider="openai"))
            # 기본 제공자가 anthropic이어도 설정 없이 만든 OpenAI 호출부는 OpenAI 설정을 쓴다.
            with self.assertRaisesRegex(ValueError, "openai"):
                OpenAIResponsesRuntime(RuntimeConfig())

    def test_openai_runtime_never_picks_up_the_anthropic_key(self):
        with isolated_env(ANTHROPIC_API_KEY="anthropic-key-not-real"):
            runtime = OpenAIResponsesRuntime()
            self.assertEqual((runtime.config.provider, runtime.config.api_key_env), ("openai", "OPENAI_API_KEY"))
            self.assertFalse(runtime.api_key_available())


class DotenvEncodingTest(unittest.TestCase):
    """Windows PowerShell 5.1의 `>>`는 UTF-16으로 덧붙인다. 그런 .env에서도 실행이 죽지 않고 값을 읽어야 한다."""

    def test_line_appended_in_utf16_is_still_read(self):
        mixed = b"OTHER_KEY=first\r\n" + "A_KEY=abc\r\n".encode("utf-16-le")
        with isolated_env(dotenv=mixed):
            self.assertEqual(local_env_value("A_KEY"), "abc")
            self.assertEqual(local_env_value("OTHER_KEY"), "first")

    def test_whole_file_in_utf16_with_bom_is_read(self):
        with isolated_env(dotenv="A_KEY=abc\r\nMISSION_LLM_PROVIDER=openai\r\n".encode("utf-16")):
            self.assertEqual(local_env_value("A_KEY"), "abc")
            self.assertEqual(RuntimeConfig().provider, "openai")

    def test_unreadable_bytes_do_not_raise(self):
        with isolated_env(dotenv=b"\xff\xfe\x00\x01\x80\x81=\xfa\r\n"):
            self.assertIsNone(local_env_value("A_KEY"))
            self.assertEqual(RuntimeConfig().provider, "anthropic")


class ClaudeSchemaSanitizerTest(unittest.TestCase):
    RAW = {
        "type": "object",
        "additionalProperties": False,
        "required": ["columns", "maximum", "level"],
        "properties": {
            "columns": {"type": "array", "minItems": 4, "maxItems": 4, "uniqueItems": True, "items": {"type": "string", "maxLength": 20}},
            "maximum": {"type": "integer", "minimum": 0, "maximum": 10},  # 속성 이름이 키워드와 같다
            "level": {"enum": ["easy", "normal"]},
            "count": {"enum": [1, 2]},
        },
    }

    def test_unsupported_keywords_are_removed_but_property_names_stay(self):
        original = copy.deepcopy(self.RAW)
        clean, removed = sanitize_schema_for_claude(self.RAW)
        self.assertEqual(self.RAW, original)  # 받은 형식은 바꾸지 않는다
        self.assertEqual(removed, ["maxItems", "maxLength", "maximum", "minItems", "minimum", "uniqueItems"])
        self.assertEqual(clean["properties"]["columns"], {"type": "array", "items": {"type": "string"}})
        self.assertEqual(clean["properties"]["maximum"], {"type": "integer"})
        self.assertEqual(clean["required"], ["columns", "maximum", "level"])
        self.assertEqual(schema_keywords(clean) & UNSUPPORTED, set())

    def test_string_enum_without_type_gets_a_type(self):
        clean, _removed = sanitize_schema_for_claude(self.RAW)
        self.assertEqual(clean["properties"]["level"], {"enum": ["easy", "normal"], "type": "string"})
        self.assertEqual(clean["properties"]["count"], {"enum": [1, 2]})  # 문자열이 아니면 그대로 둔다

    def test_full_writer_schema_is_clean_after_sanitizing(self):
        constraints = SchemaConstraintsBuilder().build(evidence_names=["읽고 이해하기"], include_basis_map=True)
        writer_schema = constraints["structured_output_schema"]
        self.assertIn("minItems", schema_keywords(writer_schema))  # 형식 제약 파일과 GPT 요청은 그대로다
        clean, removed = sanitize_schema_for_claude(writer_schema)
        self.assertEqual(schema_keywords(clean) & UNSUPPORTED, set())
        self.assertEqual(removed, ["maxItems", "minItems"])
        self.assertEqual(set(clean["properties"]), set(writer_schema["properties"]))

    def test_request_sends_the_sanitized_schema_and_reports_what_was_removed(self):
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real"):
            client = FakeClient(response())
            runtime = AnthropicMessagesRuntime(config=RuntimeConfig(), client=client, sdk=FAKE_SDK)
            result = runtime.call_structured(
                call_type="draft_generation", system_prompt="s", user_prompt="u", json_schema=self.RAW, temperature=0.8, max_output_tokens=100
            )
        sent = client.calls[0][1]["output_config"]["format"]["schema"]
        self.assertEqual(schema_keywords(sent) & UNSUPPORTED, set())
        self.assertEqual(result["schema_keywords_removed"], ["maxItems", "maxLength", "maximum", "minItems", "minimum", "uniqueItems"])


class UnexpectedFailureTest(unittest.TestCase):
    def call(self, runtime) -> dict:
        runtime._sleep = lambda seconds: None
        return runtime.call_structured(
            call_type="blueprint_design", system_prompt="s", user_prompt="u", json_schema=SCHEMA, temperature=0.8, max_output_tokens=100
        )

    def test_unexpected_exception_becomes_a_failed_result_without_retry(self):
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real"):
            client = FakeClient(TypeError("create() got an unexpected keyword argument 'fallbacks'"), response())
            result = self.call(AnthropicMessagesRuntime(config=RuntimeConfig(), client=client, sdk=FAKE_SDK))
        self.assertEqual((result["status"], result["errors"][0]["code"], len(client.calls)), ("failed", "ANTHROPIC_UNEXPECTED_ERROR", 1))
        self.assertIn("TypeError", result["errors"][0]["message"])
        self.assertIn("fallbacks", result["errors"][0]["message"])
        self.assertEqual(result["schema_keywords_removed"], [])

    def test_client_construction_failure_becomes_a_failed_result(self):
        def broken_client(**kwargs):
            raise RuntimeError("could not build client")

        sdk = SimpleNamespace(**vars(FAKE_SDK), Anthropic=broken_client)
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real"):
            result = self.call(AnthropicMessagesRuntime(config=RuntimeConfig(), sdk=sdk))
        self.assertEqual((result["status"], result["errors"][0]["code"]), ("failed", "ANTHROPIC_CLIENT_FAILED"))
        self.assertIn("could not build client", result["errors"][0]["message"])

    def test_key_value_is_never_copied_into_an_error_message(self):
        with isolated_env(ANTHROPIC_API_KEY="test-key-not-real"):
            client = FakeClient(ValueError("bad header x-api-key: test-key-not-real"))
            result = self.call(AnthropicMessagesRuntime(config=RuntimeConfig(), client=client, sdk=FAKE_SDK))
        self.assertNotIn("test-key-not-real", result["errors"][0]["message"])
        self.assertIn("***", result["errors"][0]["message"])


if __name__ == "__main__":
    unittest.main()
