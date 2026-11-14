# 두 단계 생성의 1단계: 근거 자료 묶음을 보고 미션의 설계서(mission_blueprint.v1)를 만든다.
#
# 설계서는 미션 문장을 쓰지 않고 결정만 담는다. 결정마다 근거 조각의 번호를 달고, 코드(BlueprintChecker)가 검사한다.

from __future__ import annotations

import copy
import json
import re
from typing import Any

from .basis_source_pack import link_basis, prompt_pieces
from .llm_runtime import create_runtime

BLUEPRINT_SCHEMA_VERSION = "mission_blueprint.v1"
# v2: 자료 내용과 맞지 않는 용어를 빌려 오지 않고, 자료 안에 답을 알려 주는 메모를 계획하지 않는다.
# v3: 과제 계획이 틀린 칸이나 답이 되는 행을 직접 짚지 않는다.
# v4: 보통 난이도에 판단 한 단계를 요구한다(값 옮겨 적기, 틀린 칸 하나 찾기로 끝나지 않게).
# v5: 자료의 모양(표는 4칸·4줄 이하 등)을 알려 줘서 들어가지 않는 내용을 계획하지 않게 한다.
# v6: 문장과 능력단위를 이은 판단이 근거로 든 구절과 수행준거(link_basis)를 알려 주고, 그 수행준거를 먼저 쓰게 한다.
#   설계서가 고른 수행준거가 연결의 근거와 하나도 겹치지 않거나 문장의 일과 어긋나는 미션이 나왔다.
# v7: 자료 형태 여덟 가지를 모두 연다. 형태는 인용한 서류 조각을 보고 고르고 그 이유를 type_reason에 적는다.
#   기준·요청 형태와 데이터 형태를 짝짓게 하고, 보통 난이도의 판단 모양을 '후보 가운데 고르기' 하나로 몰지 않는다
#   (그전 미션이 모두 표·차트 자료에 '조건을 후보에 적용해 고르기'였다).
# v8: 카드를 뺀다(일곱 형태). 후보를 나란히 놓는 일은 표가 하고, 카드는 칸 이름이 강점·약점·적합도로 고정이라
#   답을 알려 주기 쉽다. v7로 만든 미션과 앱의 기존 미션에서 한 번도 쓰이지 않았다.
# v9: 어려움 난이도의 답 분량을 과제마다 3~5문장으로 늘린다(요청의 difficulty.answer_length_hint).
#   검수에서 어려움 미션의 과제 1이 판정 여럿과 근거, 종합 평가를 2~4문장에 쓰라고 해 분량 문제로 걸렸다.
# v10: 채점 근거를 과제가 쓰라고 하는 것과 짝짓는다. 쉬움은 그럴듯한 오답을 따로 채점하지 않고,
#   보통은 과제가 "헷갈리기 쉬운 후보 하나를 왜 뺐는지"도 쓰게 한 뒤에만 그것을 채점한다. 보통의 답 분량을 3~4문장으로 늘린다.
#   검수에서 채점 기준이 지시문이 묻지 않은 것(뺀 후보의 이유, 분류 틀)에 20~30점을 주는 미션이 여럿 나왔다.
# v11: 보통의 "맞아 보이지만 답이 아닌 것 하나를 설명하라" 요구와 3~4문장을 되돌린다.
#   v10으로 다시 만든 보통 미션보다 이전 지시문(고르고 이유)이 나았고, 검수 판정도 그 문구를 '주관적'이라고 적었다.
#   보통도 쉬움처럼 그럴듯한 오답은 자료에 두되 따로 채점하지 않는다. 답 분량은 난이도 기본값(2-3) 그대로다.
# v12: 어려움 과제 2(추천 하나와 주의점 하나)의 채점 근거는 추천이 과제 1의 결과에서 나오는지, 이유와 주의점이
#   자료에 묶여 있는지를 본다. 기대 추천을 하나로 정하는 것은 자료가 그 하나만 허용할 때뿐이고, 아니면 근거가 맞는 추천은 모두
#   인정한다(예시는 '예시'로만). 과제 2의 지시가 추천 하나의 범위(먼저 할 하나, 후보 전체를 정한 안 하나)를 밝힌다.
#   v9 어려움 미션의 검수에서 과제 2의 채점이 한 가지 추천·주의점에만 맞춰져 근거 있는 다른 추천이 깎였다.
# v13: v12의 과제 2 문장을 문제 모양을 가리키지 않는 원칙으로 바꾼다. 자료가 답을 하나로 정하지 않는 곳에서는
#   특정 답을 요구하지 않고, 학습자가 든 이유가 자기 선택을 자료의 다른 선택지와 견줘 실제로 받치는지를 본다. 사실은 맞지만
#   그 선택을 받치지 못하는 이유는 부분 점수다. "먼저 할 하나, 후보 전체를 정한 안 하나" 같은 모양 예시는 뺐다.
#   v12로 만든 미션에서 사실만 맞으면 어느 추천이든 만점이 되는 채점이 나왔고, 과제 2가 "가장 먼저 ○○ 하나" 꼴로 쏠렸다.
BLUEPRINT_PROMPT_VERSION = "blueprint-v13"

# 두 단계 생성에서 어려움 난이도의 답 분량. 두 단계가 아닌 경로의 분량(2-4)은 그대로다.
# 보통은 난이도 기본값("2-3 short sentences")을 그대로 쓴다(v10의 3-4 덮어쓰기는 v11에서 뺐다).
TWO_STAGE_HARD_ANSWER_LENGTH = "3-5 short sentences per task"
# 두 단계 생성의 예상 시간(분). 두 단계가 아닌 경로는 난이도별 기본값 그대로다.
TWO_STAGE_ESTIMATED_MINUTES = {"easy": 10, "normal": 15, "hard": 20}

# 두 단계 생성에서 쓰는 자료 형태. 기준·요청을 담는 형태와 데이터를 담는 형태로 나눈다.
# 난이도는 형태가 아니라 자료 수와 판단의 깊이로 가른다.
# 카드(card)는 쓰지 않는다. 미션 형식과 앱 화면, 근거 카드에는 남아 있어 다른 경로의 미션은 그대로 보인다.
STANDARD_MATERIAL_TYPES = ("memo", "email", "checklist")
DATA_MATERIAL_TYPES = ("table", "chart", "log", "schedule")
TWO_STAGE_MATERIAL_TYPES = STANDARD_MATERIAL_TYPES + DATA_MATERIAL_TYPES

SYSTEM_PROMPT = (
    "너는 직업 체험 미션의 설계서를 쓰는 설계자다. 미션 문장을 쓰지 않고 결정만 적는다.\n"
    "모든 결정에는 pieces의 id를 근거로 단다. pieces에 없는 id와 pieces에 없는 사실을 쓰지 않는다.\n"
    "mission_blueprint.v1 형식의 JSON만 출력한다."
)

DESIGN_RULES = (
    "Design rules:\n"
    "- The mission is built around the work in the target sentence (target_exec_ref). focus.focus_phrase must be copied exactly from that sentence.\n"
    '- If the mission covers only part of the sentence, set coverage to "partial" and say in uncovered_note what is left out. Otherwise use "full" and an empty uncovered_note.\n'
    "- Choose 1 or 2 performance criteria (ids starting with N.c.) that make that work concrete.\n"
    "- Prefer criteria that name forms, documents, fields, conditions, or methods. Avoid generic criteria such as summarizing, reporting, or delivering, which fit any job.\n"
    "- Plan exactly the number of materials and tasks that difficulty.material_count_range and difficulty.task_count_range require. Number slots from 1.\n"
    "- Use only allowed_material_types for materials[].type. Choose each type from the kind of document or data the cited pieces say this work uses "
    "(N.doc.* pieces name them; criteria and considerations mention more), not from habit: "
    "a regulation, guideline, manual, or standard becomes a memo holding an excerpt of it, or a checklist; "
    "a request, inquiry, or instruction becomes an email or a memo; "
    "a table, ledger, statement, price list, or application form becomes a table, and so do candidates set side by side; "
    "statistics, status figures, or a trend become a chart; "
    "a record, journal, or history becomes a log; "
    "a timetable or plan becomes a schedule. "
    "Put the piece that names that document or data in the material's refs, and say in type_reason which document or data it is and why this type shows it best.\n"
    "- Materials play one of two parts. A standard-or-request material (memo, email, checklist) holds the rule, criteria, or request to apply. "
    "A data material (table, chart, log, schedule) holds the cases, figures, or records it is applied to. "
    "With 1 material (easy), any one type that can carry the whole task. "
    "With 2 materials (normal), prefer one of each part; two data materials, such as two tables, are fine when the work really sets two sets of data against each other. "
    "With 3 materials (hard), use at least two different types.\n"
    "- Materials have fixed shapes, so plan contents that fit. "
    "table: exactly four columns (three text columns and one whole-number column) and at most 4 rows (3 for easy), with no title row or note area; plan a real quantity for the number column when the data has one. "
    "chart: 1 or 2 series of numbers over 4-5 x values (3-4 for easy). "
    "memo: an author and 2-3 short items (1-2 for easy). "
    "email: one message with sender, recipient, subject, and a short body. "
    "checklist: exactly 3 items (2 for easy), each a short statement with a tick state. "
    "log: 3-4 entries (2-3 for easy), each with a time, who, what happened, and a short note. "
    "schedule: 2-3 items (1-2 for easy), each with a period, a task, and one constraint. "
    "A case condition such as a customer request goes in an email or memo material when the mission has one, otherwise in the scenario; never as a note under a table.\n"
    "- For each material, list borrowed_terms: words or field names you will copy exactly from the cited piece. Each term must appear in that piece's text exactly.\n"
    "- Borrow a term only for something the material will actually show: a column, row, field, or value in it, or a document name whose stated scope the planned content fully covers. If the planned content does not match the term, do not borrow it. A few terms that fit are better than many that do not.\n"
    "- content_plan lists the facts, figures, conditions, and rules the material holds. Do not plan notes, remarks, or labels that tell the learner which entry is wrong or missing, why a mistake was made, or which option is best. "
    "This includes a checklist's tick states: plan a checklist as a blank form the learner applies, or as a form someone already filled in whose ticks the learner checks against the data, never with a state that flags the problem item.\n"
    "- tasks[].action says what the learner does (compare, check, calculate, choose, recommend). It does not name the entries that are wrong or the row, field, or value that is the answer.\n"
    "- Every material, task, and evaluation_basis item needs at least one ref.\n"
    "- evaluation_basis.refs point to what is checked (N.eval.*, N.c.*). evaluation_basis.know_refs point to the KNOW items the mission exercises (K.act.*, K.abil.*, K.know.*). Use 1 to 4 different know_refs in total.\n"
    "- Each evaluation_basis item checks one part of the answer that a task explicitly asks the learner to write, such as the choice, the finding, the figure, or the reason. "
    "In what_to_check, name that part of the task. Do not plan an evaluation_basis item for something no task asks the learner to write: "
    "why other options were ruled out (unless the task asks for it), a way of grouping or ordering the explanation, or an extra observation. "
    "Everything the tasks ask for together must fit in difficulty.answer_length_hint.\n"
    "- glossary_terms are job terms from the cited pieces that a beginner needs explained.\n"
    "- A beginner must be able to solve the mission from the materials alone. Each task asks for one action.\n"
    "- For easy difficulty: the single material carries every fact needed, and the one condition or request the learner applies is short enough to state in the scenario (write it at the end of that material's content_plan). Plan one visible finding or choice, not a chain of steps. "
    "Entries that look like the answer but are not may stay in the material as they are, but the task asks only for the finding or choice and its reason, "
    "and no evaluation_basis item checks why the other entries were ruled out.\n"
    "- For normal difficulty: the task needs one real step of judgment, not copying. Plan the two materials so that the answer needs both: "
    "the learner takes a condition, rule, request, or small calculation from one and applies it to what the other shows. "
    "Take the form of the judgment from the target work, not always choosing among candidates: finding which entries break a rule stated in the other material, "
    "deciding whether and how a request can be met, working out an amount or a date, putting entries in order, or choosing among candidates. "
    "Whatever the form, plan at least one tempting wrong answer, a candidate, entry, or reading that fits some of the conditions but not all, and name it and what rules it out in content_plan. "
    "When the task is choosing among candidates, give at least three. "
    "Do not plan a task that is only copying values into blanks, reading off one value, or spotting a single mismatched entry. "
    "The task asks for the answer (the choice, the entries found, or the value worked out) and its reason. "
    "The tempting wrong answer stays in the materials, but no evaluation_basis item checks why it or any other option is ruled out. "
    "When the task itself asks for a verdict on each entry, those verdicts are part of the answer and may be checked.\n"
    "- For hard difficulty with 2 tasks: task 1 applies the working method of the chosen criterion to the materials, and task 2 uses that result to make one recommendation with one caution. "
    "tasks[].action for task 2 says plainly what the learner is to decide. "
    "Where the materials do not settle one right answer, the evaluation_basis does not require a particular answer. "
    "It checks whether the learner's reason, drawn from the task 1 result and the materials, actually supports the learner's own choice when set against the other options the materials show; "
    "a reason that states true facts but does not show why that choice holds up better than the others earns only part of the points. "
    "Name a single expected answer only when the materials allow no other. "
    "A caution is accepted when it is a real risk or limit of the chosen course that the materials show. "
    "what_to_check may give one answer and one caution as examples, marked '예시', but never as the only accepted answer.\n"
    "- Write all free-text fields in Korean."
)

# 요청에 link_basis가 있을 때만 규칙 끝에 붙인다. 구절·수행준거 번호가 없는 옛 연결의 프롬프트는 규칙이 그대로다.
LINK_BASIS_RULE = (
    "- link_basis records an earlier judgment that tied this sentence to this competency unit: link_basis.phrase is the part of "
    "the sentence the unit was linked on, and link_basis.criteria_refs are the performance criteria confirmed to deal with that work. "
    "Choose criteria from link_basis.criteria_refs. Use a criterion outside that list only when none of the listed ones can be made "
    "into a document-type task at this difficulty, and say why in that criterion's reason. "
    "When you can, take focus.focus_phrase from inside link_basis.phrase or overlapping it."
)


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    """모든 칸이 필수이고 다른 칸을 허용하지 않는 object 형식."""

    return {"type": "object", "additionalProperties": False, "required": list(properties), "properties": properties}


def _string() -> dict[str, Any]:
    return {"type": "string"}


def _array(items: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": items}


def _term() -> dict[str, Any]:
    return _object({"term": _string(), "ref": _string()})


def blueprint_json_schema(allowed_material_types: list[str]) -> dict[str, Any]:
    """설계서의 JSON 고정 출력 형식. 개수 제한은 형식이 지원하지 않아 BlueprintChecker가 본다."""

    return _object(
        {
            "schema_version": {"type": "string", "enum": [BLUEPRINT_SCHEMA_VERSION]},
            "focus": _object(
                {
                    "exec_ref": _string(),
                    "focus_phrase": _string(),
                    "coverage": {"type": "string", "enum": ["full", "partial"]},
                    "uncovered_note": _string(),
                    "reason": _string(),
                }
            ),
            "criteria": _array(_object({"ref": _string(), "reason": _string()})),
            "materials": _array(
                _object(
                    {
                        "slot": {"type": "integer"},
                        "type": {"type": "string", "enum": list(allowed_material_types)},
                        "type_reason": _string(),
                        "role": _string(),
                        "refs": _array(_string()),
                        "borrowed_terms": _array(_term()),
                        "content_plan": _string(),
                    }
                )
            ),
            "tasks": _array(_object({"slot": {"type": "integer"}, "action": _string(), "refs": _array(_string()), "reason": _string()})),
            "evaluation_basis": _array(
                _object({"refs": _array(_string()), "know_refs": _array(_string()), "what_to_check": _string(), "reason": _string()})
            ),
            "glossary_terms": _array(_term()),
        }
    )


def blueprint_mission_design(blueprint: dict[str, Any], attempt: int) -> dict[str, Any]:
    """통과한 설계서를 system_decisions.mission_design 형식의 설계 의도로 바꾼다."""

    focus_phrase = (blueprint.get("focus") or {}).get("focus_phrase") or ""
    criteria_count = len(blueprint.get("criteria") or [])
    return {
        "schema_version": "mission_design.v1",
        "mission_design_type": "blueprint_two_stage",
        "design_intent": (
            f"하는 일 문장의 '{focus_phrase}'을(를) 과제의 중심에 두고 수행준거 {criteria_count}개를 근거로 만든 미션. "
            "자료, 과제, 채점은 mission_blueprint의 결정을 따른다."
        ),
        "selection_method": "blueprint",
        "selection_reason": f"mission_blueprint_attempt_{attempt}.json",
    }


class BlueprintPromptBuilder:
    """설계서 호출의 입력(저장용)과 프롬프트를 만든다."""

    def request(self, *, source_pack: dict[str, Any], system_decisions: dict[str, Any], job_name: str) -> dict[str, Any]:
        request = {
            "schema_version": "blueprint_request.v1",
            "prompt_version": BLUEPRINT_PROMPT_VERSION,
            "job_cd": source_pack.get("job_cd"),
            "job_name": job_name,
            "difficulty": copy.deepcopy(system_decisions.get("difficulty", {})),
            "allowed_material_types": list(system_decisions.get("allowed_material_types", [])),
            "target_exec_ref": source_pack.get("target_exec_ref"),
        }
        # 연결 판단의 근거는 있을 때만 싣는다(조각 M.1 자체는 여전히 기록용이라 pieces에 넣지 않는다).
        basis = link_basis(source_pack)
        if basis:
            request["link_basis"] = basis
        request["pieces"] = prompt_pieces(source_pack)
        return request

    def prompts(
        self,
        request: dict[str, Any],
        *,
        check_errors: list[dict[str, Any]] | None = None,
        previous: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        rules = f"{DESIGN_RULES}\n{LINK_BASIS_RULE}" if request.get("link_basis") else DESIGN_RULES
        user_prompt = f"{rules}\n\nblueprint_request:\n{json.dumps(request, ensure_ascii=False)}"
        if check_errors:
            user_prompt += (
                "\n\nFix only these check errors and return the full blueprint again:\n"
                f"{json.dumps(check_errors, ensure_ascii=False)}"
                f"\nprevious_blueprint:\n{json.dumps(previous, ensure_ascii=False)}"
            )
        return {"system": SYSTEM_PROMPT, "user": user_prompt}


class MockBlueprintBuilder:
    """API 없이 흐름을 확인하기 위한 고정 설계서. 첫 수행준거를 고르고 난이도 규칙의 개수를 그대로 채운다."""

    def build(self, request: dict[str, Any]) -> dict[str, Any]:
        pieces = request.get("pieces", [])

        def first(kind: str) -> dict[str, Any] | None:
            return next((piece for piece in pieces if piece.get("kind") == kind), None)

        target_ref = request.get("target_exec_ref")
        sentence = next((piece["text"] for piece in pieces if piece.get("id") == target_ref), "")
        # 연결 판단이 근거로 든 수행준거가 있으면 그 가운데 첫 번째를 고른다.
        linked = (request.get("link_basis") or {}).get("criteria_refs") or []
        criterion = next((piece for piece in pieces if linked and piece.get("id") == linked[0]), None) or first("ncs_criterion")
        criterion_refs = [criterion["id"]] if criterion else []
        words = [word.strip(",.()") for word in re.split(r"\s+", criterion["text"] if criterion else "")]
        terms = [{"term": word, "ref": criterion["id"]} for word in words if len(word) >= 2][:2] if criterion else []
        difficulty = request.get("difficulty", {})
        material_count = (difficulty.get("material_count_range") or [1, 1])[1]
        task_count = (difficulty.get("task_count_range") or [1, 1])[1]
        # 자료마다 다른 형태를 쓴다(기준 형태 하나, 그다음 데이터 형태). 허용 형태가 적으면 돌아가며 쓴다.
        allowed = list(request.get("allowed_material_types") or ["table"])
        ordered = [kind for kind in ("memo", "table", "chart") if kind in allowed]
        ordered += [kind for kind in allowed if kind not in ordered]
        eval_piece = first("ncs_eval") or criterion
        know_piece = first("know_ability") or first("know_activity")
        return {
            "schema_version": BLUEPRINT_SCHEMA_VERSION,
            "focus": {
                "exec_ref": target_ref,
                "focus_phrase": sentence,
                "coverage": "full",
                "uncovered_note": "",
                "reason": "mock: 대상 문장 전체를 과제의 중심으로 둔다.",
            },
            "criteria": [{"ref": ref, "reason": "mock: 첫 수행준거를 고른다."} for ref in criterion_refs],
            "materials": [
                {
                    "slot": slot,
                    "type": ordered[(slot - 1) % len(ordered)],
                    "type_reason": "mock: 허용된 형태를 차례로 쓴다.",
                    "role": f"mock 자료 {slot}",
                    "refs": list(criterion_refs),
                    "borrowed_terms": copy.deepcopy(terms) if slot == 1 else [],
                    "content_plan": "mock: 수행준거의 낱말을 항목으로 둔다.",
                }
                for slot in range(1, material_count + 1)
            ],
            "tasks": [
                {
                    "slot": slot,
                    "action": "자료를 보고 한 가지를 판단해 전달한다",
                    "refs": list(criterion_refs),
                    "reason": "mock: 과제 하나에 행동 하나.",
                }
                for slot in range(1, task_count + 1)
            ],
            "evaluation_basis": [
                {
                    "refs": [eval_piece["id"]] if eval_piece else [],
                    "know_refs": [know_piece["id"]] if know_piece else [],
                    "what_to_check": "자료에서 근거를 찾아 판단했는가",
                    "reason": "mock: 첫 평가 지침과 첫 KNOW 항목을 고른다.",
                }
            ],
            "glossary_terms": [],
        }


class BlueprintDesigner:
    """설계서를 실제 LLM 호출 또는 명시적으로 허용된 mock으로 만든다."""

    def __init__(self, runtime: Any = None, allow_mock_without_key: bool = False, force_mock: bool = False) -> None:
        self.runtime = runtime or create_runtime()
        self.allow_mock_without_key = allow_mock_without_key
        self.force_mock = force_mock

    def design(
        self,
        request: dict[str, Any],
        *,
        check_errors: list[dict[str, Any]] | None = None,
        previous: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """설계서를 만든다. check_errors를 주면 그 오류를 고쳐 다시 쓰게 한다."""

        config = self.runtime.config
        call_type = "blueprint_repair" if check_errors else "blueprint_design"
        if self.force_mock or (not self.runtime.api_key_available() and self.allow_mock_without_key):
            blueprint = MockBlueprintBuilder().build(request)
            return {"llm_call_result": self._mock_call_result(call_type, config, blueprint), "mission_blueprint": blueprint}

        prompts = BlueprintPromptBuilder().prompts(request, check_errors=check_errors, previous=previous)
        call_result = self.runtime.call_structured(
            call_type=call_type,
            system_prompt=prompts["system"],
            user_prompt=prompts["user"],
            json_schema=blueprint_json_schema(request.get("allowed_material_types", [])),
            temperature=config.draft_temperature,
            max_output_tokens=config.max_output_tokens_repair,
            schema_name="mission_blueprint_v1",
        )
        return {"llm_call_result": call_result, "mission_blueprint": call_result.get("output_json")}

    @staticmethod
    def _mock_call_result(call_type: str, config: Any, blueprint: dict[str, Any]) -> dict[str, Any]:
        """mock 설계서도 실제 호출 결과와 같은 모양으로 감싼다(MissionDraftGenerator의 mock 결과와 같은 키)."""

        return {
            "schema_version": "llm_call_result.v1",
            "provider": "mock",
            "api": "local_dry_run",
            "model": config.model,
            "call_type": call_type,
            "reasoning_effort": config.reasoning_effort,
            "configured_temperature": config.draft_temperature,
            "temperature_request_parameter": config.temperature_application()["request_parameter"],
            "temperature_applied": False,
            "temperature_omitted_reason": "mock_generation",
            "temperature_retry_without_parameter": False,
            "status": "mocked",
            "output_json": blueprint,
            "usage": {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0},
            "errors": [],
            "attempt_count": 1,
            "retry_count": 0,
            "retry_errors": [],
        }
