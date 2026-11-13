# 생성기가 여는 실행 옵션과 생성 규칙의 판을 못박아 둔다. 바뀌면 이 테스트를 함께 고쳐야 알 수 있게 하려는 것이다.

from __future__ import annotations

import inspect
import unittest

from src.mission_generation.blueprint_designer import BLUEPRINT_PROMPT_VERSION
from src.mission_generation.draft_generator import WRITER_PROMPT_VERSION
from src.mission_generation.pilot_runner import PilotRunner

RUNNER_OPTIONS = [
    "source_root",
    "output_root",
    "force_mock",
    "allow_mock_fallback",
    "concurrency",
    "target_job_codes",
    "target_difficulty_codes",
    "use_llm_decision_selector",
    "use_practice_sheet_background",
    "practice_sheet_root",
    "use_ncs_background",
    "ncs_root",
    "ncs_units",
    "ncs_trace",
    "ncs_ablation",
    "two_stage_basis",
    "progress_enabled",
    "ncs_targets",
]


class GeneratorSurfaceTest(unittest.TestCase):
    def test_runner_takes_only_the_listed_options(self):
        options = [name for name in inspect.signature(PilotRunner.__init__).parameters if name != "self"]
        self.assertEqual(options, RUNNER_OPTIONS)
        with self.assertRaises(TypeError):
            PilotRunner(option_that_does_not_exist="x", two_stage_basis=True, use_ncs_background=True)

    def test_prompt_versions_are_unchanged(self):
        self.assertEqual(BLUEPRINT_PROMPT_VERSION, "blueprint-v13")
        self.assertEqual(WRITER_PROMPT_VERSION, "blueprint-writer-v11")


if __name__ == "__main__":
    unittest.main()
