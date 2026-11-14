# 생성기·선택기·수정기가 설정된 제공자의 호출부를 쓰는지 확인한다.

from __future__ import annotations

import unittest

from envutil import isolated_env

from src.mission_generation.decision_selector import MissionDecisionSelector
from src.mission_generation.draft_generator import MissionDraftGenerator
from src.mission_generation.llm_runtime import AnthropicMessagesRuntime, OpenAIResponsesRuntime
from src.mission_generation.pilot_runner import PilotRunner
from src.mission_generation.repair_manager import RepairManager


class RuntimeWiringTest(unittest.TestCase):
    def test_generators_use_provider_runtime(self):
        with isolated_env():
            for cls in (MissionDraftGenerator, MissionDecisionSelector, RepairManager):
                self.assertIsInstance(cls().runtime, AnthropicMessagesRuntime, cls.__name__)
        with isolated_env(MISSION_LLM_PROVIDER="openai"):
            for cls in (MissionDraftGenerator, MissionDecisionSelector, RepairManager):
                self.assertIsInstance(cls().runtime, OpenAIResponsesRuntime, cls.__name__)

    def test_selector_missing_key_code_follows_provider(self):
        with isolated_env():
            error = MissionDecisionSelector().select({})["llm_call_result"]["errors"][0]
            self.assertEqual(error, {"code": "LLM_API_KEY_MISSING", "message": "ANTHROPIC_API_KEY is not set."})
        with isolated_env(MISSION_LLM_PROVIDER="openai"):
            error = MissionDecisionSelector().select({})["llm_call_result"]["errors"][0]
            self.assertEqual(error, {"code": "OPENAI_API_KEY_MISSING", "message": "OPENAI_API_KEY is not set."})

    def test_runner_treats_both_missing_key_codes_as_local_skip(self):
        for code in ("LLM_API_KEY_MISSING", "OPENAI_API_KEY_MISSING", "DECISION_SELECTOR_MOCK_MODE"):
            call_result = {"provider": "local", "status": "skipped", "errors": [{"code": code}]}
            self.assertTrue(PilotRunner._selector_was_locally_skipped(None, call_result), code)
        failed = {"provider": "local", "status": "skipped", "errors": [{"code": "SOMETHING_ELSE"}]}
        self.assertFalse(PilotRunner._selector_was_locally_skipped(None, failed))


if __name__ == "__main__":
    unittest.main()
