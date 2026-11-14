# 설계서 검사(BlueprintChecker)와 미션 뒤 검사(MissionBasisChecker)를 코드별로 확인한다.

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Callable

from basis_fixtures import sample_blueprint, sample_decisions, sample_mission, sample_pack, sample_unit_v03

from src.mission_generation.blueprint_checker import BlueprintChecker, MissionBasisChecker
from src.mission_generation.blueprint_designer import TWO_STAGE_MATERIAL_TYPES


class BlueprintCheckerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as folder:
            cls.pack = sample_pack(Path(folder))

    def check(self, mutate: Callable[[dict], None] | None = None, level: str = "normal") -> dict:
        blueprint = sample_blueprint()
        if mutate is not None:
            mutate(blueprint)
        return BlueprintChecker().check(blueprint=blueprint, source_pack=self.pack, system_decisions=sample_decisions(level))

    def codes(self, mutate: Callable[[dict], None] | None = None, level: str = "normal") -> tuple[set, set]:
        result = self.check(mutate, level)
        return {e["code"] for e in result["errors"]}, {w["code"] for w in result["warnings"]}

    def test_sample_passes_with_partial_coverage_warning(self):
        result = self.check()
        self.assertTrue(result["passed"])
        self.assertEqual(self.codes(), (set(), {"BP_COVERAGE_PARTIAL"}))
        self.assertEqual((result["schema_version"], result["attempt"]), ("blueprint_check.v1", 0))

    def linked_codes(self, criterion_ref: str) -> set:
        """연결 판단이 수행준거 2.1을 근거로 든 자료 묶음에서, 설계서가 criterion_ref를 골랐을 때의 경고."""

        blueprint = sample_blueprint()
        blueprint["criteria"][0]["ref"] = criterion_ref
        with tempfile.TemporaryDirectory() as folder:
            pack = sample_pack(Path(folder), unit=sample_unit_v03())
        result = BlueprintChecker().check(blueprint=blueprint, source_pack=pack, system_decisions=sample_decisions())
        self.assertTrue(result["passed"])
        return {w["code"] for w in result["warnings"]}

    def test_criteria_outside_the_link_basis_are_warned_about(self):
        self.assertIn("BP_LINK_CRITERIA_UNUSED", self.linked_codes("N.c.1.1"))

    def test_criteria_from_the_link_basis_are_not_warned_about(self):
        self.assertNotIn("BP_LINK_CRITERIA_UNUSED", self.linked_codes("N.c.2.1"))

    def test_old_link_without_refs_is_never_warned_about(self):
        def mutate(b):
            b["criteria"][0]["ref"] = "N.c.1.1"

        self.assertNotIn("BP_LINK_CRITERIA_UNUSED", self.codes(mutate)[1])

    def test_full_coverage_has_no_warning(self):
        def mutate(b):
            b["focus"]["coverage"] = "full"

        self.assertEqual(self.codes(mutate), (set(), set()))

    def test_unknown_ref(self):
        def mutate(b):
            b["criteria"][0]["ref"] = "N.c.9.9"

        self.assertIn("BP_REF_UNKNOWN", self.codes(mutate)[0])

    def test_ref_to_piece_not_given_to_model(self):
        for record_only in ("L.1", "M.1", "K.keco"):
            with self.subTest(ref=record_only):
                def mutate(b, ref=record_only):
                    b["materials"][0]["refs"] = [ref]

                self.assertEqual(self.codes(mutate)[0], {"BP_REF_UNKNOWN"})

    def test_focus_must_be_target_sentence(self):
        def mutate(b):
            b["focus"]["exec_ref"] = "K.sum"

        self.assertIn("BP_FOCUS_EXEC_MISMATCH", self.codes(mutate)[0])

    def test_focus_phrase_must_be_verbatim(self):
        def wrong(b):
            b["focus"]["focus_phrase"] = "세관 신고서를 작성"

        def spaced(b):
            b["focus"]["focus_phrase"] = "세관  신고서류를\n작성"

        self.assertEqual(self.codes(wrong)[0], {"BP_FOCUS_NOT_IN_SENTENCE"})
        self.assertEqual(self.codes(spaced)[0], set())

    def test_criteria_count_and_kind(self):
        def none(b):
            b["criteria"] = []

        def three(b):
            b["criteria"] = [{"ref": "N.c.2.1", "reason": "r"}, {"ref": "N.c.1.1", "reason": "r"}, {"ref": "N.c.2.1", "reason": "r"}]

        def wrong_kind(b):
            b["criteria"][0]["ref"] = "N.doc.1"

        self.assertEqual(self.codes(none)[0], {"BP_CRITERIA_COUNT"})
        self.assertEqual(self.codes(three)[0], {"BP_CRITERIA_COUNT"})
        self.assertEqual(self.codes(wrong_kind)[0], {"BP_CRITERIA_KIND"})

    def test_material_count_type_and_slots(self):
        def one(b):
            b["materials"] = b["materials"][:1]

        def gap(b):
            b["materials"][1]["slot"] = 3

        def bad_type(b):
            b["materials"][1]["type"] = "memo"

        self.assertEqual(self.codes(one)[0], {"BP_MATERIAL_COUNT"})
        self.assertEqual(self.codes(gap)[0], {"BP_MATERIAL_COUNT"})
        self.assertEqual(self.codes(bad_type)[0], {"BP_MATERIAL_TYPE"})

    def hard_blueprint(self, types: list[str]) -> dict:
        """어려움 난이도(자료 3개, 과제 2개)에 맞춘 설계서."""

        blueprint = sample_blueprint()
        blueprint["materials"].append({**blueprint["materials"][1], "slot": 3})
        blueprint["tasks"].append({**blueprint["tasks"][0], "slot": 2})
        for material, kind in zip(blueprint["materials"], types):
            material["type"] = kind
        return blueprint

    def hard_codes(self, types: list[str]) -> set:
        decisions = sample_decisions("hard")
        decisions["allowed_material_types"] = list(TWO_STAGE_MATERIAL_TYPES)
        result = BlueprintChecker().check(blueprint=self.hard_blueprint(types), source_pack=self.pack, system_decisions=decisions)
        return {e["code"] for e in result["errors"]}

    def test_three_materials_need_at_least_two_types(self):
        # 어려움 난이도: 자료 3개가 모두 같은 형태면 다시 쓰게 한다.
        self.assertEqual(self.hard_codes(["table", "table", "table"]), {"BP_MATERIAL_TYPES_SAME"})
        self.assertEqual(self.hard_codes(["memo", "table", "table"]), set())
        self.assertEqual(self.hard_codes(["email", "log", "schedule"]), set())

    def test_card_is_not_a_two_stage_material_type(self):
        # 두 단계 생성의 허용 형태에 카드가 없으므로, 설계서가 카드를 계획하면 다시 쓰게 한다.
        decisions = sample_decisions()
        decisions["allowed_material_types"] = list(TWO_STAGE_MATERIAL_TYPES)
        blueprint = sample_blueprint()
        blueprint["materials"][1]["type"] = "card"
        result = BlueprintChecker().check(blueprint=blueprint, source_pack=self.pack, system_decisions=decisions)
        self.assertEqual({e["code"] for e in result["errors"]}, {"BP_MATERIAL_TYPE"})

    def test_two_materials_of_one_type_are_allowed(self):
        # 보통 난이도는 표 두 개도 허용한다(기본 설계서가 그렇다).
        self.assertNotIn("BP_MATERIAL_TYPES_SAME", self.codes()[0])

    def test_task_count_follows_difficulty(self):
        errors, _ = self.codes(level="hard")  # 어려움은 자료 3개, 과제 2개
        self.assertEqual(errors, {"BP_MATERIAL_COUNT", "BP_TASK_COUNT"})

    def test_missing_refs(self):
        for section in ("materials", "tasks", "evaluation_basis"):
            with self.subTest(section=section):
                def mutate(b, section=section):
                    b[section][0]["refs"] = []

                self.assertEqual(self.codes(mutate)[0], {"BP_MISSING_REFS"})

    def test_empty_evaluation_basis_is_missing_refs(self):
        def mutate(b):
            b["evaluation_basis"] = []

        self.assertIn("BP_MISSING_REFS", self.codes(mutate)[0])

    def test_term_must_be_in_cited_piece(self):
        def term(b):
            b["materials"][0]["borrowed_terms"][1]["term"] = "수입신고가격"

        def glossary(b):
            b["glossary_terms"][0]["term"] = "원산지"

        self.assertEqual(self.codes(term)[0], {"BP_TERM_NOT_IN_SOURCE"})
        self.assertEqual(self.codes(glossary)[0], {"BP_TERM_NOT_IN_SOURCE"})

    def test_term_with_different_spacing_passes(self):
        def mutate(b):
            b["materials"][0]["borrowed_terms"][0]["term"] = "신고자  상호"

        self.assertEqual(self.codes(mutate)[0], set())

    def test_know_refs_kind_and_count(self):
        def wrong_kind(b):
            b["evaluation_basis"][0]["know_refs"] = ["N.eval.3"]

        def too_many(b):
            b["evaluation_basis"][0]["know_refs"] = ["K.act.1", "K.act.2", "K.abil.1", "K.abil.2", "K.know.1"]

        def none(b):
            b["evaluation_basis"][0]["know_refs"] = []

        self.assertEqual(self.codes(wrong_kind)[0], {"BP_KNOW_REF_KIND"})
        self.assertEqual(self.codes(too_many)[0], {"BP_KNOW_REF_KIND"})
        self.assertEqual(self.codes(none)[0], {"BP_KNOW_REF_KIND"})

    def test_few_borrowed_terms_is_warning_only(self):
        def mutate(b):
            b["materials"][0]["borrowed_terms"] = b["materials"][0]["borrowed_terms"][:1]

        errors, warnings = self.codes(mutate)
        self.assertEqual(errors, set())
        self.assertIn("BP_FEW_BORROWED_TERMS", warnings)

    def test_result_shape(self):
        def mutate(b):
            b["criteria"] = []

        result = self.check(mutate)
        self.assertFalse(result["passed"])
        self.assertEqual(
            set(result["errors"][0]),
            {"path", "severity", "code", "message", "required_fix", "repairable"},
        )
        self.assertTrue(result["errors"][0]["repairable"])

    def test_malformed_blueprint_reports_errors_instead_of_raising(self):
        result = BlueprintChecker().check(blueprint={}, source_pack=self.pack, system_decisions=sample_decisions())
        self.assertFalse(result["passed"])
        self.assertTrue({"BP_FOCUS_EXEC_MISMATCH", "BP_CRITERIA_COUNT", "BP_MATERIAL_COUNT", "BP_TASK_COUNT"} <= {e["code"] for e in result["errors"]})


class MissionBasisCheckerTest(unittest.TestCase):
    OK_MAP = {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}, {"rubric_index": 1, "evaluation_basis_index": 0}]}

    def check(self, *, mission=None, basis_map="default", blueprint=None) -> dict:
        return MissionBasisChecker().check(
            mission_draft=sample_mission() if mission is None else mission,
            basis_map=self.OK_MAP if basis_map == "default" else basis_map,
            blueprint=sample_blueprint() if blueprint is None else blueprint,
        )

    @staticmethod
    def codes(result: dict) -> tuple[set, set]:
        return {e["code"] for e in result["errors"]}, {w["code"] for w in result["warnings"]}

    def test_sample_passes(self):
        result = self.check()
        self.assertTrue(result["passed"])
        self.assertEqual(self.codes(result), (set(), set()))
        self.assertEqual(result["schema_version"], "mission_basis_check.v1")

    def test_missing_or_partial_map(self):
        cases = {
            "none": None,
            "one_entry": {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}]},
            "out_of_range": {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}, {"rubric_index": 1, "evaluation_basis_index": 5}]},
            "duplicate": {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}] * 2 + [{"rubric_index": 1, "evaluation_basis_index": 0}]},
        }
        for name, basis_map in cases.items():
            with self.subTest(case=name):
                result = self.check(basis_map=basis_map)
                self.assertFalse(result["passed"])
                self.assertEqual(self.codes(result)[0], {"BM_RUBRIC_UNMAPPED"})
        self.assertIn("between 0 and 0", self.check(basis_map=None)["errors"][0]["required_fix"])

    def test_slot_count_mismatch(self):
        mission = sample_mission()
        mission["mission"]["materials"] = mission["mission"]["materials"][:1]
        self.assertEqual(self.codes(self.check(mission=mission))[0], {"BM_SLOT_COUNT_MISMATCH"})

    def test_material_type_must_follow_the_blueprint(self):
        # 설계서가 정한 형태와 다른 형태로 쓰면 근거 기록의 형태 설명이 거짓이 되므로 고치게 한다.
        mission = sample_mission()
        mission["mission"]["materials"][1]["type"] = "memo"
        result = self.check(mission=mission)
        self.assertEqual(self.codes(result)[0], {"BM_MATERIAL_TYPE_MISMATCH"})
        self.assertIn("slot 2", result["errors"][0]["message"])
        self.assertIn("table", result["errors"][0]["required_fix"])

    def test_checklist_issue_mark_is_warned_about(self):
        # 체크리스트의 '주의 필요' 표시는 화면에 그대로 보여 답을 알려 줄 수 있다. 경고로 남긴다.
        def checklist(status: str) -> dict:
            mission, blueprint = sample_mission(), sample_blueprint()
            blueprint["materials"][1]["type"] = "checklist"
            mission["mission"]["materials"][1].update(
                {"type": "checklist", "data": {"items": [{"label": "수출신고가격을 적었다", "status": status, "importance": "high"}]}}
            )
            return self.check(mission=mission, blueprint=blueprint)

        flagged = checklist("issue")
        self.assertTrue(flagged["passed"])
        self.assertEqual(self.codes(flagged)[1], {"BM_CHECKLIST_ISSUE_MARK"})
        self.assertEqual(self.codes(checklist("unchecked")), (set(), set()))

    def test_unused_basis_is_warning(self):
        blueprint = sample_blueprint()
        blueprint["evaluation_basis"].append(dict(blueprint["evaluation_basis"][0]))
        result = self.check(blueprint=blueprint)
        self.assertTrue(result["passed"])
        self.assertEqual(self.codes(result), (set(), {"BM_BASIS_UNUSED"}))

    def test_term_missing_in_mission_is_warning(self):
        mission = sample_mission()
        mission["mission"]["materials"][0]["data"]["rows"].pop()  # '환급신청인' 줄을 지운다
        result = self.check(mission=mission)
        self.assertTrue(result["passed"])
        self.assertEqual(self.codes(result), (set(), {"BM_TERM_NOT_IN_MISSION"}))
        self.assertIn("환급신청인", result["warnings"][0]["message"])

    def test_glossary_missing_is_warning(self):
        mission = sample_mission()
        mission["mission"]["scenario"]["glossary"] = []
        result = self.check(mission=mission)
        self.assertTrue(result["passed"])
        self.assertEqual(self.codes(result), (set(), {"BM_GLOSSARY_MISSING"}))


if __name__ == "__main__":
    unittest.main()
