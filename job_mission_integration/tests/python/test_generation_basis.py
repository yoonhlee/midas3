# 근거 기록(generation_basis.v1) 조립을 확인한다.

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from basis_fixtures import CRITERION, EXEC_TEXT, JOB_CD, sample_blueprint, sample_decisions, sample_mission, sample_pack, sample_unit, sample_unit_v03

from src.mission_generation.blueprint_checker import BlueprintChecker, MissionBasisChecker
from src.mission_generation.generation_basis import GenerationBasisAssembler

OK_MAP = {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}, {"rubric_index": 1, "evaluation_basis_index": 0}]}
ARTIFACTS = {"source_pack": "source_pack.json", "blueprint": "mission_blueprint_attempt_0.json", "mission": "mission_output.json"}
BLUEPRINT_CALL = {
    "provider": "anthropic",
    "model": "claude-opus-5-5",
    "reasoning_effort": "medium",
    "served_model": "claude-opus-4-8",
    "fallback_used": True,
}
WRITER_CALL = {"provider": "anthropic", "model": "claude-opus-5-5", "reasoning_effort": "medium"}


class GenerationBasisTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)

    def assemble(self, *, mission=None, pack=None, blueprint=None, basis_map=OK_MAP) -> dict:
        mission = sample_mission() if mission is None else mission
        pack = sample_pack(self.folder) if pack is None else pack
        blueprint = sample_blueprint() if blueprint is None else blueprint
        decisions = sample_decisions()
        return GenerationBasisAssembler().assemble(
            final_mission=mission,
            source_pack=pack,
            blueprint=blueprint,
            blueprint_check=BlueprintChecker().check(blueprint=blueprint, source_pack=pack, system_decisions=decisions),
            basis_map=basis_map,
            basis_check=MissionBasisChecker().check(mission_draft=mission, basis_map=basis_map, blueprint=blueprint),
            system_decisions=decisions,
            blueprint_call=BLUEPRINT_CALL,
            writer_call=WRITER_CALL,
            artifacts=ARTIFACTS,
        )

    def test_header(self):
        basis = self.assemble()
        self.assertEqual((basis["schema_version"], basis["mode"]), ("generation_basis.v1", "two_stage"))
        self.assertEqual((basis["mission_id"], basis["job_cd"], basis["difficulty"]), ("mission_K000000918_normal_001", JOB_CD, "normal"))
        self.assertEqual(basis["artifacts"], ARTIFACTS)
        self.assertTrue(basis["generated_at"])
        json.dumps(basis, ensure_ascii=False)

    def test_chain_has_seven_typed_steps(self):
        chain = self.assemble()["chain"]
        self.assertEqual([s["step"] for s in chain], [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(
            [s["kind"] for s in chain],
            ["data", "data", "link_decision", "ai_decision", "ai_decision", "ai_decision", "rule"],
        )
        self.assertEqual(
            [s["title"] for s in chain],
            [
                "직업 → 하는 일 문장",
                "직업 → NCS 직무",
                "문장 → 능력단위",
                "능력단위 → 수행준거",
                "수행준거·서류 → 자료·과제",
                "평가 지침·KNOW 항목 → 채점 기준",
                "난이도 규칙",
            ],
        )

    @staticmethod
    def unit_without(*keys: str) -> dict:
        unit = sample_unit()
        for key in keys:
            unit["link"].pop(key, None)
        return unit

    def test_link_step_names_the_criteria_when_judged_by_is_absent(self):
        # 판단한 주체(judged_by)와 판단한 날(judged_at) 칸이 없는 자료에서는 기준으로 채운다.
        basis = self.assemble(pack=sample_pack(self.folder, unit=self.unit_without("judged_by", "judged_at")))
        self.assertEqual(basis["chain"][2]["decided_by"], "연결 판단 · 기준 v0.1")
        # 판단한 날 칸이 있는 자료에서는 그 값도 붙인다.
        basis = self.assemble(pack=sample_pack(self.folder, unit=self.unit_without("judged_by")))
        self.assertEqual(basis["chain"][2]["decided_by"], "연결 판단 · 기준 v0.1 · 판단한 날")

    def test_link_step_keeps_judged_by_when_present(self):
        self.assertEqual(self.assemble()["chain"][2]["decided_by"], "시범 판단자")

    def test_link_step_falls_back_to_a_plain_label(self):
        basis = self.assemble(pack=sample_pack(self.folder, unit=self.unit_without("judged_by", "criteria", "judged_at")))
        self.assertEqual(basis["chain"][2]["decided_by"], "연결 판단")

    def test_data_steps_quote_sources(self):
        chain = self.assemble()["chain"]
        self.assertEqual(chain[0]["sources"][0]["text"], EXEC_TEXT)
        self.assertEqual(chain[0]["sources"][0]["locator"]["field"], "jobsDo.execJob")
        self.assertEqual(chain[0]["decided_by"], "실행 대상 지정")
        self.assertEqual([s["id"] for s in chain[1]["sources"]], ["K.keco", "L.1"])  # 직무가 맞는 행만
        self.assertIn("NCS–KECO 연계표", chain[1]["link_table"]["label"])
        self.assertEqual((chain[2]["match"], chain[2]["decided_by"], chain[2]["criteria"]), ("직접", "시범 판단자", "v0.1"))
        self.assertIn("수출통관의 서류작성", chain[2]["reason"])
        self.assertEqual([s["id"] for s in chain[2]["sources"]], ["M.1", "N.unit"])
        self.assertEqual(set(chain[0]["sources"][0]), {"id", "kind", "text", "locator"})

    def test_criterion_and_borrowed_terms(self):
        chain = self.assemble()["chain"]
        item = chain[3]["items"][0]
        self.assertEqual((item["ref"], item["text"], item["element_name"]), ("N.c.2.1", CRITERION, "수출신고서 작성하기"))
        self.assertIn("서식 칸", item["reason"])
        self.assertEqual(chain[3]["decided_by"], "claude-opus-4-8")  # 실제로 응답한 설계 모델
        material = chain[4]["materials"][0]
        self.assertEqual((material["slot"], material["material_id"], material["material_title"]), (1, "mat_001", "이번 수출 건의 확정 내용"))
        self.assertEqual(
            [(t["term"], t["in_source"], t["in_mission"]) for t in material["borrowed_terms"]],
            [("신고자 상호", True, True), ("수출신고가격", True, True), ("환급신청인", True, True)],
        )
        self.assertEqual(material["refs"][0]["text"], CRITERION)
        self.assertEqual(chain[4]["focus"]["focus_phrase"], "세관 신고서류를 작성")
        self.assertEqual((chain[4]["tasks"][0]["slot"], chain[4]["tasks"][0]["task_id"]), (1, "task_001"))
        self.assertEqual(chain[4]["glossary"], [{"term": "수출신고서", "ref": "N.c.2.1", "in_mission": True}])

    def test_term_absent_from_mission_is_marked(self):
        mission = sample_mission()
        mission["mission"]["materials"][0]["data"]["rows"].pop()
        terms = self.assemble(mission=mission)["chain"][4]["materials"][0]["borrowed_terms"]
        self.assertEqual([(t["term"], t["in_mission"]) for t in terms][-1], ("환급신청인", False))

    def test_rubric_items_follow_basis_map(self):
        items = self.assemble()["chain"][5]["items"]
        self.assertEqual([(i["rubric_index"], i["evaluation_basis_index"]) for i in items], [(0, 0), (1, 0)])
        self.assertEqual((items[0]["criterion"], items[0]["points"]), ("항목 대조", 50))
        self.assertEqual(items[0]["refs"][0]["text"], "수출신고서 작성능력")
        self.assertEqual(items[0]["know_refs"][0]["text"], "읽고 이해하기")
        self.assertIn("다른 칸", items[0]["what_to_check"])
        self.assertEqual(self.assemble()["chain"][5]["decided_by"], "claude-opus-4-8 · claude-opus-5-5")

    def test_design_step_carries_why_each_type_was_chosen(self):
        materials = self.assemble()["chain"][4]["materials"]
        self.assertEqual(materials[0]["type_reason"], "수출신고서의 구성항목을 항목별로 적은 서식이라 표로 보인다")
        self.assertEqual(materials[1]["type_reason"], "같은 서식의 초안이라 같은 표로 보인다")

    def test_design_step_of_an_old_blueprint_has_no_type_reason(self):
        blueprint = sample_blueprint()
        for material in blueprint["materials"]:
            material.pop("type_reason")
        materials = self.assemble(blueprint=blueprint)["chain"][4]["materials"]
        self.assertTrue(all("type_reason" not in material for material in materials))

    def test_rule_step_values(self):
        step = self.assemble()["chain"][6]
        self.assertEqual(step["decided_by"], "시스템 결정")
        self.assertEqual(
            step["values"],
            {
                "level": "normal",
                "material_count_range": [2, 2],
                "task_count_range": [1, 1],
                "answer_length_hint": "2-3 short sentences",
                "allowed_material_types": ["chart", "table"],
            },
        )

    def test_models_record_served_model_and_fallback(self):
        basis = self.assemble()
        self.assertEqual(
            basis["models"]["blueprint"],
            {
                "provider": "anthropic",
                "requested_model": "claude-opus-5-5",
                "served_model": "claude-opus-4-8",
                "reasoning_effort": "medium",
                "fallback_used": True,
                "structured_output": None,
            },
        )
        self.assertEqual((basis["models"]["writer"]["served_model"], basis["models"]["writer"]["fallback_used"]), ("claude-opus-5-5", False))

    def test_versions(self):
        self.assertEqual(
            self.assemble()["versions"],
            {
                "blueprint_prompt": "blueprint-v13",
                "writer_prompt": "blueprint-writer-v11",
                "ncs_cl_cd": "0204030210_24v3",
                "link_table_file": sample_pack(self.folder)["link_table"]["file"],
                "know_source_root": "data/api_raw",
            },
        )

    def test_warnings_are_collected(self):
        mission = sample_mission()
        mission["mission"]["scenario"]["glossary"] = []
        checks = self.assemble(mission=mission)["checks"]
        self.assertEqual(checks["error_count"], 0)
        self.assertEqual([i["code"] for i in checks["items"]], ["BP_COVERAGE_PARTIAL", "BM_GLOSSARY_MISSING"])
        self.assertEqual(checks["warning_count"], 2)

    def test_missing_link_piece_leaves_step3_empty_but_valid(self):
        unit = sample_unit()
        del unit["link"]
        basis = self.assemble(pack=sample_pack(self.folder, unit=unit))
        step = basis["chain"][2]
        self.assertEqual((step["decided_by"], step["match"], step["reason"]), (None, None, None))
        self.assertEqual([s["id"] for s in step["sources"]], ["N.unit"])
        self.assertEqual(basis["checks"]["items"][0]["code"], "SP_LINK_REASON_MISSING")

    def test_step3_carries_phrase_verdict_and_criteria_text(self):
        step = self.assemble(pack=sample_pack(self.folder, unit=sample_unit_v03()))["chain"][2]
        self.assertEqual((step["phrase"], step["verdict"], step["criteria"]), ("세관 신고서류를 작성", "확정", "v0.3"))
        self.assertEqual(step["verdict_reason"], "수출신고서 항목 작성이 신고서류 작성 그대로다")
        self.assertEqual(
            step["criteria_refs"],
            [{"number": "2.1", "ref": "N.c.2.1", "text": CRITERION, "element_name": "수출신고서 작성하기"}],
        )

    def test_step4_says_whether_each_criterion_is_in_the_link_basis(self):
        blueprint = sample_blueprint()
        blueprint["criteria"].append({"ref": "N.c.1.1", "reason": "준비 단계도 함께 본다"})
        step = self.assemble(pack=sample_pack(self.folder, unit=sample_unit_v03()), blueprint=blueprint)["chain"][3]
        self.assertEqual([(item["ref"], item["in_link_basis"]) for item in step["items"]], [("N.c.2.1", True), ("N.c.1.1", False)])

    def test_step4_of_old_link_has_no_link_basis_flag(self):
        for item in self.assemble()["chain"][3]["items"]:
            self.assertNotIn("in_link_basis", item)

    def test_step3_of_old_link_has_no_new_keys(self):
        step = self.assemble()["chain"][2]
        for key in ("phrase", "verdict", "verdict_reason", "criteria_refs"):
            self.assertNotIn(key, step)

    def test_step3_unknown_criteria_ref_keeps_number_without_text(self):
        unit = sample_unit_v03()
        unit["link"]["criteria_refs"] = ["2.1", "9.9"]
        basis = self.assemble(pack=sample_pack(self.folder, unit=unit))
        self.assertEqual(
            basis["chain"][2]["criteria_refs"][1],
            {"number": "9.9", "ref": "N.c.9.9", "text": None, "element_name": None},
        )
        self.assertIn("SP_LINK_CRITERIA_REF_UNKNOWN", [item["code"] for item in basis["checks"]["items"]])

    def test_inputs_are_not_modified(self):
        mission, blueprint = sample_mission(), sample_blueprint()
        before = copy.deepcopy((mission, blueprint))
        self.assemble(mission=mission, blueprint=blueprint)
        self.assertEqual((mission, blueprint), before)


if __name__ == "__main__":
    unittest.main()
