# Claude가 "형식이 너무 크다"며 고정 출력을 거절할 때, 형식을 프롬프트에 적어 JSON으로 받는 대체 경로를 확인한다.
# (실제 호출에서 미션 형식이 이 한도에 걸렸다. 설계서 형식은 고정 출력으로 통과한다.)

from __future__ import annotations

import json
import unittest

from envutil import isolated_env
from test_llm_runtime import FAKE_SDK, SCHEMA, FakeAPIStatusError, FakeClient, response

from src.mission_generation.config import RuntimeConfig
from src.mission_generation.llm_runtime import AnthropicMessagesRuntime

TOO_LARGE = "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."


class PromptedJsonFallbackTest(unittest.TestCase):
    def setUp(self):
        self.env = isolated_env(ANTHROPIC_API_KEY="test-key-not-real")
        self.env.__enter__()
        self.addCleanup(self.env.__exit__, None, None, None)

    def runtime(self, client: FakeClient) -> AnthropicMessagesRuntime:
        runtime = AnthropicMessagesRuntime(config=RuntimeConfig(), client=client, sdk=FAKE_SDK)
        runtime._sleep = lambda seconds: None
        return runtime

    @staticmethod
    def call(runtime: AnthropicMessagesRuntime, schema=SCHEMA) -> dict:
        return runtime.call_structured(
            call_type="draft_generation", system_prompt="system text", user_prompt="user text", json_schema=schema, temperature=0.8, max_output_tokens=12000
        )

    def test_strict_success_reports_strict_mode(self):
        result = self.call(self.runtime(FakeClient(response())))
        self.assertEqual(result["structured_output_mode"], "strict")

    def test_grammar_too_large_falls_back_to_prompted_json(self):
        client = FakeClient(FakeAPIStatusError(400, TOO_LARGE), response(text='```json\n{"a": 1}\n```'))
        result = self.call(self.runtime(client))
        self.assertEqual((result["status"], result["output_json"]), ("completed", {"a": 1}))
        self.assertEqual(result["structured_output_mode"], "prompted")
        self.assertEqual(result["retry_errors"][0]["code"], "ANTHROPIC_GRAMMAR_TOO_LARGE")
        self.assertEqual((result["attempt_count"], len(result["attempt_elapsed_ms"])), (2, 2))
        strict_kw, prompted_kw = client.calls[0][1], client.calls[1][1]
        self.assertIn("format", strict_kw["output_config"])
        self.assertEqual(prompted_kw["output_config"], {"effort": "medium"})
        content = prompted_kw["messages"][0]["content"]
        self.assertTrue(content.startswith("user text"))
        self.assertIn("Return exactly one JSON object", content)
        self.assertIn(json.dumps(SCHEMA, ensure_ascii=False), content)
        self.assertEqual(prompted_kw["system"], "system text")
        self.assertEqual((prompted_kw["betas"], prompted_kw["fallbacks"]), (strict_kw["betas"], strict_kw["fallbacks"]))

    def test_fallback_does_not_use_up_the_retry_budget(self):
        # 형식 거절 뒤의 대체 호출이 시간 초과되면 설정된 횟수(1번)만큼 더 시도한다.
        client = FakeClient(FakeAPIStatusError(400, TOO_LARGE), FAKE_SDK.APITimeoutError("t"), response(text='{"a": 1}'))
        result = self.call(self.runtime(client))
        self.assertEqual((result["status"], result["structured_output_mode"], len(client.calls)), ("completed", "prompted", 3))

    def test_same_schema_skips_the_strict_attempt_next_time(self):
        client = FakeClient(FakeAPIStatusError(400, TOO_LARGE), response(text='{"a": 1}'), response(text='{"a": 2}'))
        runtime = self.runtime(client)
        self.call(runtime)
        second = self.call(runtime)
        self.assertEqual((second["output_json"], second["structured_output_mode"], second["attempt_count"]), ({"a": 2}, "prompted", 1))
        self.assertEqual(len(client.calls), 3)
        self.assertNotIn("format", client.calls[2][1]["output_config"])

    def test_other_bad_requests_do_not_fall_back(self):
        client = FakeClient(FakeAPIStatusError(400, "output_config.format.schema: unsupported keyword"))
        result = self.call(self.runtime(client))
        self.assertEqual((result["status"], result["errors"][0]["code"], len(client.calls)), ("failed", "ANTHROPIC_BAD_REQUEST", 1))
        self.assertEqual(result["structured_output_mode"], "strict")

    def test_prompted_output_keeps_only_the_schema_top_level_fields(self):
        client = FakeClient(FakeAPIStatusError(400, TOO_LARGE), response(text='설명입니다.\n{"a": 1, "note": "extra"}'))
        result = self.call(self.runtime(client))
        self.assertEqual(result["output_json"], {"a": 1})

    def test_prompted_output_that_is_not_json_is_retried(self):
        client = FakeClient(FakeAPIStatusError(400, TOO_LARGE), response(text="JSON을 만들 수 없습니다"), response(text='{"a": 3}'))
        result = self.call(self.runtime(client))
        self.assertEqual((result["status"], result["output_json"]), ("completed", {"a": 3}))
        self.assertIn("OUTPUT_PARSE_FAILED", [e["code"] for e in result["retry_errors"]])

    def test_prompt_shows_the_original_schema_not_the_sanitized_one(self):
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["columns"],
            "properties": {"columns": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "string"}}},
        }
        client = FakeClient(FakeAPIStatusError(400, TOO_LARGE), response(text='{"columns": ["a", "b", "c", "d"]}'))
        self.call(self.runtime(client), schema=schema)
        self.assertNotIn("minItems", json.dumps(client.calls[0][1]["output_config"]["format"]["schema"]))
        self.assertIn('"minItems": 4', client.calls[1][1]["messages"][0]["content"])  # 개수 제한을 모델이 알 수 있게 원래 형식을 보여 준다


class BasisShowsOutputModeTest(unittest.TestCase):
    """근거 기록과 카드는 각 호출이 고정 출력이었는지, 형식을 프롬프트로만 알렸는지 밝힌다."""

    def test_basis_and_card_show_how_each_call_was_constrained(self):
        import tempfile
        from pathlib import Path

        from basis_fixtures import sample_mission
        from test_review_fixes_basis import REAL_CALL, assemble

        from src.mission_generation.basis_card_exporter import BasisCardExporter

        with tempfile.TemporaryDirectory() as folder:
            basis = assemble(
                Path(folder),
                blueprint_call={**REAL_CALL, "structured_output_mode": "strict"},
                writer_call={**REAL_CALL, "structured_output_mode": "prompted"},
            )
        self.assertEqual(basis["models"]["blueprint"]["structured_output"], "strict")
        self.assertEqual(basis["models"]["writer"]["structured_output"], "prompted")
        footer = BasisCardExporter().render_card(sample_mission(), basis).split("<footer>")[1]
        self.assertIn("설계 모델 claude-opus-5-5 · 추론 강도 medium · JSON 고정 출력", footer)
        self.assertIn("작성 모델 claude-opus-5-5 · 추론 강도 medium · 형식을 프롬프트로 지정(코드가 검증)", footer)


if __name__ == "__main__":
    unittest.main()
