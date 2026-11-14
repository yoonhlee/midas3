# 두 단계 생성의 코드 검사: 설계서가 근거 자료 묶음에 맞는지, 쓰인 미션이 설계서에 맞는지 본다.
#
# 오류와 경고는 validator와 같은 모양으로 낸다. 오류는 다시 쓰게 하는 사유가 되고, 경고는 근거 기록에 남는다.

from __future__ import annotations

import json
import re
from typing import Any

from .basis_source_pack import contains_verbatim, link_basis, pieces_by_id, squash

_KNOW_REF_PREFIXES = ("K.act.", "K.abil.", "K.know.")

# 답 분량 표현. 난이도 값은 영어("3-4 short sentences"), 학습자가 보는 글은 한국어("3~4문장")다.
_RANGE_EN = re.compile(r"(\d+)\s*-\s*(\d+)")
_RANGE_KO = re.compile(r"(?<![\d.])(\d+)\s*[~∼〜～]\s*(\d+)\s*문장")
_SINGLE_KO = re.compile(r"(?<![가-힣\d~∼〜～\-])(\d+|한두|두세|서너|세네|다섯|한|두|세|네)\s*문장")
# 분량이 과제마다임을 밝히는 말("과제마다 3~5문장", "과제별", "각 과제").
_PER_TASK_KO = re.compile(r"과제\s*마다|과제\s*별|각\s*과제")
_KOREAN_COUNTS = {"한": (1, 1), "두": (2, 2), "세": (3, 3), "네": (4, 4), "다섯": (5, 5), "한두": (1, 2), "두세": (2, 3), "서너": (3, 4), "세네": (3, 4)}
# "N문장" 뒤에 이런 말이 오면 분량을 말하는 것으로 본다("두 문장의 요구사항"처럼 분량이 아닌 말은 거른다).
_LENGTH_FOLLOWERS = ("으로", "로", "이내", "이하", "이상", "까지", "정도", "씩", "안", "에", "만", ".", ",", ")", "·", "/")


def parse_length_range(answer_length_hint: Any) -> tuple[int, int] | None:
    """난이도의 분량 값("3-4 short sentences", "3-5 short sentences per task")에서 (아래, 위)를 읽는다."""

    match = _RANGE_EN.search(str(answer_length_hint or ""))
    return (int(match.group(1)), int(match.group(2))) if match else None


def korean_length_hint(answer_length_hint: Any) -> str:
    """난이도의 분량 값을 제출 형식에 쓸 한국어("3~4문장", 과제마다면 "과제마다 3~5문장")로 바꾼다. 읽지 못하면 빈 글."""

    parsed = parse_length_range(answer_length_hint)
    if parsed is None:
        return ""
    text = f"{parsed[0]}~{parsed[1]}문장"
    return f"과제마다 {text}" if "per task" in str(answer_length_hint) else text


def length_mentions(text: Any) -> list[dict[str, Any]]:
    """글에서 답 분량을 말하는 곳을 찾는다. 범위("1~2문장")와 개수("한 문장으로", "2문장 이내")를 돌려준다."""

    text = str(text or "")
    found: list[dict[str, Any]] = []
    taken: list[tuple[int, int]] = []
    for match in _RANGE_KO.finditer(text):
        found.append({"text": match.group(0), "low": int(match.group(1)), "high": int(match.group(2)), "kind": "range"})
        taken.append(match.span())
    for match in _SINGLE_KO.finditer(text):
        if any(start <= match.start() < end for start, end in taken):
            continue
        rest = text[match.end():].lstrip()
        if rest and not rest.startswith(_LENGTH_FOLLOWERS):
            continue
        word = match.group(1)
        low, high = (int(word), int(word)) if word.isdigit() else _KOREAN_COUNTS[word]
        bound = next((mark for mark in ("이내", "이하", "까지", "이상") if rest.startswith(mark)), "")
        found.append({"text": match.group(0), "low": low, "high": high, "kind": "count", "bound": bound})
    return found


def length_agrees(mention: dict[str, Any], expected: tuple[int, int]) -> bool:
    """찾은 분량이 난이도의 범위와 같은 말인가. "2문장 이내"는 위 끝, "1문장 이상"은 아래 끝만 견준다."""

    bound = mention.get("bound")
    if mention.get("kind") == "count" and mention["low"] == mention["high"] and bound in ("이내", "이하", "까지"):
        return mention["high"] == expected[1]
    if mention.get("kind") == "count" and mention["low"] == mention["high"] and bound == "이상":
        return mention["low"] == expected[0]
    return (mention["low"], mention["high"]) == expected


def _issue(code: str, path: str, message: str, required_fix: str, severity: str = "fail") -> dict[str, Any]:
    return {
        "path": path,
        "severity": severity,
        "code": code,
        "message": message,
        "required_fix": required_fix,
        "repairable": True,
    }


def _result(schema_version: str, attempt: int, errors: list[dict[str, Any]], warnings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": schema_version,
        "attempt": attempt,
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


class BlueprintChecker:
    """설계서(mission_blueprint.v1)의 번호, 개수, 원문 인용을 검사한다."""

    def check(
        self,
        *,
        blueprint: dict[str, Any] | None,
        source_pack: dict[str, Any],
        system_decisions: dict[str, Any],
        attempt: int = 0,
    ) -> dict[str, Any]:
        blueprint = _as_dict(blueprint)
        pieces = pieces_by_id(source_pack)
        # 설계서 프롬프트에 넣은 조각만 가리킬 수 있다. 기록용 조각(K.keco, L.*, M.1)은 묶음에 있어도 안 된다.
        valid = {piece_id for piece_id, piece in pieces.items() if piece.get("in_prompt")}
        errors: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []

        def known(ref: Any, path: str) -> bool:
            if ref in valid:
                return True
            errors.append(
                _issue("BP_REF_UNKNOWN", path, f"{ref!r} is not a piece id given in the request.", "Use only ids from pieces.")
            )
            return False

        def term_in_source(item: Any, path: str) -> None:
            item = _as_dict(item)
            ref, term = item.get("ref"), item.get("term")
            if not known(ref, f"{path}.ref"):
                return
            if not contains_verbatim(pieces[ref]["text"], term):
                errors.append(
                    _issue(
                        "BP_TERM_NOT_IN_SOURCE",
                        f"{path}.term",
                        f"{term!r} does not appear in the text of {ref}.",
                        "Copy the term exactly from the cited piece, or cite the piece that contains it.",
                    )
                )

        target_ref = source_pack.get("target_exec_ref")
        focus = _as_dict(blueprint.get("focus"))
        if focus.get("exec_ref") != target_ref:
            errors.append(
                _issue("BP_FOCUS_EXEC_MISMATCH", "focus.exec_ref", f"focus.exec_ref must be {target_ref}.", f"Set focus.exec_ref to {target_ref}.")
            )
        sentence = pieces.get(target_ref, {}).get("text", "")
        if not contains_verbatim(sentence, focus.get("focus_phrase")):
            errors.append(
                _issue(
                    "BP_FOCUS_NOT_IN_SENTENCE",
                    "focus.focus_phrase",
                    "focus.focus_phrase is not copied exactly from the target sentence.",
                    "Copy a phrase exactly from the target sentence.",
                )
            )
        if focus.get("coverage") == "partial":
            warnings.append(
                _issue(
                    "BP_COVERAGE_PARTIAL",
                    "focus.coverage",
                    f"The mission covers only part of the target sentence: {focus.get('uncovered_note') or ''}".strip(),
                    "No fix needed.",
                    severity="warning",
                )
            )

        criteria = _as_list(blueprint.get("criteria"))
        if not 1 <= len(criteria) <= 2:
            errors.append(_issue("BP_CRITERIA_COUNT", "criteria", f"criteria has {len(criteria)} items.", "Choose 1 or 2 performance criteria."))
        for index, item in enumerate(criteria):
            ref = _as_dict(item).get("ref")
            if known(ref, f"criteria[{index}].ref") and not str(ref).startswith("N.c."):
                errors.append(
                    _issue("BP_CRITERIA_KIND", f"criteria[{index}].ref", f"{ref} is not a performance criterion.", "Use an id starting with N.c.")
                )

        # 연결 판단이 근거로 든 수행준거를 하나도 쓰지 않았으면 경고로 남긴다(다시 쓰게 하지는 않는다).
        basis = link_basis(source_pack)
        chosen = {_as_dict(item).get("ref") for item in criteria}
        if basis and not chosen & set(basis["criteria_refs"]):
            warnings.append(
                _issue(
                    "BP_LINK_CRITERIA_UNUSED",
                    "criteria",
                    "None of the chosen criteria is among those the sentence-unit link was confirmed on "
                    f"({', '.join(basis['criteria_refs'])}).",
                    "No fix needed.",
                    severity="warning",
                )
            )

        difficulty = _as_dict(system_decisions.get("difficulty"))
        allowed_types = set(_as_list(system_decisions.get("allowed_material_types")))
        materials = _as_list(blueprint.get("materials"))
        self._check_slots(materials, difficulty.get("material_count_range"), "materials", "BP_MATERIAL_COUNT", errors)
        borrowed_total = 0
        for index, material in enumerate(materials):
            material = _as_dict(material)
            path = f"materials[{index}]"
            if material.get("type") not in allowed_types:
                errors.append(
                    _issue(
                        "BP_MATERIAL_TYPE",
                        f"{path}.type",
                        f"{material.get('type')!r} is not an allowed material type.",
                        f"Use one of {sorted(allowed_types)}.",
                    )
                )
            self._check_refs(material.get("refs"), path, known, errors)
            for term_index, term in enumerate(_as_list(material.get("borrowed_terms"))):
                borrowed_total += 1
                term_in_source(term, f"{path}.borrowed_terms[{term_index}]")
        # 자료가 3개 이상이면(어려움 난이도) 형태가 둘 이상이어야 한다.
        planned_types = {_as_dict(material).get("type") for material in materials}
        if len(materials) >= 3 and len(planned_types) < 2:
            errors.append(
                _issue(
                    "BP_MATERIAL_TYPES_SAME",
                    "materials",
                    f"All {len(materials)} materials have the same type.",
                    "Use at least two different material types.",
                )
            )
        if borrowed_total < 2:
            warnings.append(
                _issue(
                    "BP_FEW_BORROWED_TERMS",
                    "materials",
                    f"Only {borrowed_total} term(s) are borrowed from the source. The chosen criterion may not be concrete.",
                    "No fix needed.",
                    severity="warning",
                )
            )

        tasks = _as_list(blueprint.get("tasks"))
        self._check_slots(tasks, difficulty.get("task_count_range"), "tasks", "BP_TASK_COUNT", errors)
        for index, task in enumerate(tasks):
            self._check_refs(_as_dict(task).get("refs"), f"tasks[{index}]", known, errors)

        evaluation_basis = _as_list(blueprint.get("evaluation_basis"))
        if not evaluation_basis:
            errors.append(_issue("BP_MISSING_REFS", "evaluation_basis", "evaluation_basis is empty.", "Add at least one evaluation basis with refs."))
        know_refs: set[str] = set()
        for index, basis in enumerate(evaluation_basis):
            basis = _as_dict(basis)
            path = f"evaluation_basis[{index}]"
            self._check_refs(basis.get("refs"), path, known, errors)
            for ref_index, ref in enumerate(_as_list(basis.get("know_refs"))):
                ref_path = f"{path}.know_refs[{ref_index}]"
                if not known(ref, ref_path):
                    continue
                if str(ref).startswith(_KNOW_REF_PREFIXES):
                    know_refs.add(ref)
                else:
                    errors.append(
                        _issue("BP_KNOW_REF_KIND", ref_path, f"{ref} is not a KNOW activity, ability, or knowledge item.", "Use ids starting with K.act., K.abil., or K.know.")
                    )
        if not 1 <= len(know_refs) <= 4:
            errors.append(
                _issue(
                    "BP_KNOW_REF_KIND",
                    "evaluation_basis",
                    f"The blueprint uses {len(know_refs)} different know_refs.",
                    "Use 1 to 4 different know_refs in total.",
                )
            )

        for index, term in enumerate(_as_list(blueprint.get("glossary_terms"))):
            term_in_source(term, f"glossary_terms[{index}]")

        return _result("blueprint_check.v1", attempt, errors, warnings)

    @staticmethod
    def _check_slots(items: list[Any], count_range: Any, path: str, code: str, errors: list[dict[str, Any]]) -> None:
        """개수가 난이도 규칙 안이고 slot이 1부터 빠짐없이 이어지는지 본다."""

        low, high = (count_range if isinstance(count_range, list) and len(count_range) == 2 else [1, 1])
        slots = [_as_dict(item).get("slot") for item in items]
        if not low <= len(items) <= high or slots != list(range(1, len(items) + 1)):
            errors.append(
                _issue(
                    code,
                    path,
                    f"{path} has {len(items)} items with slots {slots}; the difficulty requires {low} to {high}.",
                    f"Plan {low} to {high} {path} and number slots from 1 without gaps.",
                )
            )

    @staticmethod
    def _check_refs(refs: Any, path: str, known: Any, errors: list[dict[str, Any]]) -> None:
        refs = _as_list(refs)
        if not refs:
            errors.append(_issue("BP_MISSING_REFS", f"{path}.refs", f"{path} has no refs.", "Add at least one piece id."))
        for index, ref in enumerate(refs):
            known(ref, f"{path}.refs[{index}]")


class MissionBasisChecker:
    """쓰인 미션이 설계서를 따랐는지 본다. 자료와 과제는 순서로, 채점 기준은 basis_map으로 설계서와 짝을 짓는다."""

    def check(
        self,
        *,
        mission_draft: dict[str, Any] | None,
        basis_map: dict[str, Any] | None,
        blueprint: dict[str, Any],
        attempt: int = 0,
        difficulty: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """difficulty는 시스템 결정의 난이도다. 주지 않으면 미션에 복사된 난이도(mission.difficulty)를 쓴다."""

        draft = _as_dict(mission_draft)
        mission = _as_dict(draft.get("mission"))
        materials = _as_list(mission.get("materials"))
        tasks = _as_list(mission.get("tasks"))
        rubric = _as_list(_as_dict(draft.get("evaluation")).get("rubric"))
        plan_materials = sorted((_as_dict(m) for m in _as_list(blueprint.get("materials"))), key=lambda m: m.get("slot") or 0)
        plan_tasks = _as_list(blueprint.get("tasks"))
        plan_basis = _as_list(blueprint.get("evaluation_basis"))
        errors: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []

        if len(materials) != len(plan_materials) or len(tasks) != len(plan_tasks):
            errors.append(
                _issue(
                    "BM_SLOT_COUNT_MISMATCH",
                    "mission",
                    f"The mission has {len(materials)} materials and {len(tasks)} tasks; the blueprint plans {len(plan_materials)} and {len(plan_tasks)}.",
                    "Create exactly one material per blueprint material slot and one task per blueprint task slot, in slot order.",
                )
            )

        # 자료의 형태는 설계서가 자리마다 정한 형태와 같아야 한다(근거 기록이 형태를 고른 이유를 설계서에서 가져온다).
        for position, plan in enumerate(plan_materials):
            if position >= len(materials):
                break
            written = _as_dict(materials[position]).get("type")
            if written != plan.get("type"):
                errors.append(
                    _issue(
                        "BM_MATERIAL_TYPE_MISMATCH",
                        f"mission.materials[{position}].type",
                        f"Material {position + 1} is {written!r}, but blueprint slot {plan.get('slot')} plans {plan.get('type')!r}.",
                        f"Write material {position + 1} as type {plan.get('type')!r}, as the blueprint plans.",
                    )
                )
            # 체크리스트의 '주의 필요' 표시는 화면에 그대로 보여 문제 항목을 알려 줄 수 있다.
            if written == "checklist":
                items = _as_list(_as_dict(_as_dict(materials[position]).get("data")).get("items"))
                if any(_as_dict(item).get("status") == "issue" for item in items):
                    warnings.append(
                        _issue(
                            "BM_CHECKLIST_ISSUE_MARK",
                            f"mission.materials[{position}].data.items",
                            f"Checklist material {position + 1} marks an item as issue, which the screen shows as a warning mark.",
                            "No fix needed.",
                            severity="warning",
                        )
                    )

        entries = [_as_dict(entry) for entry in _as_list(_as_dict(basis_map).get("rubric"))]
        used_basis: set[int] = set()
        unmapped: list[int] = []
        for rubric_index in range(len(rubric)):
            matches = [entry for entry in entries if entry.get("rubric_index") == rubric_index]
            basis_index = matches[0].get("evaluation_basis_index") if len(matches) == 1 else None
            if isinstance(basis_index, int) and not isinstance(basis_index, bool) and 0 <= basis_index < len(plan_basis):
                used_basis.add(basis_index)
            else:
                unmapped.append(rubric_index)
        if unmapped:
            errors.append(
                _issue(
                    "BM_RUBRIC_UNMAPPED",
                    "basis_map.rubric",
                    f"Rubric items {unmapped} are not mapped to exactly one evaluation basis.",
                    "basis_map.rubric must have exactly one entry per rubric item, "
                    f"with evaluation_basis_index between 0 and {max(len(plan_basis) - 1, 0)}.",
                )
            )
        else:
            for basis_index in range(len(plan_basis)):
                if basis_index not in used_basis:
                    warnings.append(
                        _issue(
                            "BM_BASIS_UNUSED",
                            f"evaluation_basis[{basis_index}]",
                            f"Blueprint evaluation basis {basis_index} is not used by any rubric item.",
                            "No fix needed.",
                            severity="warning",
                        )
                    )

        for position, plan in enumerate(plan_materials):
            if position >= len(materials):
                break
            material_text = json.dumps(materials[position], ensure_ascii=False)
            for term in _as_list(plan.get("borrowed_terms")):
                word = _as_dict(term).get("term")
                if not contains_verbatim(material_text, word):
                    warnings.append(
                        _issue(
                            "BM_TERM_NOT_IN_MISSION",
                            f"mission.materials[{position}]",
                            f"Planned term {word!r} does not appear in material {position + 1}.",
                            "No fix needed.",
                            severity="warning",
                        )
                    )

        glossary = [squash(_as_dict(entry).get("term")) for entry in _as_list(_as_dict(mission.get("scenario")).get("glossary"))]
        for term in _as_list(blueprint.get("glossary_terms")):
            word = squash(_as_dict(term).get("term"))
            if word and not any(word in entry or (entry and entry in word) for entry in glossary):
                warnings.append(
                    _issue(
                        "BM_GLOSSARY_MISSING",
                        "mission.scenario.glossary",
                        f"Planned glossary term {_as_dict(term).get('term')!r} is not explained in the mission glossary.",
                        "No fix needed.",
                        severity="warning",
                    )
                )

        level = _as_dict(difficulty) if difficulty is not None else _as_dict(mission.get("difficulty"))
        self._check_length_and_time(mission, level, errors)
        return _result("mission_basis_check.v1", attempt, errors, warnings)

    @staticmethod
    def _check_length_and_time(mission: dict[str, Any], level: dict[str, Any], errors: list[dict[str, Any]]) -> None:
        """분량 표현과 예상 시간이 난이도 값과 같은 말인지 본다(blueprint-writer-v8). 분명히 어긋난 것만 오류로 잡는다.

        제출 형식의 분량 안내가 한국어 "N~M문장" 꼴이 아니거나 범위가 다를 때, 지시문·유의 사항이 다른 분량을 말할 때
        (예: 범위는 1~2문장인데 "한 문장으로"), 제출 형식의 예상 시간이 난이도 값과 다를 때.
        분량이 과제마다인 난이도(어려움)는 제출 형식이 "과제마다"(또는 "과제별", "각 과제")를 밝혀야 한다(blueprint-writer-v10).
        """

        expected = parse_length_range(level.get("answer_length_hint"))
        korean = korean_length_hint(level.get("answer_length_hint"))
        submission = _as_dict(mission.get("submission_format"))
        hint = submission.get("length_hint")
        hint_ranges = [item for item in length_mentions(hint) if item["kind"] == "range"]
        if not level.get("answer_length_hint"):
            # 난이도가 분량을 정하지 않았으면 견줄 기준이 없다(실제 생성에서는 늘 있다).
            pass
        elif not isinstance(hint, str) or re.search(r"[A-Za-z]", hint) or not hint_ranges:
            errors.append(
                _issue(
                    "BM_LENGTH_HINT_FORMAT",
                    "mission.submission_format.length_hint",
                    f"length_hint {hint!r} is not a Korean range of the form 'N~M문장'.",
                    f"Write length_hint in Korean as {korean!r}." if korean else "Write length_hint in Korean as 'N~M문장'.",
                )
            )
        elif expected and (hint_ranges[0]["low"], hint_ranges[0]["high"]) != expected:
            errors.append(
                _issue(
                    "BM_LENGTH_HINT_RANGE",
                    "mission.submission_format.length_hint",
                    f"length_hint {hint!r} differs from the difficulty's answer length {level.get('answer_length_hint')!r}.",
                    f"Write length_hint as {korean!r}.",
                )
            )
        elif "per task" in str(level.get("answer_length_hint")) and not _PER_TASK_KO.search(hint):
            # 어려움(blueprint-writer-v10): 분량이 과제마다인데 제출 형식이 "3~5문장"만 적으면 두 과제를 합친 분량으로 읽힌다.
            errors.append(
                _issue(
                    "BM_LENGTH_HINT_FORMAT",
                    "mission.submission_format.length_hint",
                    f"length_hint {hint!r} does not say that the length is per task.",
                    f"Write length_hint as {korean!r}.",
                )
            )
        if expected:
            texts = [(f"mission.tasks[{index}].instruction", _as_dict(task).get("instruction")) for index, task in enumerate(_as_list(mission.get("tasks")))]
            constraints = _as_list(_as_dict(mission.get("scenario")).get("constraints"))
            texts += [(f"mission.scenario.constraints[{index}]", text) for index, text in enumerate(constraints)]
            for path, text in texts:
                for mention in length_mentions(text):
                    if not length_agrees(mention, expected):
                        errors.append(
                            _issue(
                                "BM_LENGTH_MISMATCH",
                                path,
                                f"{path} says {mention['text']!r}, but the answer length is {korean!r}.",
                                f"Use {korean!r} for the whole answer, the same words as length_hint, or leave the length out of this text.",
                            )
                        )
        minutes = level.get("estimated_time_minutes")
        if minutes is not None and submission.get("estimated_time_minutes") != minutes:
            errors.append(
                _issue(
                    "BM_TIME_MISMATCH",
                    "mission.submission_format.estimated_time_minutes",
                    f"estimated_time_minutes is {submission.get('estimated_time_minutes')!r}, but the difficulty sets {minutes}.",
                    f"Set mission.submission_format.estimated_time_minutes to {minutes}.",
                )
            )
