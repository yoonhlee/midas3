# 검수 뒤 고친 두 단계 규칙(blueprint-v10 → v11, blueprint-writer-v8 → v9)과 검수 판정(review-judge-v2)을 API 없이 확인한다.
#
# 채점 기준은 지시문이 쓰라고 한 것만 본다, 분량 표현을 한국어 "N~M문장" 하나로, 용어 풀이는 뜻만,
# 상황·목표에 정답 이름을 쓰지 않음, 예상 시간 10/15/20분, 심각도 칸이 빠진 판정의 처리.
# v11/v9: 보통의 "맞아 보이지만 답이 아닌 것 하나를 설명" 요구와 3~4문장을 되돌렸다(보통도 2~3문장, 오답은 채점하지 않음).

from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from basis_fixtures import JOB_CD, PROJECT_ROOT, SCRATCH_ROOT, UNIT_KEY, sample_blueprint, sample_mission, sample_ncs_job, sample_unit
from test_blueprint_writer import blueprint_package, decisions_for
from test_mission_reviewer import SOLVED, StubRuntime, judged

from src.mission_generation.blueprint_checker import (
    MissionBasisChecker,
    korean_length_hint,
    length_agrees,
    length_mentions,
    parse_length_range,
)
from src.mission_generation.blueprint_designer import (
    DESIGN_RULES,
    TWO_STAGE_ESTIMATED_MINUTES,
    TWO_STAGE_HARD_ANSWER_LENGTH,
)
import src.mission_generation.blueprint_designer as blueprint_designer
from src.mission_generation.draft_generator import (
    BLUEPRINT_EASY_REQUIREMENTS,
    BLUEPRINT_NORMAL_REQUIREMENTS,
    BLUEPRINT_REQUIREMENTS,
    LLMInputPackageBuilder,
    PromptBuilder,
)
from src.mission_generation.mission_reviewer import (
    REVIEWER_PROMPT_VERSION,
    REVIEWER_RULES,
    SOLVER_PROMPT_VERSION,
    decide,
    issues_to_fix,
    render_summary,
    review_run,
    reviewer_json_schema,
    solver_json_schema,
    solver_prompts,
)
from src.mission_generation.pilot_runner import PilotRunner
from src.mission_generation.schema_constraints_builder import SchemaConstraintsBuilder
from src.mission_generation.system_decision_builder import SystemDecisionBuilder

WORK = SCRATCH_ROOT / "rule_fixes_v10"
WORK_RELATIVE = "outputs/_pytest_basis/rule_fixes_v10"
HAS_KNOW_DATA = (PROJECT_ROOT / "data" / "api_raw" / JOB_CD / "dtlGb_2.xml").exists()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class DesignRulesTest(unittest.TestCase):
    """설계 단계: 채점 근거는 과제가 쓰라고 하는 것과 짝이 맞아야 한다."""

    def test_evaluation_basis_pairs_with_what_a_task_asks(self):
        self.assertIn("Each evaluation_basis item checks one part of the answer that a task explicitly asks the learner to write", DESIGN_RULES)
        self.assertIn("Do not plan an evaluation_basis item for something no task asks the learner to write", DESIGN_RULES)
        self.assertIn("Everything the tasks ask for together must fit in difficulty.answer_length_hint", DESIGN_RULES)

    def test_easy_keeps_look_alike_entries_but_does_not_grade_them(self):
        easy = DESIGN_RULES.split("- For easy difficulty:", 1)[1].split("\n", 1)[0]
        self.assertIn("may stay in the material as they are", easy)
        self.assertIn("no evaluation_basis item checks why the other entries were ruled out", easy)

    def test_normal_keeps_the_tempting_answer_but_does_not_grade_it(self):
        # v11: 보통에서 "맞아 보이지만 답이 아닌 것 하나를 설명하라" 요구를 뺐다.
        normal = DESIGN_RULES.split("- For normal difficulty:", 1)[1].split("\n", 1)[0]
        self.assertIn("plan at least one tempting wrong answer", normal)
        self.assertIn("The task asks for the answer (the choice, the entries found, or the value worked out) and its reason", normal)
        self.assertIn("no evaluation_basis item checks why it or any other option is ruled out", normal)
        self.assertIn("When the task itself asks for a verdict on each entry, those verdicts are part of the answer and may be checked", normal)
        self.assertNotIn("looks right at first", DESIGN_RULES)

    def test_two_stage_values(self):
        self.assertEqual(TWO_STAGE_ESTIMATED_MINUTES, {"easy": 10, "normal": 15, "hard": 20})
        self.assertEqual(TWO_STAGE_HARD_ANSWER_LENGTH, "3-5 short sentences per task")
        self.assertFalse(hasattr(blueprint_designer, "TWO_STAGE_NORMAL_ANSWER_LENGTH"))  # v11: 보통 덮어쓰기를 뺐다


class WriterRulesTest(unittest.TestCase):
    """작성 단계: 채점·분량·용어 풀이·상황 설명 규칙은 두 단계의 세 난이도에 모두 붙고, 다른 경로에는 없다."""

    RULES = (
        "Each evaluation.rubric item grades only a part of the answer that a task instruction explicitly asks the learner to write",
        "explaining software conditions and hardware conditions separately",
        "leave it out of the rubric instead of adding a new demand to the task",
        "written in Korean as 'N~M문장'",
        "'3-5 short sentences per task' becomes '과제마다 3~5문장'",
        "do not give a different count such as '한 문장으로'",
        "A definition says only what the term means",
        "begin that part with '이 미션에서는'",
        "They do not name the answer before the learner works it out",
        "mission.submission_format.estimated_time_minutes is system_decisions.difficulty.estimated_time_minutes",
    )

    def test_rules_reach_every_two_stage_difficulty(self):
        for level in ("easy", "normal", "hard"):
            with self.subTest(level=level):
                user = PromptBuilder().draft_prompts(blueprint_package(level))["user"]
                for rule in self.RULES:
                    self.assertIn(rule, user)

    def test_rules_stay_out_of_the_other_paths(self):
        profile_package = LLMInputPackageBuilder().build(
            blueprint_package()["job_profile"],
            decisions_for("normal"),
            SchemaConstraintsBuilder().build(evidence_names=["읽고 이해하기"]),
            job_ncs_background={"competency_unit": {"name": "u"}, "elements": [], "documents": []},
        )
        user = PromptBuilder().draft_prompts(profile_package)["user"]
        for rule in self.RULES:
            self.assertNotIn(rule, user)

    def test_normal_answer_length_is_the_same_value_as_the_difficulty(self):
        # v9: 보통은 2~3문장(난이도 기본값과 같은 값)이고, 뺀 후보의 이유를 쓰게 하거나 채점하지 않는다.
        self.assertIn("a 2-3 sentence answer", BLUEPRINT_NORMAL_REQUIREMENTS)
        self.assertEqual(SystemDecisionBuilder()._difficulty("normal")["answer_length_hint"], "2-3 short sentences")
        self.assertNotIn("3-4", BLUEPRINT_NORMAL_REQUIREMENTS)
        self.assertNotIn("looks right at first", BLUEPRINT_NORMAL_REQUIREMENTS)
        self.assertIn("and the rubric grades only those", BLUEPRINT_NORMAL_REQUIREMENTS)
        self.assertIn("No rubric item grades why the tempting wrong answer or another option is ruled out", BLUEPRINT_NORMAL_REQUIREMENTS)
        self.assertIn("those verdicts are part of the answer and may be graded", BLUEPRINT_NORMAL_REQUIREMENTS)

    def test_easy_grades_only_the_finding_and_its_reason(self):
        self.assertIn("the rubric grades only those", BLUEPRINT_EASY_REQUIREMENTS)
        self.assertIn("no rubric item grades why they were ruled out", BLUEPRINT_EASY_REQUIREMENTS)

    def test_general_rubric_rule_is_in_the_common_two_stage_block(self):
        # 어려움에도 일반 규칙으로 걸리게 공통 블록에 둔다.
        self.assertIn("Each evaluation.rubric item grades only", BLUEPRINT_REQUIREMENTS)


class LengthWordsTest(unittest.TestCase):
    def test_parse_and_korean_hint(self):
        self.assertEqual(parse_length_range("3-4 short sentences"), (3, 4))
        self.assertEqual(parse_length_range("3-5 short sentences per task"), (3, 5))
        self.assertIsNone(parse_length_range(None))
        self.assertEqual(korean_length_hint("1-2 short sentences"), "1~2문장")
        self.assertEqual(korean_length_hint("3-4 short sentences"), "3~4문장")
        self.assertEqual(korean_length_hint("3-5 short sentences per task"), "과제마다 3~5문장")
        self.assertEqual(korean_length_hint("짧게"), "")

    def test_mentions(self):
        def found(text):
            return [(m["text"], m["low"], m["high"], m["kind"]) for m in length_mentions(text)]

        self.assertEqual(found("이유를 한 문장으로 적어보세요."), [("한 문장", 1, 1, "count")])
        self.assertEqual(found("답은 1~2문장으로 씁니다."), [("1~2문장", 1, 2, "range")])
        self.assertEqual(found("두세 문장으로 써요"), [("두세 문장", 2, 3, "count")])
        self.assertEqual(found("간단한 문장으로 적어보세요."), [])  # '간단한'의 '한'은 개수가 아니다
        self.assertEqual(found("기획서의 두 문장의 요구사항을 보세요."), [])  # 분량을 말하는 글이 아니다
        self.assertEqual(found("3~5문장"), [("3~5문장", 3, 5, "range")])
        self.assertEqual(found(None), [])

    def test_agreement(self):
        def agree(text, expected):
            return [length_agrees(m, expected) for m in length_mentions(text)]

        self.assertEqual(agree("한 문장으로 적어보세요", (1, 2)), [False])
        self.assertEqual(agree("1~2문장으로 적어보세요", (1, 2)), [True])
        self.assertEqual(agree("2문장 이내로 적어보세요", (1, 2)), [True])
        self.assertEqual(agree("3문장 이내로 적어보세요", (1, 2)), [False])
        self.assertEqual(agree("한 문장 이상", (1, 2)), [True])
        self.assertEqual(agree("2~3문장으로", (3, 4)), [False])


def mission_with(level: str, *, hint, minutes, instruction=None, constraints=None) -> dict:
    mission = sample_mission()
    body = mission["mission"]
    body["difficulty"] = copy.deepcopy(decisions_for(level)["difficulty"])
    body["submission_format"] = {"type": "short_text", "estimated_time_minutes": minutes, "required_sections": ["답"], "length_hint": hint}
    # 표본 미션의 지시문은 "2~3문장"을 말하므로, 따로 주지 않으면 분량이 없는 지시문으로 바꾼다.
    body["tasks"][0]["instruction"] = instruction if instruction is not None else "두 자료를 보고 초안에서 고칠 항목과 그 이유를 전달해 보세요."
    if constraints is not None:
        body["scenario"]["constraints"] = constraints
    return mission


class LengthAndTimeCheckTest(unittest.TestCase):
    OK_MAP = {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}, {"rubric_index": 1, "evaluation_basis_index": 0}]}

    def codes(self, mission, difficulty=None) -> list[str]:
        result = MissionBasisChecker().check(
            mission_draft=mission, basis_map=self.OK_MAP, blueprint=sample_blueprint(), difficulty=difficulty
        )
        return [error["code"] for error in result["errors"]]

    @staticmethod
    def easy_level() -> dict:
        level = copy.deepcopy(decisions_for("easy")["difficulty"])
        level["estimated_time_minutes"] = 10
        return level

    def test_consistent_korean_length_passes(self):
        mission = mission_with("easy", hint="1~2문장", minutes=10, instruction="표를 보고 고칠 곳 하나와 이유를 1~2문장으로 적어보세요.",
                               constraints=["표의 값만 보고 판단합니다.", "답은 1~2문장으로 씁니다."])
        self.assertEqual(self.codes(mission, self.easy_level()), [])

    def test_english_hint_is_an_error(self):
        mission = mission_with("easy", hint="1-2 short sentences", minutes=10)
        self.assertEqual(self.codes(mission, self.easy_level()), ["BM_LENGTH_HINT_FORMAT"])

    def test_hint_range_must_match_the_difficulty(self):
        mission = mission_with("easy", hint="2~3문장", minutes=10)
        self.assertEqual(self.codes(mission, self.easy_level()), ["BM_LENGTH_HINT_RANGE"])

    def test_one_sentence_instruction_against_a_range_is_an_error(self):
        # 검수에서 본 어긋남: 지시문은 '한 문장으로', 유의 사항과 제출 형식은 '1~2문장'.
        mission = mission_with("easy", hint="1~2문장", minutes=10, instruction="고칠 곳 하나와 이유를 한 문장으로 적어보세요.",
                               constraints=["답은 1~2문장으로 씁니다."])
        result = MissionBasisChecker().check(mission_draft=mission, basis_map=self.OK_MAP, blueprint=sample_blueprint(), difficulty=self.easy_level())
        self.assertEqual([e["code"] for e in result["errors"]], ["BM_LENGTH_MISMATCH"])
        self.assertEqual(result["errors"][0]["path"], "mission.tasks[0].instruction")
        self.assertIn("'1~2문장'", result["errors"][0]["required_fix"])

    def test_constraint_with_another_range_is_an_error(self):
        mission = mission_with("easy", hint="1~2문장", minutes=10, constraints=["답은 2~3문장으로 씁니다."])
        self.assertEqual(self.codes(mission, self.easy_level()), ["BM_LENGTH_MISMATCH"])

    def test_time_must_match_the_difficulty(self):
        mission = mission_with("easy", hint="1~2문장", minutes=15)
        self.assertEqual(self.codes(mission, self.easy_level()), ["BM_TIME_MISMATCH"])

    def test_hard_per_task_hint(self):
        level = copy.deepcopy(decisions_for("hard")["difficulty"])
        level.update({"answer_length_hint": TWO_STAGE_HARD_ANSWER_LENGTH, "estimated_time_minutes": 20})
        good = mission_with("hard", hint="과제마다 3~5문장", minutes=20, instruction="판정과 근거를 3~5문장으로 정리해 보세요.")
        self.assertEqual(self.codes(good, level), [])
        bad = mission_with("hard", hint="과제마다 2~4문장", minutes=20)
        self.assertEqual(self.codes(bad, level), ["BM_LENGTH_HINT_RANGE"])

    def test_difficulty_copied_into_the_mission_is_used_when_none_is_given(self):
        mission = mission_with("easy", hint="1-2 short sentences", minutes=15)
        self.assertIn("BM_LENGTH_HINT_FORMAT", self.codes(mission))

    def test_no_length_value_means_no_length_check(self):
        # 분량 값이 없는 난이도(예전 표본)는 견줄 기준이 없어 분량을 보지 않는다.
        self.assertEqual(self.codes(sample_mission()), [])


class RunnerOverridesTest(unittest.TestCase):
    """두 단계 생성만 시간 10/15/20분을 쓴다(보통의 분량은 기본값 2~3문장). 두 단계가 아닌 경로의 결정은 그대로다."""

    def test_plain_decisions_keep_their_values(self):
        builder = SystemDecisionBuilder()
        values = {level: builder._difficulty(level) for level in ("easy", "normal", "hard")}
        self.assertEqual([values[level]["estimated_time_minutes"] for level in ("easy", "normal", "hard")], [15, 15, 15])
        self.assertEqual(values["normal"]["answer_length_hint"], "2-3 short sentences")


@unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 mock 전체 실행을 건너뛴다")
class TwoStageRunValuesTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        (WORK / "ncs_jobs").mkdir(parents=True, exist_ok=True)
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(
            json.dumps({**sample_ncs_job(), "units": [sample_unit()]}, ensure_ascii=False), encoding="utf-8"
        )

    def run_one(self, difficulty: str, two_stage: bool = True) -> Path:
        summary = PilotRunner(
            output_root=f"{WORK_RELATIVE}/out_{difficulty}_{int(two_stage)}",
            force_mock=True,
            concurrency=1,
            target_job_codes=[JOB_CD],
            target_difficulty_codes=[difficulty],
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            ncs_units={JOB_CD: UNIT_KEY},
            two_stage_basis=two_stage,
        ).run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        return Path(summary["run_dir"]) / "jobs" / JOB_CD / difficulty

    def test_two_stage_length_and_time_reach_both_stages_and_the_mission(self):
        expected = {
            "easy": ("1-2 short sentences", 10, "1~2문장"),
            "normal": ("2-3 short sentences", 15, "2~3문장"),
            "hard": ("3-5 short sentences per task", 20, "과제마다 3~5문장"),
        }
        for level, (length, minutes, korean) in expected.items():
            with self.subTest(level=level):
                slot = self.run_one(level)
                for name in ("system_decisions.json", "blueprint_request.json"):
                    difficulty = read_json(slot / name)["difficulty"]
                    self.assertEqual((difficulty["answer_length_hint"], difficulty["estimated_time_minutes"]), (length, minutes))
                package = read_json(slot / "llm_input_package.json")
                self.assertEqual(package["system_decisions"]["difficulty"]["answer_length_hint"], length)
                mission = read_json(slot / "mission_output.json")["mission"]
                self.assertEqual((mission["submission_format"]["length_hint"], mission["submission_format"]["estimated_time_minutes"]), (korean, minutes))
                self.assertEqual(mission["difficulty"]["estimated_time_minutes"], minutes)
                self.assertEqual(read_json(slot / "mission_basis_check_attempt_0.json")["errors"], [])

    def test_plain_path_keeps_english_hint_and_old_time(self):
        slot = self.run_one("easy", two_stage=False)
        mission = read_json(slot / "mission_output.json")["mission"]
        self.assertEqual(mission["difficulty"]["estimated_time_minutes"], 15)
        self.assertEqual(mission["submission_format"]["length_hint"], "1-2 short sentences")


class ReviewerJudgeV2Test(unittest.TestCase):
    def test_versions_and_rules(self):
        self.assertEqual(REVIEWER_PROMPT_VERSION, "review-judge-v2")
        self.assertEqual(SOLVER_PROMPT_VERSION, "review-solver-v2")
        self.assertIn('never leave severity out', REVIEWER_RULES)
        self.assertIn("A rubric item that gives 20 points or more for something the instructions do not ask for", REVIEWER_RULES)
        self.assertIn("is a warning of kind rubric_not_in_task", REVIEWER_RULES)
        self.assertIn("The same thing worth fewer than 20 points is a note of that kind", REVIEWER_RULES)

    def test_solver_request_is_unchanged(self):
        # 풀어 보기 요청은 v2 그대로라서 앞선 검수의 풀어 보기 답을 다시 쓸 수 있다.
        kinds = solver_json_schema()["properties"]["issues"]["items"]["properties"]["kind"]["enum"]
        self.assertEqual(kinds, ["missing_information", "ambiguous_or_several_answers", "answer_leak", "inconsistent_data", "too_much_for_length", "unclear_wording", "other"])
        self.assertNotIn("rubric_not_in_task", solver_prompts(sample_mission())["user"])
        judge_kinds = reviewer_json_schema()["properties"]["issues"]["items"]["properties"]["kind"]["enum"]
        self.assertIn("rubric_not_in_task", judge_kinds)

    def test_rubric_issues_are_counted(self):
        rubric = {"kind": "rubric_not_in_task", "severity": "warning", "where": "채점 2", "detail": "뺀 후보의 이유에 30점", "raised_by": "reviewer"}
        result = decide(SOLVED, judged(issues=[rubric], verdict="doubt"))
        self.assertEqual((result["verdict"], result["rubric_issue_count"], result["warning_count"]), ("doubt", 1, 1))

    def test_fix_follows_the_same_severity_rule(self):
        bare = {"kind": "answer_leak", "where": "자료 1", "detail": "d"}
        self.assertEqual(issues_to_fix(judged(issues=[bare], verdict="pass")), [])
        self.assertEqual([item["code"] for item in issues_to_fix(judged(issues=[bare], verdict="doubt"))], ["REVIEW_ANSWER_LEAK"])

    def test_summary_keeps_the_missing_severity_count(self):
        bare = {"kind": "other", "where": "자료 1", "detail": "사소하다"}
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder) / "run"
            slot = run / "jobs" / JOB_CD / "normal"
            slot.mkdir(parents=True)
            (slot / "mission_output.json").write_text(json.dumps(sample_mission(), ensure_ascii=False), encoding="utf-8")
            summary = review_run(run, runtime=StubRuntime(review=judged(issues=[bare], verdict="pass")))
            self.assertEqual((summary["severity_missing_count"], summary["missions"][0]["severity_missing_count"]), (1, 1))
            self.assertEqual(summary["counts"], {"pass": 1})
            text = (Path(summary["out_dir"]) / "summary.md").read_text(encoding="utf-8")
            self.assertIn("심각도 칸이 빠진 문제 항목 1건(미션 1개)", text)
            self.assertIn("[참고·칸 빠짐]", text)


if __name__ == "__main__":
    unittest.main()
