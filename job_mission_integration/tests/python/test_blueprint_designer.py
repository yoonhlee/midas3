# 설계서 생성기: 형식, 요청, 프롬프트, mock 설계서, 호출을 확인한다.

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from basis_fixtures import sample_blueprint, sample_decisions, sample_pack, sample_unit_v03
from envutil import isolated_env

from src.mission_generation.blueprint_checker import BlueprintChecker
from src.mission_generation.config import MATERIAL_TYPES
from src.mission_generation.blueprint_designer import (
    BLUEPRINT_PROMPT_VERSION,
    BLUEPRINT_SCHEMA_VERSION,
    DATA_MATERIAL_TYPES,
    DESIGN_RULES,
    LINK_BASIS_RULE,
    STANDARD_MATERIAL_TYPES,
    TWO_STAGE_MATERIAL_TYPES,
    BlueprintDesigner,
    BlueprintPromptBuilder,
    MockBlueprintBuilder,
    blueprint_json_schema,
    blueprint_mission_design,
)

FORBIDDEN_KEYWORDS = {"minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "multipleOf"}


class FakeRuntime:
    """call_structured 호출을 기록하고 준비된 결과를 준다."""

    def __init__(self, output_json, key: bool = True) -> None:
        self.config = SimpleNamespace(
            model="claude-opus-5-5",
            reasoning_effort="medium",
            draft_temperature=0.8,
            max_output_tokens_repair=8000,
            temperature_application=lambda: {"request_parameter": "omitted"},
        )
        self.output_json, self.key, self.calls = output_json, key, []

    def api_key_available(self) -> bool:
        return self.key

    def call_structured(self, **kwargs):
        self.calls.append(kwargs)
        status = "completed" if self.output_json is not None else "failed"
        return {"provider": "anthropic", "status": status, "output_json": self.output_json, "call_type": kwargs["call_type"]}


def walk_objects(schema):
    """형식 안의 모든 object 형식을 차례로 준다."""

    if isinstance(schema, dict):
        if schema.get("type") == "object":
            yield schema
        for value in schema.values():
            yield from walk_objects(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from walk_objects(value)


def walk_keys(schema):
    if isinstance(schema, dict):
        for key, value in schema.items():
            yield key
            yield from walk_keys(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from walk_keys(value)


class BlueprintDesignerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as folder:
            cls.pack = sample_pack(Path(folder))

    def request(self, level: str = "normal") -> dict:
        return BlueprintPromptBuilder().request(
            source_pack=self.pack, system_decisions=sample_decisions(level), job_name="무역사무원"
        )

    def test_schema_is_strict_and_uses_no_unsupported_keywords(self):
        schema = blueprint_json_schema(["chart", "table"])
        objects = list(walk_objects(schema))
        self.assertGreaterEqual(len(objects), 7)
        for obj in objects:
            self.assertIs(obj.get("additionalProperties"), False)
            self.assertEqual(sorted(obj["required"]), sorted(obj["properties"]))
        self.assertEqual(FORBIDDEN_KEYWORDS & set(walk_keys(schema)), set())
        self.assertEqual(schema["properties"]["materials"]["items"]["properties"]["type"]["enum"], ["chart", "table"])
        self.assertEqual(schema["properties"]["focus"]["properties"]["coverage"]["enum"], ["full", "partial"])
        self.assertEqual(schema["properties"]["schema_version"]["enum"], [BLUEPRINT_SCHEMA_VERSION])
        self.assertEqual(
            set(schema["properties"]),
            {"schema_version", "focus", "criteria", "materials", "tasks", "evaluation_basis", "glossary_terms"},
        )

    def test_sample_blueprint_has_exactly_the_schema_fields(self):
        schema = blueprint_json_schema(["chart", "table"])
        blueprint = sample_blueprint()
        self.assertEqual(set(blueprint), set(schema["properties"]))
        self.assertEqual(set(blueprint["materials"][0]), set(schema["properties"]["materials"]["items"]["properties"]))
        self.assertEqual(set(blueprint["evaluation_basis"][0]), set(schema["properties"]["evaluation_basis"]["items"]["properties"]))

    def test_request_contains_only_prompt_pieces(self):
        request = self.request()
        ids = {p["id"] for p in request["pieces"]}
        self.assertIn("N.c.2.1", ids)
        self.assertTrue(ids.isdisjoint({"K.keco", "L.1", "L.2", "M.1"}))
        self.assertEqual((request["schema_version"], request["prompt_version"]), ("blueprint_request.v1", BLUEPRINT_PROMPT_VERSION))
        self.assertEqual((request["target_exec_ref"], request["job_name"], request["job_cd"]), ("K.exec.1", "무역사무원", "K000000918"))
        self.assertEqual(request["difficulty"]["material_count_range"], [2, 2])
        self.assertEqual(request["allowed_material_types"], ["chart", "table"])

    def test_prompts_carry_rules_and_request(self):
        prompts = BlueprintPromptBuilder().prompts(self.request())
        self.assertIn("mission_blueprint.v1 형식의 JSON만 출력한다.", prompts["system"])
        self.assertIn("focus.focus_phrase must be copied exactly", prompts["user"])
        self.assertIn("Avoid generic criteria such as summarizing, reporting, or delivering", prompts["user"])
        self.assertIn('"target_exec_ref": "K.exec.1"', prompts["user"])
        self.assertNotIn("Fix only these check errors", prompts["user"])

    def test_prompt_version(self):
        # 규칙을 바꾸면 버전을 올려, 근거 기록에서 어느 규칙으로 만든 미션인지 구분한다.
        self.assertEqual(BLUEPRINT_PROMPT_VERSION, "blueprint-v13")

    # ── 연결 판단의 근거(구절, 확정된 수행준거)를 설계서에 알려 준다(v6) ──

    def linked_request(self, refs: list[str] | None = None) -> dict:
        unit = sample_unit_v03()
        if refs is not None:
            unit["link"]["criteria_refs"] = refs
        with tempfile.TemporaryDirectory() as folder:
            pack = sample_pack(Path(folder), unit=unit)
        return BlueprintPromptBuilder().request(source_pack=pack, system_decisions=sample_decisions(), job_name="무역사무원")

    def test_request_carries_the_link_basis(self):
        request = self.linked_request()
        self.assertEqual(
            request["link_basis"],
            {"phrase": "세관 신고서류를 작성", "match": "직접", "criteria_refs": ["N.c.2.1"]},
        )
        self.assertTrue({p["id"] for p in request["pieces"]}.isdisjoint({"M.1"}))

    def test_request_without_link_refs_has_no_link_basis(self):
        self.assertNotIn("link_basis", self.request())

    def test_link_basis_keeps_only_criteria_the_model_can_cite(self):
        self.assertEqual(self.linked_request(["9.9", "2.1"])["link_basis"]["criteria_refs"], ["N.c.2.1"])
        self.assertNotIn("link_basis", self.linked_request(["9.9"]))

    def test_link_rule_is_added_only_when_there_is_a_link_basis(self):
        linked = BlueprintPromptBuilder().prompts(self.linked_request())["user"]
        self.assertIn(LINK_BASIS_RULE, linked)
        self.assertIn("Choose criteria from link_basis.criteria_refs", linked)
        self.assertIn('"link_basis": {"phrase": "세관 신고서류를 작성"', linked)
        plain_request = self.request()
        plain = BlueprintPromptBuilder().prompts(plain_request)["user"]
        self.assertNotIn("link_basis", plain)
        self.assertEqual(plain, f"{DESIGN_RULES}\n\nblueprint_request:\n{json.dumps(plain_request, ensure_ascii=False)}")

    def test_mock_blueprint_uses_a_linked_criterion(self):
        blueprint = MockBlueprintBuilder().build(self.linked_request())
        self.assertEqual([item["ref"] for item in blueprint["criteria"]], ["N.c.2.1"])
        self.assertEqual([item["ref"] for item in MockBlueprintBuilder().build(self.request())["criteria"]], ["N.c.1.1"])

    def test_rules_borrow_a_term_only_for_what_the_material_shows(self):
        # 자료 내용과 맞지 않는 이름(예: 항공 요금이 없는 표의 제목에 '항공')을 빌려 오지 않게 한다.
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("Borrow a term only for something the material will actually show", user)
        self.assertIn("If the planned content does not match the term, do not borrow it", user)

    def test_rules_do_not_plan_answer_hints_inside_materials(self):
        # 자료 안에 어느 칸이 틀렸는지, 어느 선택지가 답인지 알려 주는 메모를 계획하지 않게 한다.
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("Do not plan notes, remarks, or labels that tell the learner", user)

    def test_rules_keep_the_answer_out_of_task_actions(self):
        # 과제 계획이 틀린 칸이나 답이 되는 행을 직접 짚지 않게 한다(예: "보험료, 수출신고가격을 점검").
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("tasks[].action says what the learner does", user)
        self.assertIn("It does not name the entries that are wrong or the row, field, or value that is the answer", user)

    def test_rules_give_normal_difficulty_a_judgment_step(self):
        # 보통 난이도가 값 옮겨 적기나 틀린 칸 하나 찾기로 끝나지 않게 한다.
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("For normal difficulty: the task needs one real step of judgment, not copying", user)
        self.assertIn("plan at least one tempting wrong answer", user)
        self.assertIn("fits some of the conditions but not all", user)
        # 판단의 모양을 '후보 가운데 고르기' 하나로 몰지 않는다(그전 미션이 모두 그 모양이었다).
        self.assertIn("Take the form of the judgment from the target work, not always choosing among candidates", user)
        self.assertIn("When the task is choosing among candidates, give at least three", user)
        self.assertIn("Do not plan a task that is only copying values into blanks, reading off one value, or spotting a single mismatched entry", user)

    def test_rules_tell_the_designer_the_material_shapes(self):
        # 설계서가 표에 들어가지 않는 내용(5줄, 표 아래 메모)을 계획하지 않게 자료의 모양을 알려 준다.
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("Materials have fixed shapes, so plan contents that fit", user)
        self.assertIn("table: exactly four columns (three text columns and one whole-number column) and at most 4 rows (3 for easy)", user)
        self.assertIn("with no title row or note area", user)
        # 일곱 형태의 모양을 모두 알려 준다.
        for shape in (
            "chart: 1 or 2 series",
            "memo: an author and 2-3 short items",
            "email: one message",
            "checklist: exactly 3 items (2 for easy)",
            "log: 3-4 entries (2-3 for easy)",
            "schedule: 2-3 items (1-2 for easy)",
        ):
            self.assertIn(shape, user)
        # 고객 요청 같은 조건은 이메일·메모 자료가 있으면 거기에 둔다(표 아래 메모로는 두지 않는다).
        self.assertIn("goes in an email or memo material when the mission has one, otherwise in the scenario; never as a note under a table", user)

    # ── 일곱 형태를 열고(v7에서 여덟, v8에서 카드를 뺌), 형태는 인용한 서류를 보고 고른다 ──

    def test_two_stage_types_are_seven_in_two_parts_without_card(self):
        # 카드는 뺀다: 후보를 나란히 놓는 일은 표가 하고, 카드는 칸 이름이 강점·약점·적합도로 고정이라 답을 알려 주기 쉽다.
        self.assertEqual(set(TWO_STAGE_MATERIAL_TYPES), set(MATERIAL_TYPES) - {"card"})
        self.assertEqual(len(TWO_STAGE_MATERIAL_TYPES), 7)
        self.assertEqual(set(STANDARD_MATERIAL_TYPES), {"memo", "email", "checklist"})
        self.assertEqual(set(DATA_MATERIAL_TYPES), {"table", "chart", "log", "schedule"})
        self.assertEqual(list(TWO_STAGE_MATERIAL_TYPES), list(STANDARD_MATERIAL_TYPES) + list(DATA_MATERIAL_TYPES))

    def test_rules_pick_the_type_from_the_cited_document(self):
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("Choose each type from the kind of document or data the cited pieces say this work uses", user)
        for mapping in (
            "a regulation, guideline, manual, or standard becomes a memo holding an excerpt of it, or a checklist",
            "a request, inquiry, or instruction becomes an email or a memo",
            "a table, ledger, statement, price list, or application form becomes a table, and so do candidates set side by side",
            "statistics, status figures, or a trend become a chart",
            "a record, journal, or history becomes a log",
            "a timetable or plan becomes a schedule",
        ):
            self.assertIn(mapping, user)
        self.assertIn("say in type_reason which document or data it is", user)

    def test_rules_pair_materials_by_part_for_each_difficulty(self):
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("A standard-or-request material (memo, email, checklist) holds the rule, criteria, or request to apply", user)
        self.assertIn("A data material (table, chart, log, schedule) holds the cases, figures, or records it is applied to", user)
        self.assertIn("With 1 material (easy), any one type that can carry the whole task", user)
        self.assertIn("With 2 materials (normal), prefer one of each part; two data materials, such as two tables, are fine", user)
        self.assertIn("With 3 materials (hard), use at least two different types", user)

    def test_rules_keep_hints_out_of_checklist_marks(self):
        # 체크리스트의 표시는 화면에 그대로 보여서 답을 알려 주기 쉽다.
        user = BlueprintPromptBuilder().prompts(self.request())["user"]
        self.assertIn("This includes a checklist's tick states", user)
        self.assertIn("never with a state that flags the problem item", user)

    def test_rules_never_mention_the_card_type(self):
        self.assertNotIn("card", DESIGN_RULES)
        self.assertNotIn("card", BlueprintPromptBuilder().prompts(self.request())["user"])

    def test_rules_cover_easy_difficulty(self):
        # 쉬움은 자료가 하나라서, 적용할 조건 하나는 상황 글에 둔다.
        user = BlueprintPromptBuilder().prompts(self.request("easy"))["user"]
        self.assertIn("For easy difficulty: the single material carries every fact needed", user)

    def test_schema_asks_why_each_type_was_chosen(self):
        schema = blueprint_json_schema(list(TWO_STAGE_MATERIAL_TYPES))
        material = schema["properties"]["materials"]["items"]
        self.assertEqual(material["properties"]["type_reason"], {"type": "string"})
        self.assertIn("type_reason", material["required"])
        self.assertEqual(material["properties"]["type"]["enum"], list(TWO_STAGE_MATERIAL_TYPES))

    def test_mock_blueprint_plans_different_types_with_a_reason(self):
        for level, count in (("easy", 1), ("normal", 2), ("hard", 3)):
            with self.subTest(level=level):
                decisions = sample_decisions(level)
                decisions["allowed_material_types"] = list(TWO_STAGE_MATERIAL_TYPES)
                request = BlueprintPromptBuilder().request(source_pack=self.pack, system_decisions=decisions, job_name="무역사무원")
                blueprint = MockBlueprintBuilder().build(request)
                types = [material["type"] for material in blueprint["materials"]]
                self.assertEqual(len(types), count)
                self.assertEqual(len(set(types)), count)  # 자료마다 다른 형태
                self.assertTrue(all(material["type_reason"] for material in blueprint["materials"]))
                result = BlueprintChecker().check(blueprint=blueprint, source_pack=self.pack, system_decisions=decisions)
                self.assertEqual(result["errors"], [])

    def test_repair_prompt_includes_errors_and_previous(self):
        errors = [{"code": "BP_REF_UNKNOWN", "path": "criteria[0].ref", "message": "m", "required_fix": "f"}]
        prompts = BlueprintPromptBuilder().prompts(self.request(), check_errors=errors, previous=sample_blueprint())
        self.assertIn("Fix only these check errors", prompts["user"])
        self.assertIn("BP_REF_UNKNOWN", prompts["user"])
        self.assertIn("세관 신고서류를 작성", prompts["user"].split("previous_blueprint:")[1])

    def test_mock_blueprint_passes_checker_for_each_difficulty(self):
        for level in ("easy", "normal", "hard"):
            with self.subTest(level=level):
                decisions = sample_decisions(level)
                blueprint = MockBlueprintBuilder().build(self.request(level))
                result = BlueprintChecker().check(blueprint=blueprint, source_pack=self.pack, system_decisions=decisions)
                self.assertEqual(result["errors"], [])
                self.assertEqual(len(blueprint["materials"]), decisions["difficulty"]["material_count_range"][1])
                self.assertEqual(len(blueprint["tasks"]), decisions["difficulty"]["task_count_range"][1])
                self.assertEqual(blueprint["schema_version"], BLUEPRINT_SCHEMA_VERSION)

    def test_mock_blueprint_is_deterministic(self):
        self.assertEqual(MockBlueprintBuilder().build(self.request()), MockBlueprintBuilder().build(self.request()))

    def test_design_with_force_mock_returns_mocked_call(self):
        with isolated_env():
            out = BlueprintDesigner(force_mock=True).design(self.request())
        call = out["llm_call_result"]
        self.assertEqual((call["provider"], call["status"], call["call_type"]), ("mock", "mocked", "blueprint_design"))
        self.assertEqual(out["mission_blueprint"]["focus"]["exec_ref"], "K.exec.1")

    def test_mock_is_used_without_key_only_when_allowed(self):
        runtime = FakeRuntime(sample_blueprint(), key=False)
        out = BlueprintDesigner(runtime=runtime, allow_mock_without_key=True).design(self.request())
        self.assertEqual((out["llm_call_result"]["provider"], runtime.calls), ("mock", []))

    def test_design_calls_runtime_with_schema(self):
        runtime = FakeRuntime(sample_blueprint())
        out = BlueprintDesigner(runtime=runtime).design(self.request())
        kw = runtime.calls[0]
        self.assertEqual((kw["call_type"], kw["schema_name"]), ("blueprint_design", "mission_blueprint_v1"))
        self.assertEqual((kw["temperature"], kw["max_output_tokens"]), (0.8, 8000))
        self.assertEqual(kw["json_schema"], blueprint_json_schema(["chart", "table"]))
        self.assertIn("Design rules:", kw["user_prompt"])
        self.assertEqual(out["mission_blueprint"], sample_blueprint())

    def test_repair_call_type_and_prompt(self):
        runtime = FakeRuntime(sample_blueprint())
        errors = [{"code": "BP_CRITERIA_COUNT", "path": "criteria", "message": "m", "required_fix": "f"}]
        BlueprintDesigner(runtime=runtime).design(self.request(), check_errors=errors, previous=sample_blueprint())
        self.assertEqual(runtime.calls[0]["call_type"], "blueprint_repair")
        self.assertIn("BP_CRITERIA_COUNT", runtime.calls[0]["user_prompt"])

    def test_failed_call_returns_no_blueprint(self):
        out = BlueprintDesigner(runtime=FakeRuntime(None)).design(self.request())
        self.assertIsNone(out["mission_blueprint"])
        self.assertEqual(out["llm_call_result"]["status"], "failed")

    def test_blueprint_mission_design(self):
        design = blueprint_mission_design(sample_blueprint(), 1)
        self.assertEqual(
            (design["schema_version"], design["mission_design_type"], design["selection_method"], design["selection_reason"]),
            ("mission_design.v1", "blueprint_two_stage", "blueprint", "mission_blueprint_attempt_1.json"),
        )
        self.assertIn("세관 신고서류를 작성", design["design_intent"])
        json.dumps(design, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
