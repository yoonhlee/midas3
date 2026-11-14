# 근거 기록(generation_basis.v1): 미션 하나가 어떤 데이터의 어느 부분에서, 누구의 판단으로 나왔는지를 일곱 단계로 묶는다.
#
# 단계마다 종류를 붙인다. data = 코드가 조회한 데이터, link_decision = 문장과 능력단위를 이은 판단(입력으로 받음),
# ai_decision = 설계서·작성 모델의 판단(이유와 원문 대조 결과를 함께 남김), rule = 난이도 규칙.

from __future__ import annotations

import copy
import json
from typing import Any

from .basis_source_pack import contains_verbatim, pieces_by_id, squash
from .blueprint_designer import BLUEPRINT_PROMPT_VERSION
from .draft_generator import WRITER_PROMPT_VERSION
from .utils import iso_now

GENERATION_BASIS_SCHEMA = "generation_basis.v1"


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _link_decided_by(link_meta: dict[str, Any]) -> str:
    """3단계(문장 → 능력단위)의 '정한 주체'에 적을 글. 연결 판단이 있으면 늘 비어 있지 않다.

    연결 자료에 판단한 주체(judged_by)가 적혀 있으면 그대로 쓴다. 그 칸이 없는 자료에서는 기준과 판단한 날로 적는다.
    """

    judged_by = link_meta.get("judged_by")
    if judged_by:
        return str(judged_by)
    parts = ["연결 판단"]
    if link_meta.get("criteria"):
        parts.append(f"기준 {link_meta['criteria']}")
    if link_meta.get("judged_at"):
        parts.append(str(link_meta["judged_at"]))
    return " · ".join(parts)


class GenerationBasisAssembler:
    """자료 묶음, 설계서, 검사 결과, 최종 미션을 근거 기록 하나로 조립한다. 입력은 바꾸지 않는다."""

    def assemble(
        self,
        *,
        final_mission: dict[str, Any],
        source_pack: dict[str, Any],
        blueprint: dict[str, Any],
        blueprint_check: dict[str, Any],
        basis_map: dict[str, Any] | None,
        basis_check: dict[str, Any],
        system_decisions: dict[str, Any],
        blueprint_call: dict[str, Any],
        writer_call: dict[str, Any],
        artifacts: dict[str, str],
        blueprint_attempt: int = 0,
        repair_count: int = 0,
        material_mix: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        pieces = pieces_by_id(source_pack)

        def piece(piece_id: Any) -> dict[str, Any]:
            found = pieces.get(piece_id)
            if found is None:
                return {"id": piece_id, "kind": None, "text": None, "locator": {}}
            return {"id": found["id"], "kind": found["kind"], "text": found["text"], "locator": copy.deepcopy(found.get("locator", {}))}

        def refs(items: Any) -> list[dict[str, Any]]:
            return [piece(ref) for ref in _as_list(items)]

        mission = _as_dict(final_mission.get("mission"))
        materials = _as_list(mission.get("materials"))
        tasks = _as_list(mission.get("tasks"))
        rubric = _as_list(_as_dict(final_mission.get("evaluation")).get("rubric"))
        glossary = [squash(_as_dict(entry).get("term")) for entry in _as_list(_as_dict(mission.get("scenario")).get("glossary"))]
        models = {"blueprint": self._model_info(blueprint_call), "writer": self._model_info(writer_call)}
        # mock으로 만든 것을 실제 모델이 정한 것처럼 적지 않는다.
        blueprint_model = self._decider(models["blueprint"])
        writer_model = self._decider(models["writer"])

        link_piece = pieces.get("M.1")
        link_meta = _as_dict(link_piece.get("meta")) if link_piece else {}
        unit_meta = _as_dict(pieces.get("N.unit", {}).get("meta"))
        link_rows = [
            item["id"]
            for item in source_pack.get("pieces", [])
            if item.get("kind") == "link_row" and _as_dict(item.get("meta")).get("matches_unit_duty")
        ]

        link_step: dict[str, Any] = {
            "step": 3,
            "title": "문장 → 능력단위",
            "kind": "link_decision",
            # 연결 판단 자체가 없으면(M.1 조각 없음) 정한 주체도 비워 둔다. 없는 판단을 있는 것처럼 적지 않는다.
            "decided_by": _link_decided_by(link_meta) if link_piece else None,
            "match": link_meta.get("match"),
            "reason": link_piece.get("text") if link_piece else None,
            "criteria": link_meta.get("criteria"),
            "sources": refs((["M.1"] if link_piece else []) + ["N.unit"]),
        }
        # v0.3 연결 판단이 남긴 구절, 2차 판정, 맞는 수행준거. 값이 없는 옛 연결에는 키를 만들지 않는다.
        for key in ("phrase", "verdict", "verdict_reason"):
            if link_meta.get(key):
                link_step[key] = link_meta[key]
        if _as_list(link_meta.get("criteria_refs")):
            link_step["criteria_refs"] = [
                {
                    "number": str(number),
                    "ref": f"N.c.{number}",
                    "text": pieces.get(f"N.c.{number}", {}).get("text"),
                    "element_name": _as_dict(pieces.get(f"N.c.{number}", {}).get("meta")).get("element_name"),
                }
                for number in _as_list(link_meta.get("criteria_refs"))
            ]

        # 설계서가 고른 수행준거. 연결 판단이 근거로 든 번호가 있으면, 고른 것이 그 안에 있는지도 적는다.
        linked_refs = {f"N.c.{number}" for number in _as_list(link_meta.get("criteria_refs"))}
        criteria_items: list[dict[str, Any]] = []
        for item in _as_list(blueprint.get("criteria")):
            ref = _as_dict(item).get("ref")
            entry = {
                "ref": ref,
                "text": pieces.get(ref, {}).get("text"),
                "element_name": _as_dict(pieces.get(ref, {}).get("meta")).get("element_name"),
                "reason": _as_dict(item).get("reason"),
            }
            if linked_refs:
                entry["in_link_basis"] = ref in linked_refs
            criteria_items.append(entry)

        chain: list[dict[str, Any]] = [
            {
                "step": 1,
                "title": "직업 → 하는 일 문장",
                "kind": "data",
                "decided_by": "실행 대상 지정",
                "sources": refs([source_pack.get("target_exec_ref")]),
            },
            {
                "step": 2,
                "title": "직업 → NCS 직무",
                "kind": "data",
                "decided_by": "코드 조회",
                "sources": refs((["K.keco"] if "K.keco" in pieces else []) + link_rows),
                "link_table": copy.deepcopy(source_pack.get("link_table", {})),
            },
            link_step,
            {
                "step": 4,
                "title": "능력단위 → 수행준거",
                "kind": "ai_decision",
                "decided_by": blueprint_model,
                "items": criteria_items,
            },
            {
                "step": 5,
                "title": "수행준거·서류 → 자료·과제",
                "kind": "ai_decision",
                "decided_by": blueprint_model,
                "focus": copy.deepcopy(_as_dict(blueprint.get("focus"))),
                "materials": self._materials(blueprint, materials, pieces, refs),
                "tasks": [
                    {
                        "slot": _as_dict(plan).get("slot"),
                        "task_id": _as_dict(tasks[position]).get("task_id") if position < len(tasks) else None,
                        "action": _as_dict(plan).get("action"),
                        "reason": _as_dict(plan).get("reason"),
                        "refs": refs(_as_dict(plan).get("refs")),
                    }
                    for position, plan in enumerate(_as_list(blueprint.get("tasks")))
                ],
                "glossary": [
                    {
                        "term": _as_dict(term).get("term"),
                        "ref": _as_dict(term).get("ref"),
                        "in_mission": self._in_glossary(_as_dict(term).get("term"), glossary),
                    }
                    for term in _as_list(blueprint.get("glossary_terms"))
                ],
            },
            {
                "step": 6,
                "title": "평가 지침·KNOW 항목 → 채점 기준",
                "kind": "ai_decision",
                "decided_by": f"{blueprint_model} · {writer_model}",
                "items": self._rubric_items(blueprint, rubric, basis_map, refs),
            },
            {
                "step": 7,
                "title": "난이도 규칙",
                "kind": "rule",
                "decided_by": "시스템 결정",
                "values": {
                    **{
                        key: copy.deepcopy(_as_dict(system_decisions.get("difficulty")).get(key))
                        for key in ("level", "material_count_range", "task_count_range", "answer_length_hint")
                    },
                    "allowed_material_types": list(_as_list(system_decisions.get("allowed_material_types"))),
                },
            },
        ]
        if material_mix is not None:
            # 자료 형태 배정(material_planner)이 허용 형태를 좁혔다. 모델이 아니라 코드가 정했고, 그 이유와 걸린 원문 조각을 남긴다.
            chain[-1]["material_mix"] = self._material_mix(material_mix, pieces)

        warning_items = (
            [copy.deepcopy(item) for item in _as_list(source_pack.get("warnings"))]
            + [copy.deepcopy(item) for item in _as_list(blueprint_check.get("warnings"))]
            + [copy.deepcopy(item) for item in _as_list(basis_check.get("warnings"))]
        )
        versions = {
            "blueprint_prompt": BLUEPRINT_PROMPT_VERSION,
            "writer_prompt": WRITER_PROMPT_VERSION,
            "ncs_cl_cd": unit_meta.get("ncs_cl_cd"),
            "link_table_file": _as_dict(source_pack.get("link_table")).get("file"),
            "know_source_root": source_pack.get("know_source_root"),
        }
        return {
            "schema_version": GENERATION_BASIS_SCHEMA,
            "mode": "two_stage",
            "mission_id": final_mission.get("mission_id"),
            "job_cd": _as_dict(final_mission.get("job_identity")).get("job_cd"),
            "difficulty": _as_dict(mission.get("difficulty")).get("level"),
            "generated_at": iso_now(),
            "chain": chain,
            # 설계서를 다시 썼는지, 미션을 수정 호출로 고쳤는지. 고친 미션도 설계서를 보고 고친다.
            "process": {
                "blueprint_attempt": blueprint_attempt,
                "blueprint_rewritten": blueprint_attempt > 0,
                "repair_count": repair_count,
                "mission_repaired": repair_count > 0,
            },
            "models": models,
            "versions": versions,
            "checks": {
                "error_count": len(_as_list(blueprint_check.get("errors"))) + len(_as_list(basis_check.get("errors"))),
                "warning_count": len(warning_items),
                "items": warning_items,
            },
            "artifacts": dict(artifacts),
        }

    @staticmethod
    def _material_mix(mix: dict[str, Any], pieces: dict[str, Any]) -> dict[str, Any]:
        """배정 기록을 근거 기록에 옮긴다. 허용한 형태마다 어울림 정도와 걸린 낱말·조각(원문 포함)을 붙인다."""

        signals = _as_dict(mix.get("signals"))
        allowed = [str(kind) for kind in _as_list(mix.get("allowed_material_types"))]
        why = []
        for kind in allowed:
            signal = _as_dict(signals.get(kind))
            why.append(
                {
                    "type": kind,
                    "fit": signal.get("fit"),
                    "score": signal.get("score"),
                    "evidence": [
                        {
                            "id": _as_dict(item).get("id"),
                            "word": _as_dict(item).get("word"),
                            "text": _as_dict(item).get("text") or pieces.get(_as_dict(item).get("id"), {}).get("text"),
                        }
                        for item in _as_list(signal.get("evidence"))
                    ],
                }
            )
        return {
            "decided_by": "코드 (자료 형태 배정, 모델 호출 없음)",
            "rule_version": mix.get("rule_version"),
            "allowed_material_types": allowed,
            "lead_data_type": mix.get("lead_data_type"),
            "standard_type": mix.get("standard_type"),
            "spare_types": list(_as_list(mix.get("spare_types"))),
            "shared_types": list(_as_list(mix.get("shared_types"))),
            "job_types": copy.deepcopy(_as_dict(mix.get("job_types"))),
            "reason": mix.get("reason"),
            "why": why,
        }

    @staticmethod
    def _model_info(call: dict[str, Any]) -> dict[str, Any]:
        requested = call.get("model")
        info = {
            "provider": call.get("provider"),
            "requested_model": requested,
            "served_model": call.get("served_model") or requested,
            "reasoning_effort": call.get("reasoning_effort"),
            "fallback_used": bool(call.get("fallback_used")),
            # strict = JSON 고정 출력, prompted = 형식을 프롬프트로만 알리고 코드가 검증(형식이 커서 고정 출력을 못 쓴 경우)
            "structured_output": call.get("structured_output_mode"),
        }
        return info

    @staticmethod
    def _decider(model_info: dict[str, Any]) -> str:
        """단계의 '정한 주체'에 적을 이름. mock 실행이면 모델 이름 대신 mock이라고 적는다."""

        if model_info.get("provider") == "mock":
            return "mock (API 호출 없음)"
        return str(model_info.get("served_model"))

    @staticmethod
    def _in_glossary(term: Any, glossary: list[str]) -> bool:
        word = squash(term)
        return bool(word) and any(word in entry or (entry and entry in word) for entry in glossary)

    @staticmethod
    def _materials(blueprint: dict[str, Any], materials: list[Any], pieces: dict[str, Any], refs: Any) -> list[dict[str, Any]]:
        """설계서의 자료 계획을 slot 순서로 미션 자료와 짝짓고, 가져온 낱말이 원문과 미션에 있는지 적는다."""

        plans = sorted((_as_dict(plan) for plan in _as_list(blueprint.get("materials"))), key=lambda plan: plan.get("slot") or 0)
        result: list[dict[str, Any]] = []
        for position, plan in enumerate(plans):
            material = _as_dict(materials[position]) if position < len(materials) else {}
            material_text = json.dumps(material, ensure_ascii=False) if material else ""
            entry = (
                {
                    "slot": plan.get("slot"),
                    "material_id": material.get("material_id"),
                    "material_title": material.get("title"),
                    "type": plan.get("type"),
                    "role": plan.get("role"),
                    "content_plan": plan.get("content_plan"),
                    "refs": refs(plan.get("refs")),
                    "borrowed_terms": [
                        {
                            "term": _as_dict(term).get("term"),
                            "ref": _as_dict(term).get("ref"),
                            "in_source": contains_verbatim(pieces.get(_as_dict(term).get("ref"), {}).get("text"), _as_dict(term).get("term")),
                            "in_mission": contains_verbatim(material_text, _as_dict(term).get("term")),
                        }
                        for term in _as_list(plan.get("borrowed_terms"))
                    ],
                }
            )
            # 형태를 고른 이유(blueprint-v7부터). 없는 옛 설계서에는 키를 만들지 않는다.
            if plan.get("type_reason"):
                entry["type_reason"] = plan["type_reason"]
            result.append(entry)
        return result

    @staticmethod
    def _rubric_items(blueprint: dict[str, Any], rubric: list[Any], basis_map: dict[str, Any] | None, refs: Any) -> list[dict[str, Any]]:
        """채점 기준마다 basis_map이 가리킨 설계서 채점 근거를 붙인다. 짝이 없으면 근거 칸을 비운다."""

        plans = _as_list(blueprint.get("evaluation_basis"))
        entries = [_as_dict(entry) for entry in _as_list(_as_dict(basis_map).get("rubric"))]
        items: list[dict[str, Any]] = []
        for rubric_index, criterion in enumerate(rubric):
            criterion = _as_dict(criterion)
            matches = [entry.get("evaluation_basis_index") for entry in entries if entry.get("rubric_index") == rubric_index]
            basis_index = matches[0] if len(matches) == 1 and isinstance(matches[0], int) and 0 <= matches[0] < len(plans) else None
            plan = _as_dict(plans[basis_index]) if basis_index is not None else {}
            items.append(
                {
                    "rubric_index": rubric_index,
                    "criterion": criterion.get("criterion"),
                    "points": criterion.get("points"),
                    "evaluation_basis_index": basis_index,
                    "what_to_check": plan.get("what_to_check"),
                    "reason": plan.get("reason"),
                    "refs": refs(plan.get("refs")),
                    "know_refs": refs(plan.get("know_refs")),
                }
            )
        return items
