# 검수에서 의심·문제가 붙은 미션을 고쳐 쓰는 길(mission_reviewer --fix)을 API 없이 확인한다.

from __future__ import annotations

import copy
import json
import shutil
import unittest
from pathlib import Path
from types import SimpleNamespace

from basis_fixtures import JOB_CD, PROJECT_ROOT, SCRATCH_ROOT, UNIT_KEY, sample_ncs_job, sample_unit
from test_mission_reviewer import JUDGED, SOLVED, issue, judged

from src.mission_generation.mission_reviewer import VERDICT_DOUBT, VERDICT_PASS, changed_paths, issues_to_fix, review_run
from src.mission_generation.pilot_runner import PilotRunner

WORK = SCRATCH_ROOT / "review_fix"
WORK_RELATIVE = "outputs/_pytest_basis/review_fix"
HAS_KNOW_DATA = (PROJECT_ROOT / "data" / "api_raw" / JOB_CD / "dtlGb_2.xml").exists()
FIXED_TEXT = "고친 채점 설명: 어느 개선방안을 골라도 근거가 맞으면 인정한다"
DOUBT = judged(issues=[issue("warning", "other"), issue("note")], verdict="doubt")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class IssuesToFixTest(unittest.TestCase):
    def test_errors_warnings_and_a_doubted_key_are_sent_but_not_notes_or_fact_doubts(self):
        judgement = judged(
            issues=[issue("error", "answer_leak"), issue("warning"), issue("note")],
            fact_doubts=[{"claim": "c", "why": "w"}],
            expected_answer_check="doubtful",
            expected_answer_note="둘째 해설이 자료와 다르다",
        )
        sent = issues_to_fix(judgement)
        self.assertEqual([item["code"] for item in sent], ["REVIEW_ANSWER_LEAK", "REVIEW_MISSING_INFORMATION", "REVIEW_EXPECTED_ANSWER"])
        self.assertEqual(sent[0], {"path": "자료 1", "severity": "fail", "code": "REVIEW_ANSWER_LEAK", "message": "값이 없다", "required_fix": "Fix this point and nothing else.", "repairable": True})
        self.assertEqual(sent[2]["message"], "둘째 해설이 자료와 다르다")
        self.assertEqual(issues_to_fix(JUDGED), [])
        self.assertEqual(issues_to_fix(None), [])

    def test_changed_paths_lists_where_two_missions_differ(self):
        before = {"a": {"b": [1, {"c": "x"}], "d": 1}, "e": [1, 2]}
        after = {"a": {"b": [1, {"c": "y"}], "d": 1}, "e": [1, 2, 3], "f": True}
        self.assertEqual(changed_paths(before, after), ["a.b[1].c", "e", "f"])
        self.assertEqual(changed_paths(before, copy.deepcopy(before)), [])


class FixStub:
    """풀어 보기·판정·고쳐 쓰기 호출에 준비된 답을 준다. 고친 글이 보이면 판정은 통과다."""

    def __init__(self, slot: Path, repair=None) -> None:
        self.config = SimpleNamespace(provider="anthropic", model="stub-model", reasoning_effort="medium", repair_temperature=0.4, max_output_tokens_repair=8000)
        self.slot, self.repair, self.calls = slot, repair, []

    def api_key_available(self) -> bool:
        return True

    def fixed_draft(self) -> dict:
        draft = read_json(self.slot / "mission_draft_attempt_0.json")
        draft["evaluation"]["rubric"][0]["description"] = FIXED_TEXT
        return draft

    def call_structured(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        call_type = kwargs["call_type"]
        if call_type == "mission_solve":
            output = SOLVED
        elif call_type == "mission_review":
            output = JUDGED if FIXED_TEXT in kwargs["user_prompt"] else DOUBT
        else:
            output = self.repair(self) if self.repair else self.fixed_draft()
        return {"provider": "anthropic", "model": "stub-model", "call_type": call_type, "status": "completed", "output_json": output, "errors": [], "usage": {}}


@unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 전체 실행을 건너뛴다")
class ReviewFixRunTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        shutil.rmtree(WORK, True)
        (WORK / "ncs_jobs").mkdir(parents=True, exist_ok=True)
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(json.dumps({**sample_ncs_job(), "units": [sample_unit()]}, ensure_ascii=False), encoding="utf-8")
        summary = PilotRunner(
            output_root=f"{WORK_RELATIVE}/out",
            force_mock=True,
            concurrency=1,
            target_job_codes=[JOB_CD],
            target_difficulty_codes=["normal"],
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            ncs_units={JOB_CD: UNIT_KEY},
            two_stage_basis=True,
        ).run()
        self.run_dir = Path(summary["run_dir"])
        self.slot = self.run_dir / "jobs" / JOB_CD / "normal"
        self.out = WORK / "review"

    def test_doubted_mission_is_fixed_saved_apart_and_reviewed_again(self):
        original = (self.slot / "mission_output.json").read_bytes()
        stub = FixStub(self.slot)
        summary = review_run(self.run_dir, out_dir=self.out, runtime=stub, fix=True)
        self.assertEqual([call["call_type"] for call in stub.calls], ["mission_solve", "mission_review", "repair_generation", "mission_solve", "mission_review"])
        repair_prompt = stub.calls[2]["user_prompt"]
        self.assertIn("REVIEW_OTHER", repair_prompt)  # 검수가 적은 주의 문제가 넘어간다
        self.assertNotIn("REVIEW_MISSING_INFORMATION", repair_prompt)  # 참고는 넘기지 않는다
        self.assertIn("content review of the finished mission", repair_prompt)
        self.assertIn("mission_blueprint", repair_prompt)  # 설계서를 보고 고친다
        self.assertEqual((summary["counts"], summary["fix"]), ({VERDICT_DOUBT: 1}, {"attempted": 1, "statuses": {"fixed": 1}, "verdict_after_fix": {VERDICT_PASS: 1}}))
        record = read_json(self.out / f"{JOB_CD}_normal.json")
        fix = record["fix"]
        self.assertEqual((record["verdict"], fix["status"], fix["validation"]), (VERDICT_DOUBT, "fixed", {"status": "pass", "error_codes": []}))
        self.assertEqual(fix["mission_file"], f"fixed/{JOB_CD}_normal/mission_output.json")
        self.assertIn("evaluation.rubric[0].description", fix["changed"])
        self.assertEqual((fix["review_after"]["verdict"], fix["review_after"]["verdict_label"]), (VERDICT_PASS, "통과"))
        fixed = read_json(self.out / fix["mission_file"])
        self.assertEqual(fixed["evaluation"]["rubric"][0]["description"], FIXED_TEXT)
        self.assertEqual((fixed["reliability"]["repair_count"], "basis_map" in fixed, fixed["mission_id"]), (1, False, f"mission_{JOB_CD}_normal_001"))
        self.assertEqual((self.slot / "mission_output.json").read_bytes(), original)  # 원래 미션 파일은 그대로다
        text = (self.out / "summary.md").read_text(encoding="utf-8")
        self.assertIn("고침 → 통과", text)
        self.assertIn("### 고친 뒤 다시 검수: 통과", text)

    def test_fix_that_fails_the_checks_is_dropped(self):
        def broken(stub: FixStub) -> dict:
            draft = stub.fixed_draft()
            draft["basis_map"] = {"rubric": []}
            return draft

        summary = review_run(self.run_dir, out_dir=self.out, runtime=FixStub(self.slot, repair=broken), fix=True)
        fix = read_json(self.out / f"{JOB_CD}_normal.json")["fix"]
        self.assertEqual((fix["status"], fix["validation"]["error_codes"]), ("fix_rejected", ["BM_RUBRIC_UNMAPPED"]))
        self.assertNotIn("review_after", fix)
        self.assertFalse((self.out / "fixed").exists())
        self.assertEqual(summary["fix"]["statuses"], {"fix_rejected": 1})

    def test_without_the_flag_nothing_is_fixed(self):
        stub = FixStub(self.slot)
        summary = review_run(self.run_dir, out_dir=self.out, runtime=stub)
        self.assertEqual([call["call_type"] for call in stub.calls], ["mission_solve", "mission_review"])
        self.assertNotIn("fix", summary)
        self.assertNotIn("fix", read_json(self.out / f"{JOB_CD}_normal.json"))


if __name__ == "__main__":
    unittest.main()
