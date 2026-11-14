# pilot_runner의 두 단계 생성(--two-stage-basis) 연결을 API 없이 확인한다.

from __future__ import annotations

import copy
import json
import shutil
import unittest
from pathlib import Path

from basis_fixtures import JOB_CD, PROJECT_ROOT, SCRATCH_ROOT, UNIT_KEY, sample_ncs_job, sample_unit

from src.mission_generation.blueprint_designer import TWO_STAGE_MATERIAL_TYPES, MockBlueprintBuilder
from src.mission_generation.draft_generator import MockMissionDraftBuilder
from src.mission_generation.pilot_runner import BlueprintFailedError, PilotRunner

WORK = SCRATCH_ROOT / "two_stage"
WORK_RELATIVE = "outputs/_pytest_basis/two_stage"
HAS_KNOW_DATA = (PROJECT_ROOT / "data" / "api_raw" / JOB_CD / "dtlGb_2.xml").exists()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class TwoStageOptionTest(unittest.TestCase):
    def test_requires_ncs_background(self):
        with self.assertRaisesRegex(ValueError, "--two-stage-basis requires --ncs-background"):
            PilotRunner(two_stage_basis=True)

    def test_rejects_trace_and_ablation(self):
        for option in ("ncs_trace", "ncs_ablation"):
            with self.subTest(option=option):
                with self.assertRaisesRegex(ValueError, "cannot be combined"):
                    PilotRunner(use_ncs_background=True, two_stage_basis=True, **{option: True})

    def test_blueprint_failed_error_carries_code_and_errors(self):
        error = BlueprintFailedError("failed", code="BP_CRITERIA_COUNT", errors=[{"code": "BP_CRITERIA_COUNT"}])
        self.assertEqual((error.code, error.errors), ("BP_CRITERIA_COUNT", [{"code": "BP_CRITERIA_COUNT"}]))


class BasisMergeTest(unittest.TestCase):
    VALIDATION = {
        "status": "pass",
        "passed": True,
        "repairable": False,
        "discarded": False,
        "errors": [],
        "warnings": [],
        "reliability": {"score": 1.0, "warning_count": 0, "fail_count": 0},
    }
    BASIS_ERROR = {"path": "basis_map.rubric", "severity": "fail", "code": "BM_RUBRIC_UNMAPPED", "message": "m", "required_fix": "f", "repairable": True}

    def test_split_basis_map(self):
        draft = {"a": 1, "basis_map": {"rubric": []}}
        stripped, basis_map = PilotRunner._split_basis_map(draft)
        self.assertEqual((stripped, basis_map), ({"a": 1}, {"rubric": []}))
        self.assertIn("basis_map", draft)  # 원본은 그대로 둔다
        self.assertEqual(PilotRunner._split_basis_map(None), (None, None))
        self.assertEqual(PilotRunner._split_basis_map({"a": 1}), ({"a": 1}, None))

    def test_merge_keeps_validation_when_no_basis_errors(self):
        merged = PilotRunner._merge_basis_check(self.VALIDATION, {"errors": [], "warnings": [self.BASIS_ERROR]}, 0)
        self.assertEqual(merged, self.VALIDATION)

    def test_merge_turns_pass_into_repair_then_discard(self):
        basis_check = {"errors": [self.BASIS_ERROR], "warnings": []}
        first = PilotRunner._merge_basis_check(copy.deepcopy(self.VALIDATION), basis_check, 0)
        second = PilotRunner._merge_basis_check(copy.deepcopy(self.VALIDATION), basis_check, 1)
        self.assertEqual((first["status"], first["passed"], first["repairable"], first["discarded"]), ("repair_required", False, True, False))
        self.assertEqual((second["status"], second["passed"], second["repairable"], second["discarded"]), ("discard", False, False, True))
        self.assertEqual(first["reliability"]["fail_count"], 1)
        self.assertEqual([e["code"] for e in first["errors"]], ["BM_RUBRIC_UNMAPPED"])
        self.assertEqual(self.VALIDATION["errors"], [])  # 입력은 바꾸지 않는다


class StubDesigner:
    """준비된 설계서를 차례로 돌려준다. 호출 횟수를 센다."""

    def __init__(self, *blueprints, call_errors=None) -> None:
        self.blueprints, self.call_errors, self.calls = list(blueprints), call_errors, 0

    def design(self, request, *, check_errors=None, previous=None):
        self.calls += 1
        blueprint = self.blueprints.pop(0) if self.blueprints else None
        if callable(blueprint):
            blueprint = blueprint(request)
        call = {
            "provider": "mock",
            "model": "stub",
            "reasoning_effort": "medium",
            "status": "mocked" if blueprint is not None else "failed",
            "usage": {},
            "errors": self.call_errors or [],
        }
        return {"llm_call_result": call, "mission_blueprint": blueprint}


def broken_blueprint(request):
    blueprint = MockBlueprintBuilder().build(request)
    blueprint["criteria"] = []
    return blueprint


@unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 mock 전체 실행을 건너뛴다")
class TwoStageMockRunTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        (WORK / "ncs_jobs").mkdir(parents=True, exist_ok=True)
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(
            json.dumps({**sample_ncs_job(), "units": [sample_unit()]}, ensure_ascii=False), encoding="utf-8"
        )

    def runner(self, difficulty: str = "normal", unit_key: str = UNIT_KEY) -> PilotRunner:
        return PilotRunner(
            output_root=f"{WORK_RELATIVE}/out",
            force_mock=True,
            concurrency=1,
            target_job_codes=[JOB_CD],
            target_difficulty_codes=[difficulty],
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            ncs_units={JOB_CD: unit_key},
            two_stage_basis=True,
        )

    @staticmethod
    def slot(summary: dict, difficulty: str = "normal") -> Path:
        return Path(summary["run_dir"]) / "jobs" / JOB_CD / difficulty

    def test_normal_mock_run_saves_mission_and_basis(self):
        summary = self.runner().run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        slot = self.slot(summary)
        for name in (
            "source_pack.json",
            "blueprint_request.json",
            "llm_call_result_blueprint_0.json",
            "mission_blueprint_attempt_0.json",
            "blueprint_check_attempt_0.json",
            "llm_input_package.json",
            "mission_basis_check_attempt_0.json",
            "mission_output.json",
            "generation_basis.json",
        ):
            self.assertTrue((slot / name).exists(), name)
        mission = read_json(slot / "mission_output.json")
        self.assertNotIn("basis_map", mission)
        self.assertNotIn("ncs_basis", mission)
        basis = read_json(slot / "generation_basis.json")
        self.assertEqual(len(basis["chain"]), 7)
        self.assertEqual(basis["mission_id"], mission["mission_id"])
        self.assertEqual(
            basis["artifacts"],
            {"source_pack": "source_pack.json", "blueprint": "mission_blueprint_attempt_0.json", "mission": "mission_output.json"},
        )
        self.assertEqual(read_json(slot / "run_status.json")["artifacts"]["generation_basis"], "generation_basis.json")
        self.assertIs(read_json(Path(summary["run_dir"]) / "pilot_config.json")["two_stage_basis"], True)
        self.assertEqual(summary["llm_usage"]["mock_blueprint_count"], 1)

    def test_mock_run_without_judge_fields_fills_the_link_step(self):
        # 판단한 주체와 판단한 날 칸이 없는 자료로 돌려도 근거 기록 3단계의 정한 주체가 비지 않는다.
        unit = sample_unit()
        del unit["link"]["judged_by"]
        del unit["link"]["judged_at"]
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(
            json.dumps({**sample_ncs_job(), "units": [unit]}, ensure_ascii=False), encoding="utf-8"
        )
        summary = self.runner().run()
        self.assertEqual(summary["saved_count"], 1)
        basis = read_json(self.slot(summary) / "generation_basis.json")
        self.assertEqual(basis["chain"][2]["decided_by"], "연결 판단 · 기준 v0.1")
        card_html = (Path(summary["run_dir"]) / "basis_cards" / f"{JOB_CD}_normal.html").read_text(encoding="utf-8")
        self.assertNotIn("기록 없음", card_html)

    def test_mock_run_exports_basis_cards(self):
        summary = self.runner().run()
        run_dir = Path(summary["run_dir"])
        self.assertTrue((run_dir / "basis_cards" / f"{JOB_CD}_normal.html").exists())
        self.assertEqual(sorted(summary["basis_cards"]), [f"basis_cards/{JOB_CD}_normal.html", "basis_cards/index.html"])
        self.assertEqual(read_json(run_dir / "pilot_summary.json")["basis_cards"], summary["basis_cards"])

    def test_writer_package_holds_only_cited_sources(self):
        summary = self.runner().run()
        slot = self.slot(summary)
        package = read_json(slot / "llm_input_package.json")
        blueprint = read_json(slot / "mission_blueprint_attempt_0.json")
        self.assertNotIn("job_ncs_background", package)
        self.assertEqual(package["mission_blueprint"], blueprint)
        cited_ids = {piece["id"] for piece in package["cited_sources"]}
        self.assertIn(blueprint["criteria"][0]["ref"], cited_ids)
        self.assertTrue({"K.exec.1", "N.unit"} <= cited_ids)
        pack_ids = {piece["id"] for piece in read_json(slot / "source_pack.json")["pieces"]}
        self.assertLess(len(cited_ids), len(pack_ids))  # 능력단위 전체를 주지 않는다
        self.assertEqual([e["exec_job_id"] for e in package["job_profile"]["work"]["exec_jobs"]], ["exec_001"])
        decisions = read_json(slot / "system_decisions.json")
        self.assertEqual(decisions["mission_design"]["mission_design_type"], "blueprint_two_stage")
        know_names = package["schema_constraints"]["material_rules"]["allowed_evidence_names"]
        self.assertTrue(1 <= len(know_names) <= 4)

    def test_hard_mock_run_has_two_tasks_in_blueprint_and_mission(self):
        summary = self.runner("hard").run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        slot = self.slot(summary, "hard")
        self.assertEqual(len(read_json(slot / "mission_blueprint_attempt_0.json")["tasks"]), 2)
        self.assertEqual(len(read_json(slot / "mission_output.json")["mission"]["tasks"]), 2)

    # ── 두 단계 생성에서는 일곱 형태를 연다(카드 제외) ──

    def test_two_stage_opens_seven_material_types_without_card(self):
        summary = self.runner().run()
        slot = self.slot(summary)
        every = list(TWO_STAGE_MATERIAL_TYPES)
        self.assertEqual((len(every), "card" in every), (7, False))
        decisions = read_json(slot / "system_decisions.json")
        self.assertEqual(decisions["allowed_material_types"], every)
        trace = [step for step in decisions["decision_trace"] if step["step"] == "select_allowed_material_types"]
        self.assertEqual((trace[-1]["method"], trace[-1]["selected"]), ("two_stage_types", every))
        self.assertEqual(read_json(slot / "blueprint_request.json")["allowed_material_types"], every)
        self.assertEqual(read_json(slot / "llm_input_package.json")["system_decisions"]["allowed_material_types"], every)
        self.assertEqual(read_json(slot / "generation_basis.json")["chain"][6]["values"]["allowed_material_types"], every)

    def check_types_follow_the_blueprint(self, difficulty: str, count: int):
        summary = self.runner(difficulty).run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        slot = self.slot(summary, difficulty)
        planned = [m["type"] for m in read_json(slot / "mission_blueprint_attempt_0.json")["materials"]]
        written = [m["type"] for m in read_json(slot / "mission_output.json")["mission"]["materials"]]
        self.assertEqual((len(planned), written), (count, planned))
        self.assertEqual(len(set(planned)), count)  # mock 설계서는 자료마다 다른 형태를 쓴다
        design = read_json(slot / "generation_basis.json")["chain"][4]["materials"]
        self.assertTrue(all(material["type_reason"] for material in design))
        self.assertEqual(read_json(slot / "mission_basis_check_attempt_0.json")["errors"], [])

    def test_easy_mock_run_follows_the_blueprint_type(self):
        self.check_types_follow_the_blueprint("easy", 1)  # 쉬움 난이도는 두 단계로 돌린 적이 없었다

    def test_normal_mock_run_follows_the_blueprint_types(self):
        self.check_types_follow_the_blueprint("normal", 2)

    def test_hard_mock_run_follows_the_blueprint_types(self):
        self.check_types_follow_the_blueprint("hard", 3)

    def test_hard_answer_length_is_three_to_five_sentences_in_two_stage_only(self):
        summary = self.runner("hard").run()
        slot = self.slot(summary, "hard")
        expected = "3-5 short sentences per task"
        self.assertEqual(read_json(slot / "system_decisions.json")["difficulty"]["answer_length_hint"], expected)
        self.assertEqual(read_json(slot / "blueprint_request.json")["difficulty"]["answer_length_hint"], expected)
        self.assertEqual(read_json(slot / "mission_output.json")["mission"]["difficulty"]["answer_length_hint"], expected)
        normal = read_json(self.slot(self.runner("normal").run()) / "system_decisions.json")
        self.assertNotEqual(normal["difficulty"]["answer_length_hint"], expected)
        plain = PilotRunner(
            output_root=f"{WORK_RELATIVE}/out_plain_hard", force_mock=True, concurrency=1, target_job_codes=[JOB_CD],
            target_difficulty_codes=["hard"], use_ncs_background=True, ncs_root=f"{WORK_RELATIVE}/ncs_jobs", ncs_units={JOB_CD: UNIT_KEY},
        ).run()
        old = read_json(self.slot(plain, "hard") / "system_decisions.json")["difficulty"]["answer_length_hint"]
        self.assertEqual(old, "2-4 short sentences per task")  # 두 단계가 아닌 경로는 그대로다

    def test_run_without_two_stage_keeps_its_material_types(self):
        # 두 단계가 아닌 NCS 경로는 예전 허용 형태(보통: 차트, 표)를 그대로 쓴다.
        runner = PilotRunner(
            output_root=f"{WORK_RELATIVE}/out_plain",
            force_mock=True,
            concurrency=1,
            target_job_codes=[JOB_CD],
            target_difficulty_codes=["normal"],
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            ncs_units={JOB_CD: UNIT_KEY},
        )
        summary = runner.run()
        decisions = read_json(self.slot(summary) / "system_decisions.json")
        self.assertEqual(decisions["allowed_material_types"], ["chart", "table"])
        self.assertNotIn("two_stage_types", [step.get("method") for step in decisions["decision_trace"]])

    def test_missing_unit_fails_instead_of_falling_back(self):
        summary = self.runner(unit_key="99999999:99").run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (0, 1))
        slot = self.slot(summary)
        self.assertEqual(read_json(slot / "run_status.json")["status"], "decision_failed")
        self.assertFalse((slot / "mission_output.json").exists())
        self.assertFalse((slot / "llm_input_package.json").exists())

    def test_blueprint_failure_stops_before_writer(self):
        runner = self.runner()
        runner.blueprint_designer = StubDesigner(broken_blueprint, broken_blueprint)
        writer_calls = []
        runner.draft_generator.generate = lambda package: writer_calls.append(package)
        summary = runner.run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (0, 1))
        slot = self.slot(summary)
        status = read_json(slot / "run_status.json")
        self.assertEqual(status["status"], "blueprint_failed")
        self.assertEqual(status["error"]["errors"][0]["code"], "BP_CRITERIA_COUNT")
        self.assertEqual((writer_calls, runner.blueprint_designer.calls), ([], 2))
        self.assertTrue((slot / "blueprint_check_attempt_1.json").exists())
        self.assertFalse((slot / "mission_output.json").exists())

    def test_blueprint_is_repaired_once(self):
        runner = self.runner()
        runner.blueprint_designer = StubDesigner(broken_blueprint, lambda request: MockBlueprintBuilder().build(request))
        summary = runner.run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        slot = self.slot(summary)
        self.assertFalse(read_json(slot / "blueprint_check_attempt_0.json")["passed"])
        self.assertTrue(read_json(slot / "blueprint_check_attempt_1.json")["passed"])
        self.assertEqual(read_json(slot / "generation_basis.json")["artifacts"]["blueprint"], "mission_blueprint_attempt_1.json")
        self.assertEqual(
            read_json(slot / "system_decisions.json")["mission_design"]["selection_reason"], "mission_blueprint_attempt_1.json"
        )

    def test_blueprint_call_failure_is_reported_with_its_code(self):
        runner = self.runner()
        runner.blueprint_designer = StubDesigner(None, call_errors=[{"code": "ANTHROPIC_TIMEOUT", "message": "t"}])
        summary = runner.run()
        status = read_json(self.slot(summary) / "run_status.json")
        self.assertEqual((status["status"], status["error"]["errors"][0]["code"]), ("blueprint_failed", "ANTHROPIC_TIMEOUT"))
        self.assertEqual(runner.blueprint_designer.calls, 1)

    def test_unmapped_rubric_is_sent_to_repair_and_then_discarded(self):
        runner = self.runner()

        def generate_without_map(package):
            draft = MockMissionDraftBuilder().build(package)
            draft["basis_map"] = {"rubric": []}
            call = {"provider": "mock", "model": "stub", "reasoning_effort": "medium", "status": "mocked", "usage": {}, "errors": []}
            return {"llm_call_result": call, "mission_draft": draft}

        runner.draft_generator.generate = generate_without_map
        summary = runner.run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (0, 1))
        slot = self.slot(summary)
        first = read_json(slot / "mission_basis_check_attempt_0.json")
        self.assertEqual([e["code"] for e in first["errors"]], ["BM_RUBRIC_UNMAPPED"])
        self.assertIn("BM_RUBRIC_UNMAPPED", [e["code"] for e in read_json(slot / "repair_request_attempt_1.json")["validator_errors"]])
        self.assertTrue((slot / "mission_basis_check_attempt_1.json").exists())
        self.assertFalse((slot / "generation_basis.json").exists())
        self.assertNotEqual(read_json(slot / "run_status.json")["status"], "saved")


if __name__ == "__main__":
    unittest.main()
