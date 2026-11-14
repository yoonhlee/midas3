# 최종 검토에서 나온 근거 기록 문제의 재현 테스트:
# 수정 호출이 설계서를 보는지, 다시 쓰기·수정 사실이 기록되는지, mock을 실제 모델로 적지 않는지, 카드 실패가 실행 요약을 막지 않는지.

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from basis_fixtures import JOB_CD, SCRATCH_ROOT, UNIT_KEY, sample_blueprint, sample_decisions, sample_mission, sample_ncs_job, sample_pack, sample_unit
from test_two_stage_runner import HAS_KNOW_DATA, read_json

from src.mission_generation import pilot_runner as pilot_runner_module
from src.mission_generation.basis_card_exporter import BasisCardExporter
from src.mission_generation.blueprint_checker import BlueprintChecker, MissionBasisChecker
from src.mission_generation.draft_generator import MockMissionDraftBuilder
from src.mission_generation.generation_basis import GenerationBasisAssembler
from src.mission_generation.pilot_runner import PilotRunner
from src.mission_generation.repair_manager import RepairPromptBuilder

OK_MAP = {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}, {"rubric_index": 1, "evaluation_basis_index": 0}]}
REAL_CALL = {"provider": "anthropic", "model": "claude-opus-5-5", "reasoning_effort": "medium"}
MOCK_CALL = {"provider": "mock", "model": "claude-opus-5-5", "reasoning_effort": "medium"}
CITED = [{"id": "N.c.2.1", "kind": "ncs_criterion", "text": "원문", "meta": {}}]
WORK = SCRATCH_ROOT / "review_fixes"
WORK_RELATIVE = "outputs/_pytest_basis/review_fixes"


def assemble(folder: Path, *, blueprint_call=REAL_CALL, writer_call=REAL_CALL, **extra) -> dict:
    mission, pack, blueprint, decisions = sample_mission(), sample_pack(folder), sample_blueprint(), sample_decisions()
    return GenerationBasisAssembler().assemble(
        final_mission=mission,
        source_pack=pack,
        blueprint=blueprint,
        blueprint_check=BlueprintChecker().check(blueprint=blueprint, source_pack=pack, system_decisions=decisions),
        basis_map=OK_MAP,
        basis_check=MissionBasisChecker().check(mission_draft=mission, basis_map=OK_MAP, blueprint=blueprint),
        system_decisions=decisions,
        blueprint_call=blueprint_call,
        writer_call=writer_call,
        artifacts={"mission": "mission_output.json"},
        **extra,
    )


class RepairRequestTest(unittest.TestCase):
    VALIDATION = {"errors": [{"code": "BM_RUBRIC_UNMAPPED"}], "warnings": []}

    def test_two_stage_repair_request_carries_blueprint_and_sources(self):
        request = RepairPromptBuilder().build(
            sample_decisions(), {"mission_id": "draft"}, self.VALIDATION, ["읽고 이해하기"], mission_blueprint=sample_blueprint(), cited_sources=CITED
        )
        self.assertEqual(request["mission_blueprint"], sample_blueprint())
        self.assertEqual(request["cited_sources"], CITED)
        rules = "\n".join(request["repair_rules"])
        self.assertIn("mission_blueprint", rules)
        self.assertIn("cited_sources", rules)
        self.assertIn("basis_map.rubric", rules)
        self.assertIn("system_decisions.difficulty", rules)

    def test_plain_repair_request_is_unchanged(self):
        request = RepairPromptBuilder().build(sample_decisions(), {"mission_id": "draft"}, self.VALIDATION, ["읽고 이해하기"])
        self.assertNotIn("mission_blueprint", request)
        self.assertNotIn("cited_sources", request)
        self.assertEqual(len(request["repair_rules"]), 19)
        self.assertNotIn("mission_blueprint", "\n".join(request["repair_rules"]))


class BasisProcessTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)

    def test_process_defaults_to_no_rewrite_and_no_repair(self):
        self.assertEqual(
            assemble(self.folder)["process"],
            {"blueprint_attempt": 0, "blueprint_rewritten": False, "repair_count": 0, "mission_repaired": False},
        )

    def test_process_records_rewrite_and_repair(self):
        self.assertEqual(
            assemble(self.folder, blueprint_attempt=1, repair_count=1)["process"],
            {"blueprint_attempt": 1, "blueprint_rewritten": True, "repair_count": 1, "mission_repaired": True},
        )

    def test_mock_calls_are_not_presented_as_a_real_model(self):
        basis = assemble(self.folder, blueprint_call=MOCK_CALL, writer_call=MOCK_CALL)
        self.assertEqual(basis["models"]["blueprint"]["provider"], "mock")
        self.assertEqual(basis["chain"][3]["decided_by"], "mock (API 호출 없음)")
        self.assertEqual(basis["chain"][4]["decided_by"], "mock (API 호출 없음)")
        self.assertEqual(basis["chain"][5]["decided_by"], "mock (API 호출 없음) · mock (API 호출 없음)")

    def test_mixed_mock_and_real_calls(self):
        basis = assemble(self.folder, blueprint_call=MOCK_CALL, writer_call=REAL_CALL)
        self.assertEqual(basis["chain"][5]["decided_by"], "mock (API 호출 없음) · claude-opus-5-5")

    def test_card_shows_process_and_mock(self):
        mission = sample_mission()
        card = BasisCardExporter().render_card(
            mission, assemble(self.folder, blueprint_call=MOCK_CALL, writer_call=MOCK_CALL, blueprint_attempt=1, repair_count=1)
        )
        self.assertIn("설계서 다시 쓰기 1회", card)
        self.assertIn("미션 수정 1회", card)
        self.assertIn("mock (API 호출 없음)", card)
        footer = card.split("<footer>")[1]
        self.assertNotIn("설계 모델 claude-opus-5-5", footer)

    def test_card_without_process_field_still_renders(self):
        basis = assemble(self.folder)
        del basis["process"]
        self.assertEqual(BasisCardExporter().render_card(sample_mission(), basis).count('<article class="step'), 7)


@unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 mock 전체 실행을 건너뛴다")
class TwoStageRepairRunTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        (WORK / "ncs_jobs").mkdir(parents=True, exist_ok=True)
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(
            json.dumps({**sample_ncs_job(), "units": [sample_unit()]}, ensure_ascii=False), encoding="utf-8"
        )

    def runner(self) -> PilotRunner:
        return PilotRunner(
            output_root=f"{WORK_RELATIVE}/out",
            force_mock=True,
            concurrency=1,
            target_job_codes=[JOB_CD],
            target_difficulty_codes=["normal"],
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            ncs_units={JOB_CD: UNIT_KEY},
            two_stage_basis=True,
        )

    def test_successful_repair_keeps_the_blueprint_in_view_and_is_recorded(self):
        runner = self.runner()
        seen = {}

        def generate_without_map(package):
            seen["package"] = package
            draft = MockMissionDraftBuilder().build(package)
            draft["basis_map"] = {"rubric": []}
            call = {"provider": "mock", "model": "writer-stub", "reasoning_effort": "medium", "status": "mocked", "usage": {}, "errors": []}
            return {"llm_call_result": call, "mission_draft": draft}

        def repair(*, repair_request, json_schema):
            seen["repair_request"] = repair_request
            seen["repair_schema"] = json_schema
            call = {"provider": "mock", "model": "repair-stub", "reasoning_effort": "medium", "status": "mocked", "usage": {}, "errors": []}
            return {"llm_call_result": call, "mission_draft": MockMissionDraftBuilder().build(seen["package"])}

        runner.draft_generator.generate = generate_without_map
        runner.repair_manager.repair = repair
        summary = runner.run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        slot = Path(summary["run_dir"]) / "jobs" / JOB_CD / "normal"
        request = seen["repair_request"]
        self.assertEqual(request["mission_blueprint"], read_json(slot / "mission_blueprint_attempt_0.json"))
        self.assertEqual(request["cited_sources"], seen["package"]["cited_sources"])
        self.assertIn("basis_map", request["mission_output_draft"])
        self.assertIn("basis_map", seen["repair_schema"]["properties"])
        basis = read_json(slot / "generation_basis.json")
        self.assertEqual(
            basis["process"], {"blueprint_attempt": 0, "blueprint_rewritten": False, "repair_count": 1, "mission_repaired": True}
        )
        self.assertEqual(basis["models"]["writer"]["requested_model"], "repair-stub")
        self.assertNotIn("basis_map", read_json(slot / "mission_output.json"))

    def test_card_export_failure_does_not_lose_the_run_summary(self):
        class BrokenExporter:
            def export(self, run_dir):
                raise RuntimeError("card rendering broke")

        with mock.patch.object(pilot_runner_module, "BasisCardExporter", BrokenExporter):
            summary = self.runner().run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        self.assertEqual(summary["basis_cards"], [])
        self.assertIn("card rendering broke", summary["basis_cards_error"])
        saved = read_json(Path(summary["run_dir"]) / "pilot_summary.json")
        self.assertEqual((saved["saved_count"], saved["basis_cards_error"]), (1, summary["basis_cards_error"]))


if __name__ == "__main__":
    unittest.main()
