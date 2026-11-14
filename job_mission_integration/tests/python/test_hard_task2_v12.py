# 어려움 과제 2(추천 하나와 주의점 하나)의 채점 규칙을 API 없이 확인한다. v12(blueprint-v12, blueprint-writer-v10)에서 만들고
# v13(blueprint-v13, blueprint-writer-v11)에 맞게 고쳤다(파일 이름은 그대로 둔다).
#
# v13: 자료가 답을 하나로 정하지 않는 곳에서는 특정 답을 요구하지 않고, 학습자가 든 이유가 자기 선택을 자료의 다른 선택지와 견줘
# 실제로 받치는지를 본다. 사실은 맞지만 그 선택을 받치지 못하는 이유는 부분 점수다. 기대 답을 하나로 정하는 것은 자료가 그 하나만
# 허용할 때뿐이다. 문제 모양을 가리키는 예시("먼저 할 하나", "후보 전체를 정한 안")는 쓰지 않는다.
# 어려움의 분량은 과제마다라서 제출 형식에 "과제마다"가 있어야 한다(v12 그대로).
# 문제 모양(과제 1은 방법 적용, 과제 2는 추천과 주의점)과 쉬움·보통의 규칙은 바꾸지 않았다.

from __future__ import annotations

import copy
import unittest

from basis_fixtures import sample_blueprint
from test_blueprint_writer import blueprint_package, decisions_for
from test_rule_fixes_v10 import LengthAndTimeCheckTest, mission_with

from src.mission_generation.blueprint_checker import MissionBasisChecker, korean_length_hint
from src.mission_generation.blueprint_designer import (
    BLUEPRINT_PROMPT_VERSION,
    DESIGN_RULES,
    TWO_STAGE_HARD_ANSWER_LENGTH,
    BlueprintPromptBuilder,
)
from src.mission_generation.draft_generator import (
    BLUEPRINT_EASY_REQUIREMENTS,
    BLUEPRINT_HARD_OVERRIDES,
    BLUEPRINT_NORMAL_REQUIREMENTS,
    BLUEPRINT_REQUIREMENTS,
    WRITER_PROMPT_VERSION,
    LLMInputPackageBuilder,
    PromptBuilder,
)
from src.mission_generation.mission_reviewer import REVIEWER_PROMPT_VERSION, REVIEWER_RULES
from src.mission_generation.schema_constraints_builder import SchemaConstraintsBuilder


def design_line(prefix: str) -> str:
    """설계 규칙에서 한 난이도의 줄(접두어부터 줄 끝까지)."""

    return DESIGN_RULES.split(prefix, 1)[1].split("\n", 1)[0]


class VersionTest(unittest.TestCase):
    def test_versions(self):
        self.assertEqual(BLUEPRINT_PROMPT_VERSION, "blueprint-v13")
        self.assertEqual(WRITER_PROMPT_VERSION, "blueprint-writer-v11")
        # 판정은 이미 추천 과제의 여러 답을 허용하므로 그대로 둔다.
        self.assertEqual(REVIEWER_PROMPT_VERSION, "review-judge-v2")
        self.assertIn("A task that asks for a recommendation with a reason is allowed several defensible answers", REVIEWER_RULES)
        self.assertIn("the grading would be unfair", REVIEWER_RULES)


class HardDesignRuleTest(unittest.TestCase):
    """설계 규칙의 어려움 줄: 문제 모양은 그대로, 과제 2의 채점 근거만 연다."""

    HARD = "- For hard difficulty with 2 tasks:"

    def test_problem_shape_sentence_is_unchanged(self):
        self.assertIn(
            "task 1 applies the working method of the chosen criterion to the materials, "
            "and task 2 uses that result to make one recommendation with one caution.",
            design_line(self.HARD),
        )

    def test_open_parts_do_not_require_a_particular_answer(self):
        hard = design_line(self.HARD)
        self.assertIn("Where the materials do not settle one right answer, the evaluation_basis does not require a particular answer", hard)
        self.assertIn("Name a single expected answer only when the materials allow no other", hard)

    def test_reason_must_support_the_choice_against_the_other_options(self):
        # v13: 사실만 맞는 이유로는 만점이 아니다. 이유가 학습자 자신의 선택을 다른 선택지와 견줘 받쳐야 한다.
        hard = design_line(self.HARD)
        self.assertIn("actually supports the learner's own choice when set against the other options the materials show", hard)
        self.assertIn("a reason that states true facts but does not show why that choice holds up better than the others earns only part of the points", hard)

    def test_caution_and_examples_stay_open(self):
        hard = design_line(self.HARD)
        self.assertIn("A caution is accepted when it is a real risk or limit of the chosen course that the materials show", hard)
        self.assertIn("marked '예시'", hard)
        self.assertIn("never as the only accepted answer", hard)

    def test_task2_action_says_what_to_decide_without_shape_examples(self):
        hard = design_line(self.HARD)
        self.assertIn("tasks[].action for task 2 says plainly what the learner is to decide", hard)
        # v13: 문제 모양을 가리키는 예시와 v12의 "사실만 맞으면 만점" 문장을 뺐다.
        for phrase in ("act on first", "decides every candidate", "accepted in full", "rest on facts in the materials", "what one recommendation covers"):
            with self.subTest(phrase=phrase):
                self.assertNotIn(phrase, DESIGN_RULES)

    def test_easy_and_normal_lines_do_not_get_the_hard_rule(self):
        for prefix in ("- For easy difficulty:", "- For normal difficulty:"):
            with self.subTest(prefix=prefix):
                line = design_line(prefix)
                self.assertNotIn("Task 2", line)
                self.assertNotIn("recommendation", line)

    def test_rule_reaches_the_design_request(self):
        request = {"prompt_version": BLUEPRINT_PROMPT_VERSION, "difficulty": decisions_for("hard")["difficulty"], "pieces": []}
        user = BlueprintPromptBuilder().prompts(request)["user"]
        self.assertIn("Name a single expected answer only when the materials allow no other", user)
        self.assertIn("earns only part of the points", user)


class HardWriterRuleTest(unittest.TestCase):
    """작성 규칙의 어려움 부분: 과제 2의 채점과 분량이 과제마다라는 것."""

    def test_open_parts_do_not_require_a_particular_answer(self):
        self.assertIn("Where the materials do not settle one right answer, the rubric does not require a particular answer", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("Name a single expected answer in the rubric only when the materials allow no other", BLUEPRINT_HARD_OVERRIDES)

    def test_reason_must_support_the_choice_against_the_other_options(self):
        self.assertIn(
            "It grades whether the learner's reason, drawn from the task 1 result and the materials, actually supports the learner's own choice "
            "when set against the other options the materials show",
            BLUEPRINT_HARD_OVERRIDES,
        )
        self.assertIn(
            "A reason that states true facts from the materials but does not show why that choice holds up better than the others earns only part of the points, not full points",
            BLUEPRINT_HARD_OVERRIDES,
        )

    def test_caution_and_example_stay_open(self):
        self.assertIn("A caution earns its points when it is a real risk or limit of the chosen course that the materials show", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("beginning with '예시:'", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("a rubric description may mention it only after '예:'", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("no rubric item treats the example as the only accepted answer", BLUEPRINT_HARD_OVERRIDES)

    def test_task2_instruction_says_what_to_decide_without_shape_examples(self):
        self.assertIn("The task 2 instruction says plainly what the learner is to decide, as mission_blueprint.tasks says", BLUEPRINT_HARD_OVERRIDES)
        for phrase in ("act on first", "decides every candidate", "what one recommendation covers", "every recommendation whose reasoning holds earns full points"):
            with self.subTest(phrase=phrase):
                self.assertNotIn(phrase, BLUEPRINT_HARD_OVERRIDES)

    def test_no_rule_assumes_a_what_first_question(self):
        # "무엇을 먼저 할지 물으면 …"처럼 특정 모양을 전제로 한 문장을 넣지 않는다.
        hard_design = design_line("- For hard difficulty with 2 tasks:").lower()
        for text in (hard_design, BLUEPRINT_HARD_OVERRIDES.lower()):
            for phrase in ("first", "먼저"):
                with self.subTest(phrase=phrase):
                    self.assertNotIn(phrase, text)

    def test_per_task_length_is_written_from_the_difficulty_value(self):
        korean = korean_length_hint(TWO_STAGE_HARD_ANSWER_LENGTH)
        self.assertEqual(korean, "과제마다 3~5문장")
        self.assertIn("each task's answer is 3-5 short sentences", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn(f"mission.submission_format.length_hint is '{korean}'", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("says '3~5문장' for that task", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn(f"constraints that mention it say '{korean}'", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("never give one count for both tasks together", BLUEPRINT_HARD_OVERRIDES)

    def test_hard_keeps_its_counts_and_newcomer_rule(self):
        self.assertIn("Use exactly 3 materials and exactly 2 tasks", BLUEPRINT_HARD_OVERRIDES)
        self.assertIn("The mission must still be solvable by a newcomer", BLUEPRINT_HARD_OVERRIDES)

    def test_hard_rules_reach_only_hard_two_stage_prompts(self):
        hard = PromptBuilder().draft_prompts(blueprint_package("hard"))["user"]
        self.assertIn("Where the materials do not settle one right answer, the rubric does not require a particular answer", hard)
        # 공통 규칙(채점은 지시문이 쓰라고 한 것만, 분량 표현 통일)도 어려움에 그대로 붙는다.
        self.assertIn("Each evaluation.rubric item grades only a part of the answer that a task instruction explicitly asks the learner to write", hard)
        self.assertIn("'3-5 short sentences per task' becomes '과제마다 3~5문장'", hard)
        for level in ("easy", "normal"):
            with self.subTest(level=level):
                user = PromptBuilder().draft_prompts(blueprint_package(level))["user"]
                self.assertNotIn("the rubric does not require a particular answer", user)
                self.assertNotIn("Blueprint hard-level overrides", user)

    def test_hard_rules_stay_out_of_the_ncs_path(self):
        package = LLMInputPackageBuilder().build(
            blueprint_package("hard")["job_profile"],
            decisions_for("hard"),
            SchemaConstraintsBuilder().build(evidence_names=["읽고 이해하기"]),
            job_ncs_background={"competency_unit": {"name": "u"}, "elements": [], "documents": []},
        )
        user = PromptBuilder().draft_prompts(package)["user"]
        self.assertIn("NCS hard-level overrides", user)
        self.assertNotIn("the rubric does not require a particular answer", user)
        self.assertIn("Each task may ask for 2-4 short sentences", user)  # 예전 경로의 어려움 분량 그대로

    def test_easy_and_normal_writer_rules_are_unchanged(self):
        # v10에서 바뀐 것은 어려움 부분뿐이다. 쉬움·보통 규칙의 핵심 문장이 그대로 있다.
        self.assertIn("Keep exactly 1 material, exactly 1 task, and a 1-2 sentence answer.", BLUEPRINT_EASY_REQUIREMENTS)
        self.assertIn("Keep exactly 2 materials, exactly 1 task, and a 2-3 sentence answer.", BLUEPRINT_NORMAL_REQUIREMENTS)
        self.assertNotIn("Task 2", BLUEPRINT_REQUIREMENTS + BLUEPRINT_EASY_REQUIREMENTS + BLUEPRINT_NORMAL_REQUIREMENTS)


class HardLengthHintCheckTest(unittest.TestCase):
    """제출 형식의 분량 안내가 과제마다임을 밝히지 않으면 오류(BM_LENGTH_HINT_FORMAT)."""

    OK_MAP = LengthAndTimeCheckTest.OK_MAP

    @staticmethod
    def hard_level() -> dict:
        level = copy.deepcopy(decisions_for("hard")["difficulty"])
        level.update({"answer_length_hint": TWO_STAGE_HARD_ANSWER_LENGTH, "estimated_time_minutes": 20})
        return level

    def codes(self, mission, level) -> list[str]:
        result = MissionBasisChecker().check(mission_draft=mission, basis_map=self.OK_MAP, blueprint=sample_blueprint(), difficulty=level)
        return [error["code"] for error in result["errors"]]

    def test_hint_without_per_task_is_an_error(self):
        mission = mission_with("hard", hint="3~5문장", minutes=20)
        result = MissionBasisChecker().check(mission_draft=mission, basis_map=self.OK_MAP, blueprint=sample_blueprint(), difficulty=self.hard_level())
        self.assertEqual([error["code"] for error in result["errors"]], ["BM_LENGTH_HINT_FORMAT"])
        self.assertIn("'과제마다 3~5문장'", result["errors"][0]["required_fix"])

    def test_per_task_wordings_pass(self):
        for hint in ("과제마다 3~5문장", "과제별 3~5문장", "각 과제 3~5문장"):
            with self.subTest(hint=hint):
                mission = mission_with(
                    "hard", hint=hint, minutes=20, instruction="판정과 근거를 3~5문장으로 정리해 보세요.",
                    constraints=["자료의 내용만 근거로 판단하세요.", "과제마다 3~5문장으로 짧게 작성하세요."],
                )
                self.assertEqual(self.codes(mission, self.hard_level()), [])

    def test_wrong_range_still_reports_the_range(self):
        mission = mission_with("hard", hint="과제마다 2~4문장", minutes=20)
        self.assertEqual(self.codes(mission, self.hard_level()), ["BM_LENGTH_HINT_RANGE"])

    def test_whole_answer_ranges_do_not_need_per_task(self):
        level = copy.deepcopy(decisions_for("easy")["difficulty"])
        level["estimated_time_minutes"] = 10
        self.assertEqual(self.codes(mission_with("easy", hint="1~2문장", minutes=10), level), [])

    def test_hard_time_must_be_twenty_minutes(self):
        mission = mission_with("hard", hint="과제마다 3~5문장", minutes=15)
        self.assertEqual(self.codes(mission, self.hard_level()), ["BM_TIME_MISMATCH"])


if __name__ == "__main__":
    unittest.main()
