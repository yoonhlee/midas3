# 설계서로 미션을 쓰는 갈래: basis_map 형식, 입력 꾸러미, 프롬프트, mock 초안을 확인한다.

from __future__ import annotations

import copy
import json
import unittest

from basis_fixtures import CRITERION, sample_blueprint, sample_profile

from src.mission_generation.basis_source_pack import writer_job_profile
from src.mission_generation.blueprint_designer import TWO_STAGE_MATERIAL_TYPES
from src.mission_generation.draft_generator import (
    WRITER_PROMPT_VERSION,
    LLMInputPackageBuilder,
    MockMissionDraftBuilder,
    PromptBuilder,
)
from src.mission_generation.ncs_background_loader import NcsBackgroundLoader
from src.mission_generation.schema_constraints_builder import SchemaConstraintsBuilder
from src.mission_generation.system_decision_builder import SystemDecisionBuilder
from src.mission_generation.validator import MissionValidator

KNOW_NAMES = ["읽고 이해하기"]
CITED = [{"id": "N.c.2.1", "kind": "ncs_criterion", "text": CRITERION, "meta": {"element_name": "수출신고서 작성하기"}}]


def decisions_for(level: str) -> dict:
    """실제 결정 생성기로 만든 시스템 결정(NCS 모드의 어려움 완화 포함)."""

    decisions = SystemDecisionBuilder().build(sample_profile(), level, {"preferred_exec_job_id": "exec_001"})
    decisions["difficulty"].update(NcsBackgroundLoader.difficulty_overrides(level))
    return decisions


def blueprint_package(level: str = "normal") -> dict:
    return LLMInputPackageBuilder().build(
        writer_job_profile(sample_profile(), "exec_001", KNOW_NAMES),
        decisions_for(level),
        SchemaConstraintsBuilder().build(evidence_names=KNOW_NAMES, include_basis_map=True),
        mission_blueprint=sample_blueprint(),
        cited_sources=CITED,
    )


class BasisMapSchemaTest(unittest.TestCase):
    def test_basis_map_schema_only_when_requested(self):
        off = SchemaConstraintsBuilder().build(evidence_names=KNOW_NAMES)
        on = SchemaConstraintsBuilder().build(evidence_names=KNOW_NAMES, include_basis_map=True)
        self.assertNotIn("basis_map", off["structured_output_schema"]["properties"])
        self.assertNotIn("basis_map_required", off)
        self.assertNotIn("basis_map", off["required_top_level_fields"])
        self.assertIn("basis_map", on["structured_output_schema"]["required"])
        self.assertIn("basis_map", on["required_top_level_fields"])
        self.assertIs(on["basis_map_required"], True)
        self.assertEqual(
            on["structured_output_schema"]["properties"]["basis_map"],
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["rubric"],
                "properties": {
                    "rubric": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["rubric_index", "evaluation_basis_index"],
                            "properties": {
                                "rubric_index": {"type": "integer"},
                                "evaluation_basis_index": {"type": "integer"},
                            },
                        },
                    }
                },
            },
        )

    def test_default_build_is_unchanged(self):
        self.assertEqual(
            SchemaConstraintsBuilder().build(evidence_names=["a"]),
            SchemaConstraintsBuilder().build(evidence_names=["a"], include_basis_map=False),
        )

    def test_basis_map_does_not_touch_the_rest_of_the_schema(self):
        off = SchemaConstraintsBuilder().build(evidence_names=KNOW_NAMES)["structured_output_schema"]
        on = SchemaConstraintsBuilder().build(evidence_names=KNOW_NAMES, include_basis_map=True)["structured_output_schema"]
        trimmed = copy.deepcopy(on)
        trimmed["properties"].pop("basis_map")
        trimmed["required"].remove("basis_map")
        self.assertEqual(trimmed, off)


class WriterPackageAndPromptTest(unittest.TestCase):
    def test_writer_prompt_version(self):
        self.assertEqual(WRITER_PROMPT_VERSION, "blueprint-writer-v11")

    def test_package_carries_blueprint_and_cited_sources(self):
        package = blueprint_package()
        self.assertEqual(package["mission_blueprint"], sample_blueprint())
        self.assertEqual(package["cited_sources"], CITED)
        plain = LLMInputPackageBuilder().build(sample_profile(), decisions_for("normal"), SchemaConstraintsBuilder().build())
        self.assertNotIn("mission_blueprint", plain)
        self.assertNotIn("cited_sources", plain)

    def test_blueprint_branch_prompt(self):
        user = PromptBuilder().draft_prompts(blueprint_package())["user"]
        self.assertIn("Blueprint requirements:", user)
        self.assertIn("Fill basis_map.rubric", user)
        self.assertIn("Use each borrowed_terms term of a material exactly as written", user)
        self.assertNotIn("NCS background requirements:", user)
        self.assertNotIn("Blueprint hard-level overrides", user)
        payload = json.loads(user.split("llm_input_package:\n", 1)[1])
        self.assertEqual(payload["mission_blueprint"]["focus"]["focus_phrase"], "세관 신고서류를 작성")
        self.assertEqual(payload["cited_sources"][0]["id"], "N.c.2.1")
        self.assertNotIn("structured_output_schema", payload["schema_constraints"])
        self.assertEqual([e["exec_job_id"] for e in payload["job_profile"]["work"]["exec_jobs"]], ["exec_001"])

    def test_writer_leaves_out_a_term_that_does_not_fit(self):
        # 빌려 온 용어가 자료 내용과 맞지 않으면 억지로 넣지 않고 뺀다(검사에는 경고로 남는다).
        user = PromptBuilder().draft_prompts(blueprint_package())["user"]
        self.assertIn("as the name of something the material really shows", user)
        self.assertIn("leave that term out instead of forcing it", user)

    def test_writer_keeps_answer_hints_out_of_materials(self):
        # 자료는 사실과 기준만 담고, 어느 칸이 틀렸는지나 어느 것이 답인지는 적지 않는다.
        for level in ("normal", "hard"):
            with self.subTest(level=level):
                user = PromptBuilder().draft_prompts(blueprint_package(level))["user"]
                self.assertIn("Materials are workplace documents and data, not hints", user)
                self.assertIn("fill it with neutral facts", user)
                self.assertIn("material.description says what the material is, not what to notice in it", user)

    def test_writer_keeps_the_answer_out_of_instructions_and_used_for(self):
        # 과제 지시문과 자료 쓰임(학습자에게 보임)이 틀린 칸이나 답이 되는 행을 짚지 않게 한다.
        user = PromptBuilder().draft_prompts(blueprint_package("hard"))["user"]
        self.assertIn("Task instructions and material.used_for say what to do with the materials", user)
        self.assertIn("They do not name the entry that is wrong or the row, field, or value that is the answer", user)

    def test_normal_blueprint_prompt_asks_for_a_judgment_step(self):
        # 보통 난이도: 조건이나 규칙을 후보 여럿에 적용해 가려내는 판단 한 단계가 있어야 한다.
        user = PromptBuilder().draft_prompts(blueprint_package("normal"))["user"]
        self.assertIn("Blueprint normal-level requirements", user)
        self.assertIn("The task needs one real step of judgment", user)
        self.assertIn("Keep the tempting wrong answer that mission_blueprint plans", user)
        self.assertIn("takes a condition, rule, request, or small calculation from one material and applies it to what the other shows", user)
        self.assertNotIn("to at least three candidates", user)
        self.assertIn("Do not walk the learner through the steps", user)

    def test_normal_requirements_only_for_normal_blueprint_missions(self):
        # 쉬움·어려움 난이도와 두 단계가 아닌 경로에는 붙이지 않는다.
        for level in ("easy", "hard"):
            with self.subTest(level=level):
                user = PromptBuilder().draft_prompts(blueprint_package(level))["user"]
                self.assertNotIn("Blueprint normal-level requirements", user)
        plain = LLMInputPackageBuilder().build(sample_profile(), decisions_for("normal"), SchemaConstraintsBuilder().build())
        self.assertNotIn("Blueprint normal-level requirements", PromptBuilder().draft_prompts(plain)["user"])

    def test_writer_keeps_hints_out_of_checklist_marks(self):
        # 체크리스트의 표시는 화면에 그대로 보인다. 답을 알려 주는 값으로 쓰지 않게 한다.
        # 카드는 두 단계 생성에서 쓰지 않으므로 카드의 강점·약점·적합도 규칙은 두지 않는다.
        for level in ("easy", "normal", "hard"):
            with self.subTest(level=level):
                user = PromptBuilder().draft_prompts(blueprint_package(level))["user"]
                self.assertIn("use checked or unchecked only, never issue", user)
                self.assertIn("never set a status to point at the item the learner has to find", user)
                self.assertNotIn("적합도", user)

    def test_writer_knows_what_the_screen_does_not_show(self):
        # 앱 화면은 차트의 축 이름·단위와 메모의 작성자를 보여 주지 않는다.
        user = PromptBuilder().draft_prompts(blueprint_package())["user"]
        self.assertIn("put the unit in the chart's title or description", user)
        self.assertIn("name the source document or writer in the memo's title or description", user)

    def test_easy_blueprint_prompt_puts_the_condition_in_the_scenario(self):
        user = PromptBuilder().draft_prompts(blueprint_package("easy"))["user"]
        self.assertIn("Blueprint easy-level requirements", user)
        self.assertIn("Keep exactly 1 material, exactly 1 task, and a 1-2 sentence answer", user)
        for level in ("normal", "hard"):
            self.assertNotIn("Blueprint easy-level requirements", PromptBuilder().draft_prompts(blueprint_package(level))["user"])

    def test_hint_rules_stay_out_of_other_prompts(self):
        # 두 단계가 아닌 경로의 프롬프트는 그대로 둔다.
        plain = LLMInputPackageBuilder().build(sample_profile(), decisions_for("normal"), SchemaConstraintsBuilder().build())
        user = PromptBuilder().draft_prompts(plain)["user"]
        self.assertNotIn("Materials are workplace documents and data, not hints", user)
        self.assertNotIn("never issue", user)
        self.assertNotIn("Blueprint easy-level requirements", user)

    def test_hard_blueprint_prompt_has_overrides(self):
        user = PromptBuilder().draft_prompts(blueprint_package("hard"))["user"]
        self.assertIn("Blueprint hard-level overrides", user)
        self.assertIn("Use exactly 3 materials and exactly 2 tasks", user)

    def test_ncs_branch_prompt_still_used_without_blueprint(self):
        background = {
            "schema_version": "job_ncs_background.v1",
            "competency_unit": {"name": "수출통관", "definition": "d", "level": 3},
            "elements": [{"name": "수출신고서 작성하기", "performance_criteria": [CRITERION]}],
            "documents": [],
            "considerations": [],
            "eval_considerations": [],
        }
        package = LLMInputPackageBuilder().build(
            sample_profile(), decisions_for("normal"), SchemaConstraintsBuilder().build(), job_ncs_background=background
        )
        user = PromptBuilder().draft_prompts(package)["user"]
        self.assertIn("NCS background requirements:", user)
        self.assertNotIn("Blueprint requirements:", user)


class MockWriterTest(unittest.TestCase):
    def test_mock_draft_includes_basis_map_when_required(self):
        for level in ("easy", "normal", "hard"):
            with self.subTest(level=level):
                package = blueprint_package(level)
                draft = MockMissionDraftBuilder().build(package)
                rubric = draft["evaluation"]["rubric"]
                self.assertEqual([m["rubric_index"] for m in draft["basis_map"]["rubric"]], list(range(len(rubric))))
                self.assertEqual({m["evaluation_basis_index"] for m in draft["basis_map"]["rubric"]}, {0})
                for criterion in rubric:
                    self.assertEqual(criterion["linked_evidence"], KNOW_NAMES)
                for material in draft["mission"]["materials"]:
                    self.assertEqual(material["evidence_source"], KNOW_NAMES)
                stripped = {key: value for key, value in draft.items() if key != "basis_map"}
                validation = MissionValidator().validate(
                    job_profile=sample_profile(),
                    system_decisions=package["system_decisions"],
                    mission_output_draft=stripped,
                    attempt=0,
                )
                self.assertEqual((validation["status"], validation["errors"]), ("pass", []))

    def test_mock_draft_follows_the_blueprint_types(self):
        # 두 단계 생성은 일곱 형태를 연다. mock 초안도 설계서가 정한 형태를 따르고 검증을 통과해야 한다.
        counts = {"easy": 1, "normal": 2, "hard": 3}
        for kind in TWO_STAGE_MATERIAL_TYPES:
            for level, count in counts.items():
                with self.subTest(kind=kind, level=level):
                    package = blueprint_package(level)
                    package["system_decisions"]["allowed_material_types"] = list(TWO_STAGE_MATERIAL_TYPES)
                    slot = package["mission_blueprint"]["materials"][0]
                    package["mission_blueprint"]["materials"] = [{**slot, "slot": number, "type": kind} for number in range(1, count + 1)]
                    draft = MockMissionDraftBuilder().build(package)
                    self.assertEqual([m["type"] for m in draft["mission"]["materials"]], [kind] * count)
                    stripped = {key: value for key, value in draft.items() if key != "basis_map"}
                    validation = MissionValidator().validate(
                        job_profile=sample_profile(), system_decisions=package["system_decisions"], mission_output_draft=stripped, attempt=0
                    )
                    self.assertEqual((validation["status"], validation["errors"]), ("pass", []))

    def test_mock_draft_without_flag_has_no_basis_map(self):
        package = LLMInputPackageBuilder().build(sample_profile(), decisions_for("normal"), SchemaConstraintsBuilder().build())
        self.assertNotIn("basis_map", MockMissionDraftBuilder().build(package))


if __name__ == "__main__":
    unittest.main()
