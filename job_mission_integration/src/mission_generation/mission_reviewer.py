# 저장된 미션의 내용 검수: 모델이 학습자처럼 풀어 보고(답은 숨긴다), 다른 호출이 그 답을 기대 답과 견준다.
#
# 코드 검사(설계서 검사, 검증기, 근거 검사)는 모양과 근거만 본다. 문제가 풀리는지, 답이 하나인지, 계산이 맞는지,
# 자료에 답이 새는지는 보지 않는다. 이 단계가 그것을 본다. 미션을 고치지 않고 판정과 이유만 남긴다.
#
#   1) 풀어 보기(mission_solve): 화면에 보이는 것만 준다. 기대 답과 채점 기준은 주지 않는다.
#   2) 판정(mission_review): 화면에 보이는 것 + 기대 답·채점 기준 + 1)의 답을 주고, 맞는지와 문제점을 적게 한다.
#   3) 코드가 두 결과로 통과 / 의심 / 문제를 정한다(decide). 직업 사실이 의심스러운 곳은 판정과 따로 센다.
#
#   python -X utf8 -m src.mission_generation.mission_reviewer --run-dir <실행 폴더> [--out <폴더>]
#
# 설정된 제공자의 API를 부른다.

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

from .blueprint_checker import MissionBasisChecker
from .final_assembler import FinalMissionAssembler
from .llm_runtime import create_runtime
from .repair_manager import RepairManager, RepairPromptBuilder
from .utils import iso_now
from .validator import MissionValidator

REVIEW_SCHEMA = "mission_review.v1"
# v2: 표를 화면처럼 칸 이름(라벨)으로 보여 준다. v1은 내부 키(option/strength/weakness/priority)를 그대로 넘겨
#   풀어 본 쪽이 "키 이름이 내용과 안 맞는다"는 문제를 여러 번 적었다(미션이 아니라 검수 입력의 문제였다).
SOLVER_PROMPT_VERSION = "review-solver-v2"
# v2: 심각도 칸을 반드시 적게 하고, "지시문이 요구하지 않은 내용에 20점 이상을 주는 채점 기준은 주의"라는 선을 준다.
#   그런 지적에 쓸 종류 rubric_not_in_task를 더했다(판정 쪽만 쓴다). 검수에서 심각도를 비운 판정 답이 나왔고,
#   같은 종류의 채점 지적이 한 미션에서는 주의, 다른 미션에서는 참고로 갈렸다.
REVIEWER_PROMPT_VERSION = "review-judge-v2"

VERDICT_PASS, VERDICT_DOUBT, VERDICT_FAIL, VERDICT_ERROR = "pass", "doubt", "fail", "review_failed"
VERDICT_LABELS = {
    VERDICT_PASS: "통과",
    VERDICT_DOUBT: "의심",
    VERDICT_FAIL: "문제",
    VERDICT_ERROR: "검수 실패",
}

# 풀이하는 쪽과 판정하는 쪽이 함께 쓰는 문제 종류.
ISSUE_KINDS = [
    "missing_information",  # 풀려면 필요한 값이 자료에 없다
    "ambiguous_or_several_answers",  # 자료만으로는 답이 갈린다
    "wrong_expected_answer",  # 기대 답이나 채점 기준이 자료와 맞지 않는다(판정 쪽만 쓴다)
    "answer_leak",  # 자료나 지시문이 답을 알려 준다
    "inconsistent_data",  # 날짜·요일·합계 등이 서로 맞지 않는다
    "too_much_for_length",  # 요구하는 내용이 정해진 분량에 비해 많다
    "unclear_wording",  # 무엇을 하라는지 글이 분명하지 않다
    "rubric_not_in_task",  # 채점 기준이 지시문이 쓰라고 하지 않은 것을 채점한다(판정 쪽만 쓴다, review-judge-v2)
    "other",
]
# 풀어 보는 쪽은 기대 답과 채점 기준을 보지 않으므로 그 둘에 대한 종류를 쓰지 않는다(풀어 보기 요청은 v2 그대로다).
SOLVER_ISSUE_KINDS = [kind for kind in ISSUE_KINDS if kind not in ("wrong_expected_answer", "rubric_not_in_task")]
SEVERITIES = ("error", "warning", "note")

SOLVER_SYSTEM_PROMPT = (
    "너는 이 직업을 처음 체험해 보는 학습자다. 전문 지식 없이, 화면에 보이는 글과 자료만으로 과제를 푼다.\n"
    "다 푼 뒤에는 풀면서 막히거나 이상했던 점을 그대로 적는다. mission_solve.v1 형식의 JSON만 출력한다."
)

SOLVER_RULES = (
    "Solve rules:\n"
    "- learner_view is everything the mission screen shows. Use only what is in it. Do not use outside knowledge of the job, "
    "and do not assume facts that are not shown.\n"
    "- Answer every task in learner_view.tasks, in Korean, the way a careful beginner would, within the stated length.\n"
    "- In basis, say which material and which values you used and how you got from them to the answer. Show any arithmetic.\n"
    "- solvable: \"yes\" if the materials are enough to answer every task, \"partly\" if some part cannot be decided from them, \"no\" if a task cannot be answered.\n"
    "- A task that asks for a recommendation with a reason may have more than one defensible answer; that alone is not a problem. "
    "Report ambiguous_or_several_answers only when a part that clearly should have one right answer can be read two ways.\n"
    "- issues: list what got in your way or looked wrong while solving, each with where it is and a concrete detail. "
    "Kinds: missing_information, ambiguous_or_several_answers, answer_leak (a title, description, note, or instruction gives the answer away), "
    "inconsistent_data (dates, weekdays, totals, or units that do not agree), too_much_for_length (more is asked than the stated length can hold), "
    "unclear_wording, other. Use an empty list when there is nothing to report. Do not invent problems.\n"
    "- minutes_estimate: how many minutes a beginner would need to read and answer, as a whole number.\n"
    "- Write all free text in Korean."
)

REVIEWER_SYSTEM_PROMPT = (
    "너는 직업 체험 미션의 검수자다. 미션을 고치지 않는다. 자료와 기대 답, 그리고 학습자 역할로 먼저 풀어 본 답을 놓고\n"
    "문제가 제대로 풀리는지, 기대 답이 자료와 맞는지 확인해 적는다. mission_review_judgement.v1 형식의 JSON만 출력한다."
)

REVIEWER_RULES = (
    "Review rules:\n"
    "- learner_view is everything the learner sees. answer_key is what the mission author expects (never shown to the learner). "
    "solver_result is the answer of a solver who saw only learner_view.\n"
    "- First work out the answer yourself from learner_view, checking every date, sum, and comparison. Then judge answer_key against the materials: "
    "expected_answer_check is \"correct\" when every expected insight follows from the materials, \"doubtful\" when one cannot be confirmed from them "
    "or rests on something not shown, \"wrong\" when one contradicts the materials. Say which one and why in expected_answer_note.\n"
    "- agreement: compare solver_result.answers with answer_key. \"same\" when the solver reaches the expected conclusions, \"partly\" when some are missing "
    "or differ, \"different\" when the main conclusion differs. In agreement_note, say what differs and, from the materials, which side is right.\n"
    "- answer_unique: \"yes\" when the parts with one right answer can only be answered one way from the materials, \"no\" when another answer fits them equally, "
    "\"unclear\" when you cannot tell. A task that asks for a recommendation with a reason is allowed several defensible answers; do not count that against uniqueness. "
    "The same holds for a part that lets the learner choose which ruled-out option to explain.\n"
    "- issues: check each issue in solver_result.issues against the materials and keep only the real ones; add any you find yourself. "
    "Every issue must have all five fields, and severity must be exactly one of \"error\", \"warning\", \"note\"; never leave severity out. "
    "severity \"error\" = the mission cannot be used as it is (unsolvable, wrong expected answer, the answer is given away); "
    "\"warning\" = a learner would stumble or the grading would be unfair (an item cannot be decided, more asked than the length holds, data that does not agree); "
    "\"note\" = small and harmless. raised_by says who found it: solver, reviewer, or both.\n"
    "- Compare each rubric item with what the task instructions ask the learner to write. A rubric item that gives 20 points or more for something the instructions "
    "do not ask for (for example why other options were ruled out, a grouping or framework for the explanation, or an extra observation) is a warning of kind "
    "rubric_not_in_task, because a learner who answers exactly what was asked loses those points. The same thing worth fewer than 20 points is a note of that kind. "
    "Say in detail which rubric item, how many points, and what the instruction asks instead.\n"
    "- Also look for: a rubric item that rewards something the materials do not let the learner find; hints in titles, descriptions, remarks, instructions, "
    "the scenario, or glossary definitions (for example a scenario sentence that names the right option, or a definition that states the rule or formula that decides the answer); "
    "dates, weekdays, totals, and units that do not agree; a value the answer needs that only sits in a field the screen does not show.\n"
    "- fact_doubts: statements in the mission that present something as real practice of this job (a rule, a definition, a typical figure) and that you suspect "
    "may be inaccurate or invented. You cannot verify them here, so only list the claim and why you doubt it. Do not list a rule the mission openly presents as "
    "this fictional company's own rule unless it contradicts how the job works.\n"
    "- verdict: \"fail\" if there is any error, \"doubt\" if there is any warning, a disagreement, or a doubt about the expected answer or its uniqueness, otherwise \"pass\". "
    "summary: one or two sentences a busy human reviewer can act on.\n"
    "- Write all free text in Korean."
)


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(properties), "properties": properties}


def _string() -> dict[str, Any]:
    return {"type": "string"}


def _enum(values: list[str]) -> dict[str, Any]:
    return {"type": "string", "enum": list(values)}


def _array(items: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": items}


def solver_json_schema() -> dict[str, Any]:
    return _object(
        {
            "schema_version": _enum(["mission_solve.v1"]),
            "answers": _array(_object({"task_id": _string(), "answer": _string(), "basis": _string()})),
            "solvable": _enum(["yes", "partly", "no"]),
            "issues": _array(_object({"kind": _enum(SOLVER_ISSUE_KINDS), "where": _string(), "detail": _string()})),
            "minutes_estimate": {"type": "integer"},
        }
    )


def reviewer_json_schema() -> dict[str, Any]:
    return _object(
        {
            "schema_version": _enum(["mission_review_judgement.v1"]),
            "expected_answer_check": _enum(["correct", "doubtful", "wrong"]),
            "expected_answer_note": _string(),
            "agreement": _enum(["same", "partly", "different"]),
            "agreement_note": _string(),
            "answer_unique": _enum(["yes", "no", "unclear"]),
            "issues": _array(
                _object(
                    {
                        "kind": _enum(ISSUE_KINDS),
                        "severity": _enum(["error", "warning", "note"]),
                        "where": _string(),
                        "detail": _string(),
                        "raised_by": _enum(["solver", "reviewer", "both"]),
                    }
                )
            ),
            "fact_doubts": _array(_object({"claim": _string(), "why": _string()})),
            "verdict": _enum([VERDICT_PASS, VERDICT_DOUBT, VERDICT_FAIL]),
            "summary": _string(),
        }
    )


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _screen_data(material_type: Any, data: Any) -> Any:
    """자료의 data에서 미션 화면이 보여 주지 않는 값을 뺀다(app/components/missionScreens.js 기준).

    차트는 x값과 계열만 보인다(축 이름과 단위는 안 보인다). 메모는 항목이 있으면 작성자가 안 보인다.
    체크리스트의 중요도는 "high"만 "중요"로 보인다. 표는 칸 이름(라벨)만 보이고 내부 키는 안 보인다.
    """

    data = copy.deepcopy(data)
    if not isinstance(data, dict):
        return data
    if material_type == "chart":
        return {"chart_type": data.get("chart_type"), "x_values": _as_list(_as_dict(data.get("x_axis")).get("values")), "series": data.get("series")}
    if material_type == "table":
        columns = [_as_dict(column) for column in _as_list(data.get("columns"))]
        labels = [str(column.get("label") or column.get("key") or "") for column in columns]
        rows = [
            {label: _as_dict(row).get(column.get("key")) for column, label in zip(columns, labels)}
            for row in _as_list(data.get("rows"))
        ]
        return {"columns": labels, "rows": rows}
    if material_type == "memo" and _as_list(data.get("items")):
        data.pop("author", None)
    if material_type == "checklist":
        for item in _as_list(data.get("items")):
            if isinstance(item, dict) and item.get("importance") != "high":
                item.pop("importance", None)
    return data


def learner_view(mission: dict[str, Any]) -> dict[str, Any]:
    """학습자가 미션 화면에서 보는 것만 뽑는다. 기대 답, 채점 기준, 근거 추적, 내부 메모는 넣지 않는다."""

    body = _as_dict(mission.get("mission"))
    scenario = _as_dict(body.get("scenario"))
    submission = _as_dict(body.get("submission_format"))
    return {
        "job_name": _as_dict(mission.get("job_identity")).get("job_smcl_nm"),
        "title": body.get("title"),
        "difficulty": _as_dict(body.get("difficulty")).get("label") or _as_dict(body.get("difficulty")).get("level"),
        "scenario": {
            "role": scenario.get("role"),
            "context": scenario.get("context"),
            "goal": scenario.get("goal"),
            "constraints": copy.deepcopy(_as_list(scenario.get("constraints"))),
            "glossary": copy.deepcopy(_as_list(scenario.get("glossary"))),
        },
        "materials": [
            {
                "material_id": _as_dict(material).get("material_id"),
                "type": _as_dict(material).get("type"),
                "title": _as_dict(material).get("title"),
                "description": _as_dict(material).get("description"),
                "used_for": _as_dict(material).get("used_for"),
                "data": _screen_data(_as_dict(material).get("type"), _as_dict(material).get("data")),
            }
            for material in _as_list(body.get("materials"))
        ],
        "tasks": [{"task_id": _as_dict(task).get("task_id"), "instruction": _as_dict(task).get("instruction")} for task in _as_list(body.get("tasks"))],
        "answer_format": {"required_sections": copy.deepcopy(_as_list(submission.get("required_sections"))), "length_hint": submission.get("length_hint")},
    }


def answer_key(mission: dict[str, Any]) -> dict[str, Any]:
    """미션을 만든 쪽이 기대하는 답과 채점 기준. 풀이하는 쪽에는 주지 않는다."""

    evaluation = _as_dict(mission.get("evaluation"))
    return {
        "expected_insights": copy.deepcopy(_as_list(evaluation.get("expected_insights"))),
        "rubric": [
            {"criterion": _as_dict(item).get("criterion"), "description": _as_dict(item).get("description"), "points": _as_dict(item).get("points")}
            for item in _as_list(evaluation.get("rubric"))
        ],
    }


def solver_prompts(mission: dict[str, Any]) -> dict[str, str]:
    payload = {"schema_version": "mission_solve_request.v1", "prompt_version": SOLVER_PROMPT_VERSION, "learner_view": learner_view(mission)}
    return {"system": SOLVER_SYSTEM_PROMPT, "user": f"{SOLVER_RULES}\n\nsolve_request:\n{json.dumps(payload, ensure_ascii=False)}"}


def reviewer_prompts(mission: dict[str, Any], solver_result: dict[str, Any]) -> dict[str, str]:
    payload = {
        "schema_version": "mission_review_request.v1",
        "prompt_version": REVIEWER_PROMPT_VERSION,
        "learner_view": learner_view(mission),
        "answer_key": answer_key(mission),
        "solver_result": solver_result,
    }
    return {"system": REVIEWER_SYSTEM_PROMPT, "user": f"{REVIEWER_RULES}\n\nreview_request:\n{json.dumps(payload, ensure_ascii=False)}"}


_LEVELS = {VERDICT_PASS: 0, VERDICT_DOUBT: 1, VERDICT_FAIL: 2}


def effective_severity(issue: dict[str, Any], model_verdict: Any) -> str:
    """문제 항목의 심각도. 칸이 빠졌거나 모르는 값이면 모델이 적은 판정으로 정한다(통과면 참고, 그 밖이면 주의).

    형식을 강제하지 못하는 길에서 이 칸이 빠진 답이 실제로 왔다. 예전에는 무조건 주의로 세어
    모델 스스로 '사소하다'고 적은 항목까지 의심을 만들었다. 모델이 통과라고 적었으면 그 항목을 참고로 본다.
    """

    severity = _as_dict(issue).get("severity")
    if severity in SEVERITIES:
        return str(severity)
    return "note" if model_verdict == VERDICT_PASS else "warning"


def decide(solver_result: dict[str, Any], judgement: dict[str, Any]) -> dict[str, Any]:
    """두 결과에서 통과 / 의심 / 문제를 정하고 이유를 적는다. 모델이 적은 verdict보다 느슨해지지는 않는다.

    문제: 기대 답이 자료와 어긋남, 풀 수 없음, 심각도 error인 문제.
    의심: 푼 답이 기대 답과 다름, 답이 하나가 아닐 수 있음, 기대 답을 자료로 확인할 수 없음, 일부만 풀림, 심각도 warning인 문제.
    심각도 칸이 빠진 문제는 effective_severity로 정하고, 빠진 항목 수를 severity_missing_count로 남긴다.
    직업 사실이 의심스러운 곳(fact_doubts)은 판정을 바꾸지 않고 따로 센다. 사람이 확인할 몫이다.
    """

    solver_result, judgement = _as_dict(solver_result), _as_dict(judgement)
    issues = [_as_dict(item) for item in _as_list(judgement.get("issues"))]
    model_verdict = judgement.get("verdict")
    severities = [effective_severity(item, model_verdict) for item in issues]
    errors = [item for item, severity in zip(issues, severities) if severity == "error"]
    warnings = [item for item, severity in zip(issues, severities) if severity == "warning"]
    missing = sum(1 for item in issues if item.get("severity") not in SEVERITIES)
    reasons: list[tuple[int, str]] = []
    if judgement.get("expected_answer_check") == "wrong":
        reasons.append((2, "기대 답이 자료와 맞지 않는다"))
    if solver_result.get("solvable") == "no":
        reasons.append((2, "풀어 본 쪽이 풀 수 없다고 했다"))
    if errors:
        reasons.append((2, f"심각한 문제 {len(errors)}건"))
    if judgement.get("agreement") in ("partly", "different"):
        reasons.append((1, "푼 답이 기대 답과 " + ("일부 다르다" if judgement.get("agreement") == "partly" else "다르다")))
    if judgement.get("answer_unique") in ("no", "unclear"):
        reasons.append((1, "답이 하나로 정해지지 않을 수 있다"))
    if judgement.get("expected_answer_check") == "doubtful":
        reasons.append((1, "기대 답의 일부를 자료로 확인할 수 없다"))
    if solver_result.get("solvable") == "partly":
        reasons.append((1, "풀어 본 쪽이 일부만 풀 수 있다고 했다"))
    if warnings:
        reasons.append((1, f"주의할 문제 {len(warnings)}건"))
    level = max([score for score, _text in reasons] + [0])
    model_level = _LEVELS.get(str(judgement.get("verdict")), 0)
    if model_level > level:
        reasons.append((model_level, "검수 모델의 판정이 더 엄격하다"))
        level = model_level
    verdict = [VERDICT_PASS, VERDICT_DOUBT, VERDICT_FAIL][level]
    return {
        "verdict": verdict,
        "verdict_label": VERDICT_LABELS[verdict],
        "reasons": [text for _score, text in reasons],
        "error_count": len(errors),
        "warning_count": len(warnings),
        "note_count": sum(1 for severity in severities if severity == "note"),
        "severity_missing_count": missing,
        "rubric_issue_count": sum(1 for item in issues if item.get("kind") == "rubric_not_in_task"),
        "fact_doubt_count": len(_as_list(judgement.get("fact_doubts"))),
        "model_verdict": judgement.get("verdict"),
    }


class MissionReviewer:
    """미션 하나를 두 번의 호출(풀어 보기 → 판정)로 검수한다. 호출부는 생성 때와 같은 call_structured를 쓴다."""

    def __init__(self, runtime: Any = None) -> None:
        self.runtime = runtime or create_runtime()

    def _call(self, call_type: str, prompts: dict[str, str], schema: dict[str, Any], schema_name: str) -> dict[str, Any]:
        config = self.runtime.config
        return self.runtime.call_structured(
            call_type=call_type,
            system_prompt=prompts["system"],
            user_prompt=prompts["user"],
            json_schema=schema,
            temperature=config.repair_temperature,
            max_output_tokens=config.max_output_tokens_repair,
            schema_name=schema_name,
        )

    def review(self, mission: dict[str, Any]) -> dict[str, Any]:
        """검수 기록 하나를 돌려준다. pending 칸은 기록 형식(mission_review.v1)을 지키려고 남기며 늘 None이다."""

        record: dict[str, Any] = {
            "schema_version": REVIEW_SCHEMA,
            "mission_id": mission.get("mission_id"),
            "job_cd": _as_dict(mission.get("job_identity")).get("job_cd"),
            "job_name": _as_dict(mission.get("job_identity")).get("job_smcl_nm"),
            "difficulty": _as_dict(_as_dict(mission.get("mission")).get("difficulty")).get("level"),
            "title": _as_dict(mission.get("mission")).get("title"),
            "versions": {"solver_prompt": SOLVER_PROMPT_VERSION, "reviewer_prompt": REVIEWER_PROMPT_VERSION},
            "reviewed_at": iso_now(),
            "solver_call": None,
            "solver_result": None,
            "review_call": None,
            "judgement": None,
            "pending": None,
        }
        solver_call = self._call("mission_solve", solver_prompts(mission), solver_json_schema(), "mission_solve_v1")
        record["solver_call"] = self._call_summary(solver_call)
        stopped = self._stopped(record, solver_call)
        if stopped is not None:
            return stopped
        record["solver_result"] = solver_call["output_json"]
        review_call = self._call("mission_review", reviewer_prompts(mission, solver_call["output_json"]), reviewer_json_schema(), "mission_review_v1")
        record["review_call"] = self._call_summary(review_call)
        stopped = self._stopped(record, review_call)
        if stopped is not None:
            return stopped
        record["judgement"] = review_call["output_json"]
        record.update(decide(solver_call["output_json"], review_call["output_json"]))
        return record

    @staticmethod
    def _call_summary(call: dict[str, Any]) -> dict[str, Any]:
        """검수 기록에 남길 호출 요약(답 본문은 solver_result / judgement에 따로 둔다)."""

        keep = ("provider", "api", "model", "served_model", "reasoning_effort", "call_type", "status", "attempt_count", "errors", "usage", "usage_recorded", "structured_output_mode")
        return {key: copy.deepcopy(call.get(key)) for key in keep if key in call}

    @staticmethod
    def _stopped(record: dict[str, Any], call: dict[str, Any]) -> dict[str, Any] | None:
        """호출이 답 없이 끝났으면 기록을 닫아 돌려준다. 답이 있으면 None이다."""

        if not isinstance(call.get("output_json"), dict):
            errors = _as_list(call.get("errors")) or [{"code": "REVIEW_CALL_FAILED", "message": "Review call returned no output."}]
            record.update(
                {
                    "verdict": VERDICT_ERROR,
                    "verdict_label": VERDICT_LABELS[VERDICT_ERROR],
                    "reasons": [f"{call.get('call_type')}: {_as_dict(errors[0]).get('code')}"],
                }
            )
            return record
        return None


FIX_SCHEMA = "mission_review_fix.v1"
FIX_RULE = (
    "These errors come from a content review of the finished mission, not from the format validator. Fix each one in the task text, "
    "materials, glossary, or evaluation it points to. Keep every other part as it is, keep the planned answer unless an error says it is wrong, "
    "and make sure evaluation.expected_insights and the rubric still follow from the materials after the fix."
)


def issues_to_fix(judgement: dict[str, Any]) -> list[dict[str, Any]]:
    """검수가 적은 문제 가운데 고쳐 쓰기에 넘길 것(심각·주의)을 검증기 오류와 같은 모양으로 바꾼다. 참고와 사실 의심은 넘기지 않는다."""

    judgement = _as_dict(judgement)
    errors: list[dict[str, Any]] = []
    for issue in _as_list(judgement.get("issues")):
        issue = _as_dict(issue)
        # 심각도가 빠진 항목은 판정(decide)과 같은 규칙으로 본다.
        if effective_severity(issue, judgement.get("verdict")) == "note":
            continue
        errors.append(
            {
                "path": str(issue.get("where") or ""),
                "severity": "fail",
                "code": "REVIEW_" + str(issue.get("kind") or "other").upper(),
                "message": str(issue.get("detail") or ""),
                "required_fix": "Fix this point and nothing else.",
                "repairable": True,
            }
        )
    if judgement.get("expected_answer_check") in ("doubtful", "wrong") and judgement.get("expected_answer_note"):
        errors.append(
            {
                "path": "evaluation.expected_insights",
                "severity": "fail",
                "code": "REVIEW_EXPECTED_ANSWER",
                "message": str(judgement["expected_answer_note"]),
                "required_fix": "Make the expected insights and rubric agree with the materials.",
                "repairable": True,
            }
        )
    return errors


def changed_paths(before: Any, after: Any, path: str = "", limit: int = 40) -> list[str]:
    """두 JSON에서 값이 달라진 곳의 경로. 고쳐 쓰기가 어디를 건드렸는지 기록에 남긴다."""

    found: list[str] = []

    def walk(old: Any, new: Any, where: str) -> None:
        if len(found) >= limit or old == new:
            return
        if isinstance(old, dict) and isinstance(new, dict):
            for key in list(dict.fromkeys(list(old) + list(new))):
                walk(old.get(key), new.get(key), f"{where}.{key}" if where else str(key))
        elif isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
            for index, (left, right) in enumerate(zip(old, new)):
                walk(left, right, f"{where}[{index}]")
        else:
            found.append(where)

    walk(before, after, path)
    return found


class ReviewFixer:
    """검수에서 의심·문제가 붙은 미션을 고쳐 쓴다. 기존 수정 경로(설계서와 인용 원문을 보고 고침)를 그대로 쓴다.

    고친 초안은 생성 때와 같은 검증기와 근거 검사를 거친다. 통과하지 못하면 버리고 원래 미션을 둔다. 원래 미션 파일은 건드리지 않는다.
    """

    def __init__(self, runtime: Any = None) -> None:
        self.runtime = runtime or create_runtime()
        self.repair_manager = RepairManager(runtime=self.runtime)
        self.validator = MissionValidator()
        self.basis_checker = MissionBasisChecker()
        self.assembler = FinalMissionAssembler()

    def fix(self, slot: Path, run_dir: Path, original: dict[str, Any], judgement: dict[str, Any]) -> dict[str, Any]:
        """고쳐 쓰기 기록을 돌려준다. status는 fixed / nothing_to_fix / unsupported / fix_failed / fix_rejected다."""

        record: dict[str, Any] = {"schema_version": FIX_SCHEMA, "status": "nothing_to_fix", "issues_sent": issues_to_fix(judgement), "pending": None, "mission": None}
        if not record["issues_sent"]:
            return record

        def load(name: str) -> Any:
            path = slot / name
            return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

        decisions, package = load("system_decisions.json"), _as_dict(load("llm_input_package.json"))
        draft = load("mission_draft_attempt_1.json") or load("mission_draft_attempt_0.json")
        profile_path = run_dir / "profiles" / f"{slot.parent.name}.json"
        blueprint = package.get("mission_blueprint")
        constraints = _as_dict(package.get("schema_constraints"))
        if not (isinstance(decisions, dict) and isinstance(draft, dict) and isinstance(blueprint, dict) and profile_path.exists() and constraints.get("structured_output_schema")):
            # 두 단계 생성의 산출물(설계서, 초안, 입력 꾸러미)이 있어야 근거를 지키며 고칠 수 있다.
            record["status"] = "unsupported"
            return record
        evidence_names = list(_as_list(_as_dict(constraints.get("material_rules")).get("allowed_evidence_names")))
        request = RepairPromptBuilder().build(
            decisions,
            draft,
            {"errors": record["issues_sent"], "warnings": []},
            evidence_names,
            mission_blueprint=blueprint,
            cited_sources=_as_list(package.get("cited_sources")),
        )
        request["repair_rules"] = request["repair_rules"] + [FIX_RULE]
        repaired = self.repair_manager.repair(repair_request=request, json_schema=constraints["structured_output_schema"])
        call = repaired["llm_call_result"]
        record["repair_call"] = MissionReviewer._call_summary(call)
        fixed_draft = repaired.get("mission_draft")
        if not isinstance(fixed_draft, dict):
            record["status"] = "fix_failed"
            return record
        basis_map = fixed_draft.get("basis_map") if isinstance(fixed_draft.get("basis_map"), dict) else None
        stripped = {key: value for key, value in fixed_draft.items() if key != "basis_map"}
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        validation = self.validator.validate(job_profile=profile, system_decisions=decisions, mission_output_draft=stripped, attempt=1)
        basis_check = self.basis_checker.check(
            mission_draft=stripped, basis_map=basis_map, blueprint=blueprint, attempt=1, difficulty=_as_dict(decisions.get("difficulty"))
        )
        problems = [_as_dict(item).get("code") for item in _as_list(validation.get("errors")) + _as_list(basis_check.get("errors"))]
        record["validation"] = {"status": validation.get("status"), "error_codes": problems}
        if validation.get("status") != "pass" or problems:
            record["status"] = "fix_rejected"
            return record
        mission = self.assembler.assemble(
            mission_output_draft=stripped,
            validator_result=validation,
            job_cd=slot.parent.name,
            difficulty_code=slot.name,
            repair_count=int(_as_dict(original.get("reliability")).get("repair_count") or 0) + 1,
        )
        record.update({"status": "fixed", "mission": mission, "changed": changed_paths(original, mission)})
        return record


def find_missions(run_dir: Path, jobs: list[str] | None = None, difficulties: list[str] | None = None) -> list[Path]:
    """실행 폴더에서 저장된 미션 파일을 직업·난이도 순서로 찾는다."""

    order = {"easy": 0, "normal": 1, "hard": 2}
    found = []
    for path in sorted((run_dir / "jobs").glob("*/*/mission_output.json")):
        job_cd, difficulty = path.parent.parent.name, path.parent.name
        if (jobs is None or job_cd in jobs) and (difficulties is None or difficulty in difficulties):
            found.append((job_cd, order.get(difficulty, 9), path))
    return [path for _job, _rank, path in sorted(found, key=lambda item: (item[0], item[1]))]


def _cell(text: Any) -> str:
    return str(text if text is not None else "").replace("|", "/").replace("\n", " ").strip()


FIX_LABELS = {
    "fixed": "고침",
    "nothing_to_fix": "넘길 문제 없음",
    "unsupported": "고칠 수 없음(두 단계 산출물 없음)",
    "fix_failed": "고쳐 쓰기 호출 실패",
    "fix_rejected": "고친 초안이 검증에 걸려 버림",
}


def render_summary(records: list[dict[str, Any]], run_dir: Path) -> str:
    """사람이 보는 검수 요약(Markdown). 의심과 문제가 붙은 미션의 이유를 아래에 풀어 적는다."""

    counts: dict[str, int] = {}
    for record in records:
        counts[record["verdict_label"]] = counts.get(record["verdict_label"], 0) + 1
    lines = [
        f"# 미션 검수 요약 ({run_dir.name})",
        "",
        f"미션 {len(records)}개: " + " · ".join(f"{label} {count}" for label, count in counts.items()),
        "",
        f"심각도 칸이 빠진 문제 항목 {sum(int(record.get('severity_missing_count') or 0) for record in records)}건"
        f"(미션 {sum(1 for record in records if record.get('severity_missing_count'))}개). 빠진 항목은 모델 판정이 통과면 참고, 그 밖이면 주의로 셌다(표시: '칸 빠짐').",
        f"채점 기준이 지시문에 없는 것을 본다는 지적(rubric_not_in_task) {sum(int(record.get('rubric_issue_count') or 0) for record in records)}건"
        f"(미션 {sum(1 for record in records if record.get('rubric_issue_count'))}개).",
        "",
        "모델이 학습자처럼 풀어 보고(기대 답은 숨김), 다른 호출이 그 답을 기대 답과 견준 결과다. 원래 미션 파일은 고치지 않았다.",
        "직업 사실이 실제와 맞는지는 이 검수가 보증하지 못한다. '사실 의심' 수는 사람이 확인할 곳의 수다.",
        "",
        "| 직업 | 난이도 | 미션 | 판정 | 푼 답과 기대 답 | 기대 답 확인 | 답이 하나인가 | 문제(심각·주의) | 사실 의심 | 예상 풀이(분) | 고쳐 쓰기 → 다시 검수 |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    agreement = {"same": "같음", "partly": "일부 다름", "different": "다름"}
    checked = {"correct": "맞음", "doubtful": "확인 안 됨", "wrong": "틀림"}
    unique = {"yes": "예", "no": "아니오", "unclear": "불분명"}
    for record in records:
        judgement, solver, fix = _as_dict(record.get("judgement")), _as_dict(record.get("solver_result")), _as_dict(record.get("fix"))
        after = _as_dict(fix.get("review_after"))
        fix_cell = ""
        if fix:
            fix_cell = FIX_LABELS.get(fix.get("status"), str(fix.get("status")))
            if after.get("verdict_label"):
                fix_cell += f" → {after['verdict_label']}"
        lines.append(
            f"| {_cell(record.get('job_name'))} | {_cell(record.get('difficulty'))} | {_cell(record.get('title'))} | **{record['verdict_label']}** | "
            f"{agreement.get(judgement.get('agreement'), '')} | {checked.get(judgement.get('expected_answer_check'), '')} | "
            f"{unique.get(judgement.get('answer_unique'), '')} | {record.get('error_count', '')}·{record.get('warning_count', '')} | "
            f"{record.get('fact_doubt_count', '')} | {_cell(solver.get('minutes_estimate'))} | {fix_cell} |"
        )
    severity = {"error": "심각", "warning": "주의", "note": "참고"}

    def detail_lines(judgement: dict[str, Any], reasons: list[str]) -> list[str]:
        out = []
        if reasons:
            out.append("- 판정 이유: " + " / ".join(reasons))
        if judgement.get("summary"):
            out.append(f"- 검수 의견: {_cell(judgement['summary'])}")
        if judgement.get("agreement") in ("partly", "different") and judgement.get("agreement_note"):
            out.append(f"- 푼 답과 다른 점: {_cell(judgement['agreement_note'])}")
        if judgement.get("expected_answer_check") in ("doubtful", "wrong") and judgement.get("expected_answer_note"):
            out.append(f"- 기대 답: {_cell(judgement['expected_answer_note'])}")
        for issue in _as_list(judgement.get("issues")):
            issue = _as_dict(issue)
            label = severity[effective_severity(issue, judgement.get("verdict"))]
            if issue.get("severity") not in SEVERITIES:
                label += "·칸 빠짐"
            out.append(f"- [{label}] {_cell(issue.get('where'))}: {_cell(issue.get('detail'))} ({_cell(issue.get('kind'))}, {_cell(issue.get('raised_by'))})")
        for doubt in _as_list(judgement.get("fact_doubts")):
            doubt = _as_dict(doubt)
            out.append(f"- [사실 의심] {_cell(doubt.get('claim'))} — {_cell(doubt.get('why'))}")
        return out

    for record in records:
        judgement, fix = _as_dict(record.get("judgement")), _as_dict(record.get("fix"))
        if record["verdict"] == VERDICT_PASS and not _as_list(judgement.get("fact_doubts")) and not _as_list(judgement.get("issues")) and not fix:
            continue
        lines += ["", f"## {_cell(record.get('job_name'))} · {_cell(record.get('difficulty'))} · {_cell(record.get('title'))} — {record['verdict_label']}", ""]
        lines += detail_lines(judgement, list(record.get("reasons") or []))
        if record["verdict"] == VERDICT_ERROR:
            lines.append("- 검수 호출이 실패했다. 다시 돌린다.")
        if fix:
            lines += ["", f"### 고쳐 쓰기: {FIX_LABELS.get(fix.get('status'), fix.get('status'))}", ""]
            lines.append(f"- 넘긴 문제 {len(_as_list(fix.get('issues_sent')))}건")
            if fix.get("validation"):
                lines.append(f"- 고친 초안의 검증: {_as_dict(fix['validation']).get('status')} {_as_dict(fix['validation']).get('error_codes') or ''}".rstrip())
            if fix.get("changed"):
                lines.append("- 바뀐 곳: " + ", ".join(f"`{item}`" for item in fix["changed"]))
            if fix.get("mission_file"):
                lines.append(f"- 고친 미션: `{fix['mission_file']}` (원래 미션 파일은 그대로다)")
            after = _as_dict(fix.get("review_after"))
            if after:
                lines += ["", f"### 고친 뒤 다시 검수: {after.get('verdict_label')}", ""]
                lines += detail_lines(_as_dict(after.get("judgement")), list(after.get("reasons") or []))
    return "\n".join(lines) + "\n"


def review_run(
    run_dir: str | Path,
    *,
    out_dir: str | Path | None = None,
    runtime: Any = None,
    jobs: list[str] | None = None,
    difficulties: list[str] | None = None,
    fix: bool = False,
) -> dict[str, Any]:
    """실행 폴더의 저장된 미션을 모두 검수하고 기록과 요약을 쓴다. 미션 파일은 읽기만 한다.

    fix를 켜면 의심·문제가 붙은 미션을 고쳐 쓰고(검수가 적은 심각·주의 문제를 넘긴다), 고친 미션을 검수 결과 폴더의
    fixed/ 아래에 따로 저장한 뒤 다시 검수한다. 고쳐 쓰기는 한 번만 한다.
    """

    run_path = Path(run_dir)
    out_path = Path(out_dir) if out_dir is not None else run_path / "review"
    out_path.mkdir(parents=True, exist_ok=True)
    reviewer = MissionReviewer(runtime)
    fixer = ReviewFixer(reviewer.runtime) if fix else None
    records: list[dict[str, Any]] = []

    for path in find_missions(run_path, jobs, difficulties):
        mission = json.loads(path.read_text(encoding="utf-8"))
        record = reviewer.review(mission)
        record["mission_file"] = path.relative_to(run_path).as_posix()
        name = f"{path.parent.parent.name}_{path.parent.name}"
        if fixer is not None and record["verdict"] in (VERDICT_DOUBT, VERDICT_FAIL):
            fixed = fixer.fix(path.parent, run_path, mission, _as_dict(record.get("judgement")))
            fixed_mission = fixed.pop("mission", None)
            if fixed_mission is not None:
                fixed_path = out_path / "fixed" / name / "mission_output.json"
                fixed_path.parent.mkdir(parents=True, exist_ok=True)
                fixed_path.write_text(json.dumps(fixed_mission, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
                fixed["mission_file"] = fixed_path.relative_to(out_path).as_posix()
                second = reviewer.review(fixed_mission)
                fixed["review_after"] = {
                    key: second.get(key)
                    for key in (
                    "verdict", "verdict_label", "reasons", "error_count", "warning_count", "severity_missing_count", "rubric_issue_count",
                    "fact_doubt_count", "solver_result", "judgement", "solver_call", "review_call",
                )
                }
            record["fix"] = fixed
        records.append(record)
        (out_path / f"{name}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    counts: dict[str, int] = {}
    for record in records:
        counts[record["verdict"]] = counts.get(record["verdict"], 0) + 1
    config = reviewer.runtime.config
    summary: dict[str, Any] = {
        "schema_version": "mission_review_summary.v1",
        "run_dir": run_path.as_posix(),
        "reviewed_at": iso_now(),
        "reviewed_by": {"provider": config.provider, "model": config.model, "reasoning_effort": config.reasoning_effort},
        "versions": {"solver_prompt": SOLVER_PROMPT_VERSION, "reviewer_prompt": REVIEWER_PROMPT_VERSION},
        "mission_count": len(records),
        "counts": counts,
        # 답을 기다리는 길이 없으므로 늘 0이다. 요약 형식(mission_review_summary.v1)을 지키려고 칸은 남긴다.
        "pending_count": 0,
        "fact_doubt_count": sum(int(record.get("fact_doubt_count") or 0) for record in records),
        "severity_missing_count": sum(int(record.get("severity_missing_count") or 0) for record in records),
        "rubric_issue_count": sum(int(record.get("rubric_issue_count") or 0) for record in records),
        "missions": [
            {
                key: record.get(key)
                for key in (
                    "job_cd", "job_name", "difficulty", "mission_id", "title", "verdict", "verdict_label", "reasons", "error_count", "warning_count",
                    "severity_missing_count", "rubric_issue_count", "fact_doubt_count", "mission_file",
                )
            }
            for record in records
        ],
    }
    if fix:
        fixes = [_as_dict(record.get("fix")) for record in records if record.get("fix")]
        statuses: dict[str, int] = {}
        after: dict[str, int] = {}
        for item in fixes:
            statuses[str(item.get("status"))] = statuses.get(str(item.get("status")), 0) + 1
            verdict = _as_dict(item.get("review_after")).get("verdict")
            if verdict:
                after[str(verdict)] = after.get(str(verdict), 0) + 1
        summary["fix"] = {"attempted": len(fixes), "statuses": statuses, "verdict_after_fix": after}
    (out_path / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (out_path / "summary.md").write_text(render_summary(records, run_path), encoding="utf-8", newline="\n")
    summary["out_dir"] = out_path.as_posix()
    return summary


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="저장된 미션을 모델이 풀어 보고 기대 답과 견주어 통과/의심/문제를 남긴다. 원래 미션은 고치지 않는다.")
    parser.add_argument("--run-dir", required=True, help="미션 생성 실행 폴더(pilot_v1_…). 그 안의 jobs/*/*/mission_output.json을 검수한다")
    parser.add_argument("--out", default=None, help="검수 기록과 요약을 쓸 폴더. 비우면 실행 폴더의 review/")
    parser.add_argument("--jobs", default=None, help="이 직업만(쉼표로 구분)")
    parser.add_argument("--difficulties", default=None, help="이 난이도만(쉼표로 구분)")
    parser.add_argument("--fix", action="store_true", help="의심·문제가 붙은 미션을 고쳐 쓰고(한 번) 다시 검수한다. 고친 미션은 검수 결과 폴더의 fixed/에 따로 둔다")
    args = parser.parse_args(argv)

    def codes(value: str | None) -> list[str] | None:
        return [code.strip() for code in value.split(",") if code.strip()] if value else None

    summary = review_run(args.run_dir, out_dir=args.out, jobs=codes(args.jobs), difficulties=codes(args.difficulties), fix=args.fix)
    print(f"미션 {summary['mission_count']}개: " + " · ".join(f"{VERDICT_LABELS.get(key, key)} {count}" for key, count in summary["counts"].items()))
    if args.fix:
        print(f"고쳐 쓰기: {summary['fix']}")
    print(f"저장: {summary['out_dir']}/summary.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
