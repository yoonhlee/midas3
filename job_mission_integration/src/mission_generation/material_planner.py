# 자료 형태 배정: 배치표(mission_targets.json)의 대상마다 두 단계 생성이 쓸 수 있는 자료 형태를 좁혀 정한다.
#
# 두 단계 생성은 미션마다 일곱 형태를 모두 열어 주었고, 설계 단계가 대부분 표와 메모를 골랐다(쉬움은 대부분 표 하나,
# 보통은 대부분 메모 + 표). 이 모듈은 모델을 부르지 않고 코드로, 한 직업의 세 미션(쉬움·보통·어려움)이
# 서로 다른 형태를 쓰도록 형태를 나눠 준다. 어느 형태가 그 일에 어울리는지는 능력단위의 서류(N.doc.*), 연결이 근거로 든
# 수행준거(N.c.*), 하는 일 문장(연결 구절)의 낱말로 가린다. 왜 그렇게 정했는지(걸린 낱말과 조각)를 대상마다 남긴다.
#
#   python -X utf8 -m src.mission_generation.material_planner --plan <mission_targets.json> --ncs-root <ncs_jobs> --out <폴더>
#
# 출력: 배정을 붙인 배치표(mission_targets_mix.json, 실행기의 --ncs-targets에 그대로 넘긴다), 사람이 보는 표
# (material_mix.csv), 수를 센 요약(material_mix_summary.json). 입력 배치표는 고치지 않는다.
# 규칙(MIX_RULE_VERSION)은 이 파일의 낱말 목록, 점수, assign_job에 있다. 바꾸면 버전을 올린다.

from __future__ import annotations

import argparse
import csv
import io
import itertools
import json
import sys
from pathlib import Path
from typing import Any

from .basis_source_pack import numbered_criteria, squash
from .blueprint_designer import DATA_MATERIAL_TYPES, STANDARD_MATERIAL_TYPES, TWO_STAGE_MATERIAL_TYPES

MIX_RULE_VERSION = "mix-v1"
MIX_PLAN_SCHEMA = "mission_target_plan.v1+material_mix"
DIFFICULTIES = ("easy", "normal", "hard")
DIFFICULTY_LABELS = {"easy": "쉬움", "normal": "보통", "hard": "어려움"}
TYPE_LABELS = {
    "memo": "메모",
    "email": "이메일",
    "checklist": "체크리스트",
    "table": "표",
    "chart": "차트",
    "log": "기록",
    "schedule": "일정표",
}

# 형태마다 그 형태로 보여 줄 서류·데이터를 가리키는 낱말과 세기(1.0 뚜렷함, 0.5 약함).
# 낱말은 공백을 지운 원문에서 글자 그대로 찾는다. 다른 뜻으로 자주 쓰이는 짧은 말(표, 공정, 율)은 넣지 않고 붙은 말로 적는다.
TYPE_SIGNALS: dict[str, tuple[tuple[str, float], ...]] = {
    "log": (
        ("일지", 1.0), ("일보", 1.0), ("로그", 1.0), ("이력", 1.0), ("기록", 1.0), ("대장", 1.0), ("회의록", 1.0),
        ("출입기록", 1.0), ("출입관리", 1.0), ("출입자", 1.0), ("내역", 0.5), ("접수", 0.5), ("통화", 0.5),
        ("관찰", 0.5), ("경과", 0.5), ("발생", 0.5), ("장애", 0.5), ("사고", 0.5), ("모니터링", 0.5), ("상담", 0.5),
        ("운행", 0.5), ("결함", 0.5), ("오류", 0.5), ("버그", 0.5), ("변경", 0.5), ("조치", 0.5), ("수리", 0.5),
        ("입고", 0.5), ("출고", 0.5), ("반품", 0.5), ("회의", 0.5),
    ),
    "schedule": (
        ("일정", 1.0), ("공정표", 1.0), ("공정계획", 1.0), ("공정관리", 1.0), ("스케줄", 1.0), ("시간표", 1.0),
        ("납기", 1.0), ("로드맵", 1.0), ("진도", 1.0), ("근무표", 1.0), ("배차", 1.0), ("교대", 1.0),
        ("마감", 0.5), ("기한", 0.5), ("단계별", 0.5), ("착수", 0.5), ("시기", 0.5), ("기간", 0.5), ("순서", 0.5),
        ("주기", 0.5), ("일자", 0.5), ("날짜", 0.5), ("연간", 0.5), ("월간", 0.5), ("행사", 0.5), ("계획", 0.25),
    ),
    "chart": (
        ("통계", 1.0), ("추이", 1.0), ("실적", 1.0), ("비율", 1.0), ("이용률", 1.0), ("점유율", 1.0), ("손해율", 1.0),
        ("가동률", 1.0), ("성장률", 1.0), ("증가율", 1.0), ("수익률", 1.0), ("달성률", 1.0), ("만족도", 1.0),
        ("지표", 1.0), ("트래픽", 1.0), ("매출", 1.0), ("증감", 1.0), ("분포", 1.0), ("그래프", 1.0), ("차트", 1.0),
        ("판매량", 1.0), ("생산량", 1.0), ("사용량", 1.0), ("월별", 1.0), ("연도별", 1.0), ("분기별", 1.0),
        ("시계열", 1.0), ("시각화", 1.0), ("실행시간", 1.0), ("응답시간", 1.0), ("현황", 0.5), ("동향", 0.5),
        ("수요", 0.5), ("예측", 0.5), ("측정", 0.5), ("수치", 0.5), ("성과", 0.5), ("달성도", 0.5), ("성능", 0.5),
        ("속도", 0.5), ("용량", 0.5),
    ),
    "table": (
        ("목록", 1.0), ("명세", 1.0), ("내역서", 1.0), ("견적", 1.0), ("단가", 1.0), ("가격", 1.0), ("요금", 1.0),
        ("후보", 1.0), ("신청서", 1.0), ("원가", 1.0), ("계산서", 1.0), ("재무제표", 1.0), ("리스트", 1.0),
        ("사양", 1.0), ("일람", 1.0), ("분류표", 1.0), ("코드표", 1.0), ("명부", 1.0), ("테이블", 1.0), ("비교", 0.5), ("양식", 0.5),
        ("서식", 0.5), ("산출", 0.5), ("예산", 0.5), ("대조", 0.5), ("금액", 0.5), ("수량", 0.5), ("집계", 0.5),
        ("대장", 0.5), ("정산", 0.5), ("비용", 0.5),
    ),
    "memo": (
        ("지침", 1.0), ("기준", 1.0), ("매뉴얼", 1.0), ("규정", 1.0), ("규칙", 1.0), ("정책", 1.0), ("방침", 1.0),
        ("법규", 1.0), ("법령", 1.0), ("법률", 1.0), ("표준", 1.0), ("가이드", 1.0), ("절차", 1.0), ("요령", 1.0),
        ("원칙", 1.0), ("고시", 1.0), ("시행령", 1.0), ("규약", 1.0), ("약관", 1.0), ("지시", 0.5), ("방법론", 0.5),
        ("안내", 0.5),
    ),
    "checklist": (
        ("체크리스트", 1.0), ("점검표", 1.0), ("체크", 1.0), ("검수", 1.0), ("평가표", 1.0), ("확인서", 1.0),
        ("점검", 0.5), ("검사", 0.5), ("준수", 0.5), ("요건", 0.5), ("감사", 0.5), ("여부", 0.5), ("적정성", 0.5),
        ("완전성", 0.5), ("적합성", 0.5), ("확인", 0.25), ("검토", 0.25),
    ),
    "email": (
        ("요청", 1.0), ("문의", 1.0), ("의뢰", 1.0), ("민원", 1.0), ("클레임", 1.0), ("회신", 1.0), ("주문", 1.0),
        ("발주", 1.0), ("이메일", 1.0), ("메일", 1.0), ("전자우편", 1.0), ("피드백", 1.0), ("고객", 0.5), ("협의", 0.5),
        ("통보", 0.5), ("상담", 0.5), ("신청", 0.5), ("제안", 0.5), ("이용자", 0.5), ("거래처", 0.5), ("의견", 0.5),
        ("지시서", 0.5), ("요구", 0.25),
    ),
}

# 낱말을 찾기 전에 원문에서 지우는 말. 형태 낱말을 품고 있지만 뜻이 다르다(프로그램의 '로그', 수출입의 '출입', 산출물의 '산출').
EXCLUDED_WORDS = ("프로그", "카탈로그", "카달로그", "블로그", "로그인", "산출물", "수출입", "출입국")

# 조각의 무게. 서류 이름은 미션 자료가 닮을 실무 서류를 바로 말하고, 연결이 근거로 든 수행준거는 과제가 나오는 곳,
# 연결 구절(없으면 하는 일 문장)은 미션의 중심이다(이 셋이 '주된 조각'). 능력단위의 다른 수행준거와 고려사항은 약하게 센다.
SOURCE_WEIGHTS = {"doc": 2.0, "linked_criterion": 2.0, "phrase": 2.0, "other_criterion": 0.5, "consideration": 0.5}
PRIMARY_SOURCES = ("doc", "linked_criterion", "phrase")
# 그 형태가 그 일에 어울리는 정도.
#   뚜렷함: 주된 조각에 뚜렷한 낱말(세기 1.0)이 있거나(주된 점수 2 이상), 약한 낱말이 주된 조각 셋 이상에 걸린다(주된 점수 3 이상).
#   약함: 주된 조각에 약한 낱말이 걸리고(주된 점수 1 이상) 다른 조각까지 합한 점수가 1.5 이상이다.
#   없음: 그보다 적다. 늘 쓸 수 있는 형태(표·메모·이메일)가 아니면 주지 않는다.
# 약하게 어울리는 형태는 한 직업의 세 미션을 서로 다르게 하는 데 필요할 때만 쓴다(뚜렷한 형태가 먼저다).
STRONG_PRIMARY = 2.0
STRONG_PRIMARY_WEAK_ONLY = 3.0
WEAK_PRIMARY = 1.0
WEAK_TOTAL = 1.5
FIT_STRONG, FIT_WEAK, FIT_FALLBACK = "뚜렷함", "약함", "늘 쓸 수 있음"
# 늘 쓸 수 있는 형태: 표(사례·후보를 나란히 놓는다), 메모(기준·규정의 발췌), 이메일(누가 보낸 요청·지시. 미션마다 일을 맡기는 사람이 있다).
# 어울리는 형태가 모자랄 때 받는 형태이고, 한 직업에서 겹쳐 줄 수 있는 것도 이 셋뿐이다.
ALWAYS_TYPES = ("table", "memo", "email")
# 표와 메모는 걸리는 낱말이 흔해(비교, 매뉴얼, 기준) 점수를 이만큼 줄여 센다. 그래야 다른 형태에 뚜렷한 근거가 있을 때 그쪽이 앞선다.
DISCOUNTED_TYPES = ("table", "memo")
DISCOUNT_FACTOR = 0.5
# 쉬움은 자료가 하나라 그 하나가 과제를 다 담아야 한다. 자료 틀이 작은 형태(일정표 1~2항목, 체크리스트 2항목, 메모 1~2항목,
# 짧은 이메일)는 쉬움에 주지 않는다.
EASY_TYPES = ("table", "chart", "log")
# 남는 형태는 어울릴 때(뚜렷함·약함)만 덧붙인다. 근거 없이 늘 쓸 수 있는 형태로는 덧붙이지 않고,
# 쏠림이 컸던 곳(쉬움의 표, 보통의 메모)에는 근거가 있어도 덧붙이지 않는다.
NO_SPARE = {("easy", "table"), ("normal", "memo")}
# 점수가 같을 때 먼저 고르는 순서. 표와 메모를 뒤에 둔다.
TIE_ORDER = ("log", "chart", "schedule", "table", "email", "checklist", "memo")


def piece_texts(unit: dict[str, Any], phrase: str | None, exec_text: str | None, criteria_refs: list[str]) -> list[dict[str, Any]]:
    """형태를 가릴 때 볼 조각: 서류, 연결 수행준거, 연결 구절(없으면 문장), 다른 수행준거, 고려사항.

    번호는 근거 자료 묶음(basis_source_pack)과 같다. 구절은 'phrase', 구절이 없을 때의 문장은 'sentence'로 적는다.
    """

    pieces: list[dict[str, Any]] = []
    scope = unit.get("scope") or {}
    for number, text in enumerate(scope.get("documents") or [], start=1):
        pieces.append({"id": f"N.doc.{number}", "source": "doc", "text": str(text)})
    linked = {str(ref) for ref in criteria_refs}
    others: list[dict[str, Any]] = []
    for item in numbered_criteria(unit):
        entry = {"id": f"N.c.{item['number']}", "text": str(item["text"])}
        if item["number"] in linked:
            pieces.append({**entry, "source": "linked_criterion"})
        else:
            others.append({**entry, "source": "other_criterion"})
    sentence = (phrase or "").strip() or (exec_text or "").strip()
    if sentence:
        pieces.append({"id": "phrase" if (phrase or "").strip() else "sentence", "source": "phrase", "text": sentence})
    for number, text in enumerate(scope.get("considerations") or [], start=1):
        others.append({"id": f"N.con.{number}", "source": "consideration", "text": str(text)})
    return pieces + others


def _clean(text: str) -> str:
    cleaned = squash(text)
    for word in EXCLUDED_WORDS:
        cleaned = cleaned.replace(word, "|")
    return cleaned


def type_signals(pieces: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """형태마다 점수와 걸린 낱말. 한 조각은 한 형태에 한 번만 센다(그 조각에서 가장 센 낱말).

    score는 모든 조각의 합(순위에 쓴다), primary_score는 주된 조각의 합, strong은 주된 조각에 뚜렷한 낱말이 있는지다.
    """

    result: dict[str, dict[str, Any]] = {}
    texts = [_clean(piece["text"]) for piece in pieces]
    for kind in TWO_STAGE_MATERIAL_TYPES:
        words = TYPE_SIGNALS[kind]
        score = primary = 0.0
        strong = False
        evidence: list[dict[str, Any]] = []
        for piece, text in zip(pieces, texts):
            hits = [(word, strength) for word, strength in words if word in text]
            if not hits:
                continue
            word, strength = max(hits, key=lambda hit: (hit[1], len(hit[0])))
            points = SOURCE_WEIGHTS[piece["source"]] * strength
            score += points
            if piece["source"] in PRIMARY_SOURCES:
                primary += points
                strong = strong or strength >= 1.0
            evidence.append({"id": piece["id"], "word": word, "points": points, "text": piece["text"]})
        result[kind] = {"score": round(score, 2), "primary_score": round(primary, 2), "strong": strong, "evidence": evidence}
    return result


def adjusted(kind: str, signals: dict[str, dict[str, Any]]) -> float:
    score = signals[kind]["score"]
    return score * DISCOUNT_FACTOR if kind in DISCOUNTED_TYPES else score


def fit_level(kind: str, signals: dict[str, dict[str, Any]]) -> str | None:
    """그 일에 어울리는 정도: 뚜렷함, 약함, 늘 쓸 수 있음(표·메모·이메일에 뚜렷한 근거가 없을 때), None(주지 않음)."""

    signal = signals[kind]
    primary = signal["primary_score"]
    if (signal["strong"] and primary >= STRONG_PRIMARY) or primary >= STRONG_PRIMARY_WEAK_ONLY:
        return FIT_STRONG
    if kind in ALWAYS_TYPES:
        return FIT_FALLBACK
    if primary >= WEAK_PRIMARY and signal["score"] >= WEAK_TOTAL:
        return FIT_WEAK
    return None


def fits(kind: str, signals: dict[str, dict[str, Any]]) -> bool:
    """그 일에 줄 수 있는가. 표·메모·이메일은 늘 줄 수 있다."""

    return fit_level(kind, signals) is not None


def _tie(kind: str) -> int:
    return TIE_ORDER.index(kind)


def _best_assignment(
    slots: list[str],
    choices: dict[str, list[str]],
    signals: dict[str, dict[str, dict[str, Any]]],
) -> dict[str, str]:
    """slots(난이도)마다 choices 안에서 형태 하나씩.

    서로 다른 형태의 수 → 겹친다면 늘 쓸 수 있는 형태만 겹치게 → 약하게 어울리는 형태를 덜 쓴 것 → 점수 합
    → 근거 없이 받은 형태를 덜 쓴 것 → 정해진 순서로 고른다.
    """

    best: tuple[Any, ...] | None = None
    best_pick: dict[str, str] = {}
    for combo in itertools.product(*(choices[slot] for slot in slots)):
        pick = dict(zip(slots, combo))
        distinct = len(set(combo))
        other_repeats = sum(combo.count(kind) - 1 for kind in set(combo) if kind not in ALWAYS_TYPES)
        weak_uses = sum(1 for slot in slots if fit_level(pick[slot], signals[slot]) == FIT_WEAK)
        total = round(sum(adjusted(pick[slot], signals[slot]) for slot in slots), 4)
        fallback_uses = sum(1 for slot in slots if fit_level(pick[slot], signals[slot]) == FIT_FALLBACK)
        key = (distinct, -other_repeats, -weak_uses, total, -fallback_uses, tuple(-_tie(kind) for kind in combo))
        if best is None or key > best:
            best, best_pick = key, pick
    return best_pick


def assign_job(signals: dict[str, dict[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    """한 직업의 난이도별 형태. signals는 {난이도: type_signals 결과}이고 배치표에 있는 난이도만 들어 있다.

    1. 데이터 형태(표·차트·기록·일정표)를 난이도마다 하나씩 주되 서로 다르게 한다(쉬움은 표·차트·기록 가운데).
       그 일에 어울리는 형태 안에서만 고른다. 어울리는 형태가 모자라면 표를 겹쳐 준다.
    2. 기준·요청 형태(메모·이메일·체크리스트)를 보통과 어려움에 하나씩, 서로 다르게 준다(메모와 이메일은 늘 쓸 수 있다).
    3. 남는 형태 가운데 어울리는 것은 더 어울리는 미션에 덧붙여 설계 단계가 고를 여지를 준다(한 직업에서 한 형태는 한 미션에만).
    """

    present = [difficulty for difficulty in DIFFICULTIES if difficulty in signals]
    data_choices = {
        difficulty: [
            kind
            for kind in (EASY_TYPES if difficulty == "easy" else DATA_MATERIAL_TYPES)
            if fits(kind, signals[difficulty])
        ]
        for difficulty in present
    }
    data_lead = _best_assignment(present, data_choices, signals)
    standard_slots = [difficulty for difficulty in present if difficulty != "easy"]
    standard_choices = {
        difficulty: [kind for kind in STANDARD_MATERIAL_TYPES if fits(kind, signals[difficulty])] for difficulty in standard_slots
    }
    standard_lead = _best_assignment(standard_slots, standard_choices, signals) if standard_slots else {}

    allowed: dict[str, list[str]] = {difficulty: [data_lead[difficulty]] for difficulty in present}
    for difficulty, kind in standard_lead.items():
        allowed[difficulty].append(kind)
    used = {kind for kinds in allowed.values() for kind in kinds}
    spares: dict[str, list[str]] = {difficulty: [] for difficulty in present}
    for kind in TIE_ORDER:
        if kind in used:
            continue
        # 데이터 형태는 쉬움(쉬움에 줄 수 있는 형태만)이나 어려움에, 기준·요청 형태는 보통이나 어려움에 덧붙인다.
        homes = ("easy", "hard") if kind in DATA_MATERIAL_TYPES else ("normal", "hard")
        places = [
            difficulty
            for difficulty in present
            if difficulty in homes
            and (difficulty != "easy" or kind in EASY_TYPES)
            and (difficulty, kind) not in NO_SPARE
            and fit_level(kind, signals[difficulty]) in (FIT_STRONG, FIT_WEAK)
        ]
        if not places:
            continue
        target = max(places, key=lambda difficulty: (adjusted(kind, signals[difficulty]), DIFFICULTIES.index(difficulty)))
        allowed[target].append(kind)
        spares[target].append(kind)
        used.add(kind)

    shared = {
        kind
        for kind in TWO_STAGE_MATERIAL_TYPES
        if sum(1 for difficulty in present if kind in allowed[difficulty]) > 1
    }
    result: dict[str, dict[str, Any]] = {}
    for difficulty in present:
        kinds = [kind for kind in TWO_STAGE_MATERIAL_TYPES if kind in allowed[difficulty]]
        result[difficulty] = {
            "allowed_material_types": kinds,
            "lead_data_type": data_lead[difficulty],
            "standard_type": standard_lead.get(difficulty),
            "spare_types": [kind for kind in TWO_STAGE_MATERIAL_TYPES if kind in spares[difficulty]],
            "shared_types": [kind for kind in kinds if kind in shared],
        }
    return result


def _evidence_line(kind: str, signals: dict[str, Any], limit: int = 3) -> str:
    items = sorted(signals[kind]["evidence"], key=lambda item: -item["points"])[:limit]
    return ", ".join(f"{item['id']} '{item['word']}'" for item in items)


def reason_text(difficulty: str, job_result: dict[str, dict[str, Any]], signals: dict[str, dict[str, dict[str, Any]]]) -> str:
    """이 대상에 이 형태들을 준 이유를 한 줄로 적는다."""

    mine = job_result[difficulty]
    own = signals[difficulty]
    parts: list[str] = []
    for kind in mine["allowed_material_types"]:
        role = "덧붙임" if kind in mine["spare_types"] else ("데이터" if kind in DATA_MATERIAL_TYPES else "기준·요청")
        evidence = _evidence_line(kind, own)
        level = fit_level(kind, own)
        if level in (FIT_STRONG, FIT_WEAK):
            note = f"{level} · {evidence}"
        elif evidence:
            note = f"{FIT_FALLBACK} · {evidence}"
        else:
            note = f"{FIT_FALLBACK} · 걸린 낱말 없음"
        parts.append(f"{TYPE_LABELS[kind]}({role}: {note})")
    others = [
        f"{DIFFICULTY_LABELS[other]} {'·'.join(TYPE_LABELS[kind] for kind in job_result[other]['allowed_material_types'])}"
        for other in DIFFICULTIES
        if other in job_result and other != difficulty
    ]
    text = " / ".join(parts)
    if others:
        text += f" / 같은 직업의 다른 미션: {', '.join(others)}"
    if mine["shared_types"]:
        text += f" / 어울리는 형태가 모자라 겹침: {'·'.join(TYPE_LABELS[kind] for kind in mine['shared_types'])}"
    return text


def load_units(ncs_root: str | Path) -> dict[tuple[str, str, str], dict[str, Any]]:
    """생성기 입력(ncs_jobs/*.json)의 항목을 (직업, 문장, 능력단위)로 찾을 수 있게 모은다."""

    units: dict[tuple[str, str, str], dict[str, Any]] = {}
    for path in sorted(Path(ncs_root).glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        job_cd = str(data.get("job_cd") or path.stem)
        for unit in data.get("units") or []:
            units[(job_cd, str(unit.get("exec_job_id")), str(unit.get("unit_key")))] = unit
    return units


def plan_materials(plan: dict[str, Any], units: dict[tuple[str, str, str], dict[str, Any]]) -> dict[str, Any]:
    """배치표의 대상마다 material_mix를 붙인 새 배치표를 돌려준다. 입력은 바꾸지 않는다."""

    targets = [dict(target) for target in plan.get("targets") or []]
    by_job: dict[str, list[dict[str, Any]]] = {}
    for target in targets:
        by_job.setdefault(str(target["job_cd"]), []).append(target)
    for job_cd, job_targets in by_job.items():
        signals: dict[str, dict[str, dict[str, Any]]] = {}
        for target in job_targets:
            key = (job_cd, str(target["exec_job_id"]), str(target["unit_key"]))
            unit = units.get(key)
            if unit is None:
                raise ValueError(f"no generator input for {key}")
            pieces = piece_texts(unit, target.get("phrase"), target.get("exec_job_text"), list(target.get("criteria_refs") or []))
            signals[target["difficulty"]] = type_signals(pieces)
        job_result = assign_job(signals)
        for target in job_targets:
            difficulty = target["difficulty"]
            mine = job_result[difficulty]
            target["material_mix"] = {
                "rule_version": MIX_RULE_VERSION,
                **mine,
                "job_types": {other: list(job_result[other]["allowed_material_types"]) for other in DIFFICULTIES if other in job_result},
                "reason": reason_text(difficulty, job_result, signals),
                "signals": {
                    kind: {
                        "score": signals[difficulty][kind]["score"],
                        "primary_score": signals[difficulty][kind]["primary_score"],
                        "fit": fit_level(kind, signals[difficulty]),
                        "evidence": [{key: item[key] for key in ("id", "word", "points", "text")} for item in signals[difficulty][kind]["evidence"]],
                    }
                    for kind in TWO_STAGE_MATERIAL_TYPES
                },
            }
    result = {key: value for key, value in plan.items() if key != "targets"}
    result["schema_version"] = MIX_PLAN_SCHEMA
    result["material_mix_rule_version"] = MIX_RULE_VERSION
    result["targets"] = targets
    result["material_mix_counts"] = mix_counts(targets)
    return result


def mix_counts(targets: list[dict[str, Any]]) -> dict[str, Any]:
    """배정의 수: 난이도별 데이터 형태, 허용 목록에 든 형태, 세 미션이 모두 다른 직업, 겹친 직업."""

    def tally(values: list[str]) -> dict[str, int]:
        result: dict[str, int] = {}
        for value in values:
            result[value] = result.get(value, 0) + 1
        return dict(sorted(result.items(), key=lambda item: (-item[1], item[0])))

    by_difficulty: dict[str, Any] = {}
    for difficulty in DIFFICULTIES:
        items = [target["material_mix"] for target in targets if target["difficulty"] == difficulty]
        by_difficulty[difficulty] = {
            "targets": len(items),
            "lead_data_type": tally([item["lead_data_type"] for item in items]),
            "standard_type": tally([item["standard_type"] for item in items if item["standard_type"]]),
            "in_allowed": tally([kind for item in items for kind in item["allowed_material_types"]]),
            "allowed_size": tally([str(len(item["allowed_material_types"])) for item in items]),
            "allowed_lists": tally(["+".join(item["allowed_material_types"]) for item in items]),
        }
    jobs: dict[str, list[dict[str, Any]]] = {}
    for target in targets:
        jobs.setdefault(str(target["job_cd"]), []).append(target)
    all_distinct = [job for job, items in jobs.items() if len({item["material_mix"]["lead_data_type"] for item in items}) == len(items)]
    shared_jobs = sorted({str(target["job_cd"]) for target in targets if target["material_mix"]["shared_types"]})
    return {
        "targets": len(targets),
        "jobs": len(jobs),
        "by_difficulty": by_difficulty,
        "lead_data_type": tally([target["material_mix"]["lead_data_type"] for target in targets]),
        "standard_type": tally([target["material_mix"]["standard_type"] for target in targets if target["material_mix"]["standard_type"]]),
        "in_allowed": tally([kind for target in targets for kind in target["material_mix"]["allowed_material_types"]]),
        "jobs_with_distinct_data_types": len(all_distinct),
        "jobs_with_shared_types": len(shared_jobs),
        "shared_jobs": [
            {
                "job_cd": job,
                "job_name": jobs[job][0].get("job_name"),
                "shared": sorted({kind for item in jobs[job] for kind in item["material_mix"]["shared_types"]}),
            }
            for job in shared_jobs
        ],
        "table_always_offered_jobs": sum(
            1 for items in jobs.values() if all("table" in item["material_mix"]["allowed_material_types"] for item in items)
        ),
    }


CSV_COLUMNS = [
    ("job_cd", "직업코드"),
    ("job_name", "직업"),
    ("difficulty_label", "난이도"),
    ("unit_name", "능력단위"),
    ("allowed_text", "쓸 수 있는 형태"),
    ("lead_text", "데이터 형태"),
    ("standard_text", "기준·요청 형태"),
    ("spare_text", "덧붙인 형태"),
    ("shared_text", "겹친 형태"),
    ("scores_text", "형태 점수"),
    ("reason", "이유"),
]


def render_csv(plan: dict[str, Any]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([label for _key, label in CSV_COLUMNS])
    for target in plan["targets"]:
        mix = target["material_mix"]
        row = {
            **target,
            "difficulty_label": DIFFICULTY_LABELS[target["difficulty"]],
            "allowed_text": ", ".join(TYPE_LABELS[kind] for kind in mix["allowed_material_types"]),
            "lead_text": TYPE_LABELS[mix["lead_data_type"]],
            "standard_text": TYPE_LABELS.get(mix["standard_type"] or "", ""),
            "spare_text": ", ".join(TYPE_LABELS[kind] for kind in mix["spare_types"]),
            "shared_text": ", ".join(TYPE_LABELS[kind] for kind in mix["shared_types"]),
            "scores_text": " ".join(f"{TYPE_LABELS[kind]}{mix['signals'][kind]['score']:g}" for kind in TWO_STAGE_MATERIAL_TYPES),
            "reason": mix["reason"],
        }
        writer.writerow([row.get(key, "") if row.get(key) is not None else "" for key, _label in CSV_COLUMNS])
    return buffer.getvalue()


def write_mix(plan: dict[str, Any], out: str | Path) -> dict[str, Path]:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "plan": out_dir / "mission_targets_mix.json",
        "csv": out_dir / "material_mix.csv",
        "summary": out_dir / "material_mix_summary.json",
    }
    paths["plan"].write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    paths["csv"].write_text(render_csv(plan), encoding="utf-8-sig", newline="")
    summary = {
        "schema_version": plan["schema_version"],
        "material_mix_rule_version": plan["material_mix_rule_version"],
        "counts": plan["material_mix_counts"],
    }
    paths["summary"].write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return paths


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="배치표의 대상마다 쓸 수 있는 자료 형태를 좁혀 정한다(한 직업의 세 미션이 서로 다른 형태).")
    parser.add_argument("--plan", required=True, help="target_planner가 쓴 mission_targets.json")
    parser.add_argument("--ncs-root", required=True, help="생성기 입력 폴더(ncs_jobs)")
    parser.add_argument("--out", required=True, help="배정을 붙인 배치표와 표를 쓸 폴더")
    parser.add_argument("--jobs", default=None, help="이 직업만(쉼표로 구분). 비우면 모든 직업")
    args = parser.parse_args(argv)
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8-sig"))
    if args.jobs:
        only = [code.strip() for code in args.jobs.split(",") if code.strip()]
        plan = {**plan, "targets": [target for target in plan.get("targets") or [] if target.get("job_cd") in only]}
    mixed = plan_materials(plan, load_units(args.ncs_root))
    paths = write_mix(mixed, args.out)
    counts = mixed["material_mix_counts"]
    print(f"직업 {counts['jobs']}개 · 대상 {counts['targets']}개 (규칙 {MIX_RULE_VERSION})")
    for difficulty in DIFFICULTIES:
        item = counts["by_difficulty"][difficulty]
        print(f"  {DIFFICULTY_LABELS[difficulty]}: 데이터 {item['lead_data_type']} · 기준·요청 {item['standard_type']}")
    print(f"  세 미션의 데이터 형태가 모두 다른 직업 {counts['jobs_with_distinct_data_types']} · 겹친 직업 {counts['jobs_with_shared_types']}")
    print(f"저장: {paths['plan']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
