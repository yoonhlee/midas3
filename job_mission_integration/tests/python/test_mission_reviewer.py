# 미션 내용 검수(mission_reviewer): 풀어 보기 → 판정 두 호출과 통과/의심/문제 규칙을 API 없이 확인한다.

from __future__ import annotations

import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from basis_fixtures import sample_mission

from src.mission_generation.mission_reviewer import (
    REVIEWER_PROMPT_VERSION,
    SOLVER_PROMPT_VERSION,
    VERDICT_DOUBT,
    VERDICT_ERROR,
    VERDICT_FAIL,
    VERDICT_PASS,
    MissionReviewer,
    answer_key,
    decide,
    find_missions,
    learner_view,
    main,
    render_summary,
    review_run,
    reviewer_json_schema,
    reviewer_prompts,
    solver_json_schema,
    solver_prompts,
)

SOLVED = {
    "schema_version": "mission_solve.v1",
    "answers": [{"task_id": "task_001", "answer": "두 번째 항목이 지침과 다릅니다.", "basis": "표의 둘째 줄과 메모의 조건을 견줌"}],
    "solvable": "yes",
    "issues": [],
    "minutes_estimate": 4,
}
JUDGED = {
    "schema_version": "mission_review_judgement.v1",
    "expected_answer_check": "correct",
    "expected_answer_note": "",
    "agreement": "same",
    "agreement_note": "",
    "answer_unique": "yes",
    "issues": [],
    "fact_doubts": [],
    "verdict": "pass",
    "summary": "자료만으로 풀리고 기대 답과 같다.",
}


def judged(**changes) -> dict:
    return {**copy.deepcopy(JUDGED), **changes}


def issue(severity: str, kind: str = "missing_information") -> dict:
    return {"kind": kind, "severity": severity, "where": "자료 1", "detail": "값이 없다", "raised_by": "reviewer"}


class StubRuntime:
    """준비된 답을 호출 종류별로 돌려주고, 받은 프롬프트를 적어 둔다."""

    def __init__(self, solve=SOLVED, review=JUDGED) -> None:
        self.config = SimpleNamespace(provider="anthropic", model="stub-model", reasoning_effort="medium", repair_temperature=0.4, max_output_tokens_repair=8000)
        self.outputs = {"mission_solve": solve, "mission_review": review}
        self.calls: list[dict] = []

    def call_structured(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        output = self.outputs[kwargs["call_type"]]
        status = "completed" if isinstance(output, dict) else "failed"
        errors = [] if isinstance(output, dict) else [{"code": "ANTHROPIC_TIMEOUT", "message": "t"}]
        return {"provider": "anthropic", "model": "stub-model", "call_type": kwargs["call_type"], "status": status, "output_json": output, "errors": errors, "usage": {"total_tokens": 10}}


def mission_with(materials: list[dict]) -> dict:
    mission = sample_mission()
    mission["mission"]["materials"] = materials
    return mission


class LearnerViewTest(unittest.TestCase):
    def test_holds_what_the_screen_shows_and_nothing_about_the_answer(self):
        mission = sample_mission()
        mission["mission"]["submission_format"] = {"type": "short_text", "required_sections": ["고른 것과 이유"], "length_hint": "2~3문장"}
        view = learner_view(mission)
        body = mission["mission"]
        self.assertEqual((view["title"], view["job_name"]), (body["title"], mission["job_identity"]["job_smcl_nm"]))
        self.assertEqual(view["answer_format"], {"required_sections": ["고른 것과 이유"], "length_hint": "2~3문장"})
        self.assertEqual(view["scenario"]["constraints"], body["scenario"]["constraints"])
        self.assertEqual([item["instruction"] for item in view["tasks"]], [task["instruction"] for task in body["tasks"]])
        self.assertEqual([item["title"] for item in view["materials"]], [material["title"] for material in body["materials"]])
        self.assertEqual(view["answer_format"]["length_hint"], body["submission_format"]["length_hint"])
        text = json.dumps(view, ensure_ascii=False)
        for hidden in mission["evaluation"]["expected_insights"] + [item["description"] for item in mission["evaluation"]["rubric"]]:
            self.assertNotIn(hidden, text)
        for key in ("evaluation", "evidence_chain", "mission_facts", "expected_action", "evidence_source", "reliability"):
            self.assertNotIn(f'"{key}"', text, key)

    def test_values_the_screen_does_not_show_are_left_out(self):
        chart = {"material_id": "m1", "type": "chart", "title": "t", "description": "d", "used_for": "u", "data": {"chart_type": "bar", "x_axis": {"label": "업종", "values": ["가", "나"]}, "y_axis": {"label": "손해율", "unit": "%"}, "series": [{"name": "국내", "values": [1, 2]}]}}
        memo = {"material_id": "m2", "type": "memo", "title": "t", "description": "d", "used_for": "u", "data": {"author": "팀장", "items": ["조건"]}}
        checklist = {"material_id": "m3", "type": "checklist", "title": "t", "description": "d", "used_for": "u", "data": {"items": [{"label": "a", "status": "checked", "importance": "high"}, {"label": "b", "status": "unchecked", "importance": "normal"}]}}
        table = {"material_id": "m4", "type": "table", "title": "t", "description": "d", "used_for": "u", "data": {"columns": [{"key": "option", "label": "거래처"}, {"key": "priority", "label": "금액(원)"}], "rows": [{"option": "가", "priority": 100}]}}
        mission = mission_with([chart, memo, checklist, table])
        shown = [item["data"] for item in learner_view(mission)["materials"]]
        self.assertEqual(shown[3], {"columns": ["거래처", "금액(원)"], "rows": [{"거래처": "가", "금액(원)": 100}]})  # 내부 키는 화면에 없다
        self.assertEqual(shown[0], {"chart_type": "bar", "x_values": ["가", "나"], "series": [{"name": "국내", "values": [1, 2]}]})  # 축 이름과 단위는 화면에 없다
        self.assertEqual(shown[1], {"items": ["조건"]})  # 항목이 있으면 작성자는 화면에 없다
        self.assertEqual(shown[2]["items"], [{"label": "a", "status": "checked", "importance": "high"}, {"label": "b", "status": "unchecked"}])
        self.assertEqual(mission["mission"]["materials"][1]["data"]["author"], "팀장")  # 미션은 바꾸지 않는다

    def test_answer_key_is_the_expected_insights_and_rubric(self):
        mission = sample_mission()
        key = answer_key(mission)
        self.assertEqual(key["expected_insights"], mission["evaluation"]["expected_insights"])
        self.assertEqual([item["points"] for item in key["rubric"]], [item["points"] for item in mission["evaluation"]["rubric"]])
        self.assertEqual(set(key["rubric"][0]), {"criterion", "description", "points"})


class PromptTest(unittest.TestCase):
    def test_solver_never_sees_the_answer_key(self):
        mission = sample_mission()
        prompts = solver_prompts(mission)
        for hidden in mission["evaluation"]["expected_insights"]:
            self.assertNotIn(hidden, prompts["user"])
        self.assertNotIn("answer_key", prompts["user"])
        self.assertIn(SOLVER_PROMPT_VERSION, prompts["user"])
        self.assertIn(mission["mission"]["tasks"][0]["instruction"], prompts["user"])

    def test_reviewer_sees_the_key_and_the_solver_answer(self):
        mission = sample_mission()
        prompts = reviewer_prompts(mission, SOLVED)
        self.assertIn(mission["evaluation"]["expected_insights"][0], prompts["user"])
        self.assertIn(SOLVED["answers"][0]["answer"], prompts["user"])
        self.assertIn(REVIEWER_PROMPT_VERSION, prompts["user"])

    def test_schemas_are_closed_objects(self):
        for schema in (solver_json_schema(), reviewer_json_schema()):
            self.assertEqual((schema["type"], schema["additionalProperties"]), ("object", False))
            self.assertEqual(schema["required"], list(schema["properties"]))
        self.assertNotIn("wrong_expected_answer", solver_json_schema()["properties"]["issues"]["items"]["properties"]["kind"]["enum"])
        self.assertIn("wrong_expected_answer", reviewer_json_schema()["properties"]["issues"]["items"]["properties"]["kind"]["enum"])


class DecideTest(unittest.TestCase):
    def verdict(self, solve=None, **changes) -> str:
        return decide(solve or SOLVED, judged(**changes))["verdict"]

    def test_clean_result_passes(self):
        result = decide(SOLVED, JUDGED)
        self.assertEqual((result["verdict"], result["verdict_label"], result["reasons"]), (VERDICT_PASS, "통과", []))
        self.assertEqual((result["error_count"], result["warning_count"], result["fact_doubt_count"]), (0, 0, 0))

    def test_fail_when_the_expected_answer_is_wrong_or_the_mission_cannot_be_solved(self):
        self.assertEqual(self.verdict(expected_answer_check="wrong"), VERDICT_FAIL)
        self.assertEqual(self.verdict({**SOLVED, "solvable": "no"}), VERDICT_FAIL)
        self.assertEqual(self.verdict(issues=[issue("error", "answer_leak")]), VERDICT_FAIL)

    def test_doubt_for_disagreement_uniqueness_unconfirmed_key_partial_solve_or_warning(self):
        cases = [
            {"agreement": "partly"},
            {"agreement": "different"},
            {"answer_unique": "no"},
            {"answer_unique": "unclear"},
            {"expected_answer_check": "doubtful"},
            {"issues": [issue("warning")]},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertEqual(self.verdict(**changes), VERDICT_DOUBT)
        self.assertEqual(self.verdict({**SOLVED, "solvable": "partly"}), VERDICT_DOUBT)

    def test_notes_and_fact_doubts_do_not_change_the_verdict(self):
        result = decide(SOLVED, judged(issues=[issue("note")], fact_doubts=[{"claim": "한도는 3억 원이다", "why": "출처가 없다"}]))
        self.assertEqual((result["verdict"], result["note_count"], result["fact_doubt_count"]), (VERDICT_PASS, 1, 1))

    def test_never_looser_than_the_model_and_reasons_are_listed(self):
        stricter = decide(SOLVED, judged(verdict="doubt"))
        self.assertEqual((stricter["verdict"], stricter["reasons"]), (VERDICT_DOUBT, ["검수 모델의 판정이 더 엄격하다"]))
        looser = decide(SOLVED, judged(verdict="pass", agreement="different", issues=[issue("warning"), issue("error")]))
        self.assertEqual((looser["verdict"], looser["model_verdict"]), (VERDICT_FAIL, "pass"))
        self.assertEqual(looser["reasons"], ["심각한 문제 1건", "푼 답이 기대 답과 다르다", "주의할 문제 1건"])

    def test_issue_without_a_severity_follows_the_model_verdict(self):
        # 형식을 강제하지 못하는 길에서 심각도 칸이 빠진 답이 실제로 왔다. review-judge-v2부터는
        # 모델 판정이 통과면 참고로, 의심·문제면 주의로 센다. 빠진 항목 수는 따로 남긴다.
        bare = {"kind": "answer_leak", "where": "자료 1", "detail": "d"}
        passed = decide(SOLVED, judged(issues=[bare], verdict="pass"))
        self.assertEqual(
            (passed["verdict"], passed["warning_count"], passed["note_count"], passed["severity_missing_count"], passed["reasons"]),
            (VERDICT_PASS, 0, 1, 1, []),
        )
        doubted = decide(SOLVED, judged(issues=[bare, {**bare, "severity": "bogus"}], verdict="doubt"))
        self.assertEqual(
            (doubted["verdict"], doubted["warning_count"], doubted["severity_missing_count"], doubted["reasons"][0]),
            (VERDICT_DOUBT, 2, 2, "주의할 문제 2건"),
        )
        unknown = decide(SOLVED, judged(issues=[bare], verdict=None))
        self.assertEqual((unknown["verdict"], unknown["warning_count"]), (VERDICT_DOUBT, 1))  # 판정도 없으면 놓치지 않게 주의로 센다

    def test_broken_shapes_do_not_crash(self):
        self.assertEqual(decide(None, None)["verdict"], VERDICT_PASS)
        self.assertEqual(decide({"solvable": "no"}, {"issues": "x"})["verdict"], VERDICT_FAIL)


class ReviewerTest(unittest.TestCase):
    def test_two_calls_in_order_and_a_record_with_the_verdict(self):
        runtime = StubRuntime(review=judged(agreement="partly", agreement_note="한 건을 빠뜨렸다", verdict="doubt"))
        record = MissionReviewer(runtime).review(sample_mission())
        self.assertEqual([call["call_type"] for call in runtime.calls], ["mission_solve", "mission_review"])
        self.assertEqual([call["schema_name"] for call in runtime.calls], ["mission_solve_v1", "mission_review_v1"])
        self.assertNotIn("answer_key", runtime.calls[0]["user_prompt"])
        self.assertIn(SOLVED["answers"][0]["answer"], runtime.calls[1]["user_prompt"])  # 판정 호출은 푼 답을 받는다
        self.assertEqual((record["schema_version"], record["verdict"], record["verdict_label"]), ("mission_review.v1", VERDICT_DOUBT, "의심"))
        self.assertEqual((record["solver_result"], record["judgement"]["agreement"], record["pending"]), (SOLVED, "partly", None))
        self.assertEqual(record["versions"], {"solver_prompt": SOLVER_PROMPT_VERSION, "reviewer_prompt": REVIEWER_PROMPT_VERSION})
        self.assertEqual((record["solver_call"]["provider"], record["solver_call"]["status"]), ("anthropic", "completed"))
        self.assertNotIn("output_json", record["solver_call"])

    def test_failed_call_is_reported_not_guessed(self):
        runtime = StubRuntime(solve=None)
        record = MissionReviewer(runtime).review(sample_mission())
        self.assertEqual((record["verdict"], record["verdict_label"], record["reasons"]), (VERDICT_ERROR, "검수 실패", ["mission_solve: ANTHROPIC_TIMEOUT"]))
        self.assertEqual((len(runtime.calls), record["judgement"]), (1, None))
        record = MissionReviewer(StubRuntime(review=None)).review(sample_mission())
        self.assertEqual((record["verdict"], record["solver_result"], record["judgement"]), (VERDICT_ERROR, SOLVED, None))


class ReviewRunTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.run_dir = Path(tmp.name).resolve() / "pilot_v1_test"
        for job_cd, difficulty in (("K000000002", "hard"), ("K000000001", "normal"), ("K000000001", "easy")):
            slot = self.run_dir / "jobs" / job_cd / difficulty
            slot.mkdir(parents=True)
            mission = sample_mission()
            mission["mission_id"] = f"mission_{job_cd}_{difficulty}_001"
            mission["job_identity"]["job_cd"] = job_cd
            mission["mission"]["difficulty"]["level"] = difficulty
            (slot / "mission_output.json").write_text(json.dumps(mission, ensure_ascii=False), encoding="utf-8")
        (self.run_dir / "jobs" / "K000000003" / "easy").mkdir(parents=True)  # 저장된 미션이 없는 대상

    def test_missions_are_found_in_job_then_difficulty_order(self):
        found = [(path.parent.parent.name, path.parent.name) for path in find_missions(self.run_dir)]
        self.assertEqual(found, [("K000000001", "easy"), ("K000000001", "normal"), ("K000000002", "hard")])
        self.assertEqual(len(find_missions(self.run_dir, jobs=["K000000001"], difficulties=["normal"])), 1)

    def test_writes_one_record_per_mission_and_a_summary_without_touching_missions(self):
        before = {path: path.read_bytes() for path in self.run_dir.rglob("mission_output.json")}
        fact = [{"claim": "한도는 3억 원이다", "why": "출처가 없다"}]
        summary = review_run(self.run_dir, runtime=StubRuntime(review=judged(issues=[issue("warning")], fact_doubts=fact, verdict="doubt")))
        self.assertEqual((summary["mission_count"], summary["counts"], summary["pending_count"], summary["fact_doubt_count"]), (3, {VERDICT_DOUBT: 3}, 0, 3))
        self.assertEqual(summary["reviewed_by"], {"provider": "anthropic", "model": "stub-model", "reasoning_effort": "medium"})
        out = self.run_dir / "review"
        self.assertEqual(sorted(path.name for path in out.iterdir()), ["K000000001_easy.json", "K000000001_normal.json", "K000000002_hard.json", "summary.json", "summary.md"])
        record = json.loads((out / "K000000002_hard.json").read_text(encoding="utf-8"))
        self.assertEqual((record["verdict"], record["mission_file"]), (VERDICT_DOUBT, "jobs/K000000002/hard/mission_output.json"))
        text = (out / "summary.md").read_text(encoding="utf-8")
        self.assertIn("미션 3개: 의심 3", text)
        self.assertIn("[주의] 자료 1: 값이 없다", text)
        self.assertIn("[사실 의심] 한도는 3억 원이다", text)
        self.assertEqual({path: path.read_bytes() for path in self.run_dir.rglob("mission_output.json")}, before)
        self.assertNotIn("pending_list", summary)  # API 길에서는 대기 목록을 쓰지 않는다

    def test_clean_missions_are_listed_in_the_table_only(self):
        review_run(self.run_dir, runtime=StubRuntime())
        text = (self.run_dir / "review" / "summary.md").read_text(encoding="utf-8")
        self.assertIn("미션 3개: 통과 3", text)
        self.assertNotIn("\n## ", text)

    def test_main_prints_counts(self):
        printed = io.StringIO()
        with mock.patch("src.mission_generation.mission_reviewer.create_runtime", return_value=StubRuntime()):
            with contextlib.redirect_stdout(printed):
                code = main(["--run-dir", str(self.run_dir), "--difficulties", "hard"])
        self.assertEqual(code, 0)
        self.assertTrue(printed.getvalue().splitlines()[0].startswith("미션 1개: "), printed.getvalue())

    def test_render_summary_names_failed_review_calls(self):
        record = MissionReviewer(StubRuntime(solve=None)).review(sample_mission())
        text = render_summary([record], self.run_dir)
        self.assertIn("**검수 실패**", text)
        self.assertIn("검수 호출이 실패했다", text)


if __name__ == "__main__":
    unittest.main()
