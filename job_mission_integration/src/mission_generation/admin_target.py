# 한 건짜리 대상 파일 만들기: (직업, 하는 일 문장, 능력단위, 난이도) 하나를 실행기의 --ncs-targets가 읽는 모양으로 쓴다.
#
# 고를 수 있는 연결은 "직접"과 "간접(분야 한정)"뿐이다. 그 밖의 연결이나 없는 연결을 주면 파일을 쓰지 않고 오류를 낸다.
# 자료 형태는 요청으로 받지 않는다. 낱말 규칙(material_planner)이 그 문장·능력단위·난이도에 쓸 형태를 좁혀 대상에 붙인다.
# --no-narrow를 주면 형태 목록을 붙이지 않는다(실행기가 일곱 형태를 모두 연다).
#
#   python -m src.mission_generation.admin_target --job K… --exec exec_… --unit 직무:능력단위 --difficulty easy|normal|hard
#       [--ncs-root data/ncs/jobs] [--no-narrow] (--out <파일> | --print)
#
# 출력은 JSON 한 줄이다. --out은 {"ok": true, "out": 경로, "allowed_material_types": [...]}, --print는 대상 그대로,
# 오류는 {"ok": false, "error": {"code", "message"}}와 종료 코드 1이다. 대상 오류(TARGET_BAD_DIFFICULTY 등 넷) 말고도
# 파일을 쓰지 못하면 TARGET_WRITE_FAILED, 예상 못 한 오류면 TARGET_INTERNAL_ERROR를 낸다.

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from .material_planner import plan_materials
from .pilot_runner import NCS_TARGET_DIFFICULTIES

TARGET_SCHEMA = "admin_single_target.v1"
# 간접 연결 가운데 고를 수 있는 종류. 범위 넓음, 상위 수준은 고를 수 없다.
SELECTABLE_INDIRECT_KINDS = ("분야 한정",)
# 직업 코드는 파일 이름으로 쓰인다. 다른 경로를 가리키는 글자는 받지 않는다.
_JOB_CD_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")


class TargetError(ValueError):
    """대상을 만들 수 없을 때. code는 TARGET_BAD_DIFFICULTY, TARGET_JOB_NOT_FOUND, TARGET_LINK_NOT_FOUND, TARGET_LINK_NOT_SELECTABLE 가운데 하나다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def link_is_selectable(link: dict[str, Any]) -> bool:
    """직접 연결이거나, 간접 연결 가운데 분야 한정이면 고를 수 있다."""

    if not isinstance(link, dict):
        return False
    if link.get("match") == "직접":
        return True
    return link.get("match") == "간접" and link.get("indirect_kind") in SELECTABLE_INDIRECT_KINDS


def selectable_units(job: dict[str, Any]) -> list[dict[str, Any]]:
    """직업 파일의 units 가운데 고를 수 있는 것을 원래 순서로 돌려준다."""

    return [unit for unit in job.get("units") or [] if isinstance(unit, dict) and link_is_selectable(unit.get("link"))]


def _match_label(link: dict[str, Any]) -> str:
    return "직접" if link.get("match") == "직접" else f"간접({link.get('indirect_kind')})"


def _load_job(ncs_root: str | Path, job_cd: str) -> dict[str, Any]:
    path = Path(ncs_root) / f"{job_cd}.json"
    if not _JOB_CD_PATTERN.match(job_cd) or not path.is_file():
        raise TargetError("TARGET_JOB_NOT_FOUND", f"no NCS file for job {job_cd!r}")
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise TargetError("TARGET_JOB_NOT_FOUND", f"NCS file for job {job_cd!r} could not be read: {type(exc).__name__}") from exc
    if not isinstance(job, dict):
        raise TargetError("TARGET_JOB_NOT_FOUND", f"NCS file for job {job_cd!r} is not an object")
    return job


def build_target(
    ncs_root: str | Path,
    job_cd: str,
    exec_job_id: str,
    unit_key: str,
    difficulty: str,
    *,
    narrow_types: bool = True,
) -> dict[str, Any]:
    """고를 수 있는 연결인지 확인하고 대상 하나를 만든다. narrow_types가 참이면 낱말 규칙이 정한 자료 형태(material_mix)를 붙인다."""

    if difficulty not in NCS_TARGET_DIFFICULTIES:
        raise TargetError("TARGET_BAD_DIFFICULTY", f"difficulty must be one of {', '.join(NCS_TARGET_DIFFICULTIES)}, got {difficulty!r}")
    job = _load_job(ncs_root, job_cd)
    unit = next(
        (
            item
            for item in job.get("units") or []
            if isinstance(item, dict) and str(item.get("exec_job_id")) == exec_job_id and str(item.get("unit_key")) == unit_key
        ),
        None,
    )
    if unit is None:
        raise TargetError("TARGET_LINK_NOT_FOUND", f"job {job_cd} has no link between {exec_job_id!r} and unit {unit_key!r}")
    link = unit.get("link") if isinstance(unit.get("link"), dict) else {}
    if not link_is_selectable(link):
        raise TargetError(
            "TARGET_LINK_NOT_SELECTABLE",
            f"link between {exec_job_id} and unit {unit_key} is {_match_label(link)}; only 직접 and 간접({', '.join(SELECTABLE_INDIRECT_KINDS)}) can be used",
        )
    target: dict[str, Any] = {
        "job_cd": job_cd,
        "job_name": job.get("job_name"),
        "exec_job_id": exec_job_id,
        "exec_job_text": unit.get("exec_job_text"),
        "unit_key": unit_key,
        "unit_name": unit.get("unit_name"),
        "difficulty": difficulty,
        "match_label": _match_label(link),
        "phrase": link.get("phrase"),
        "criteria_refs": list(link.get("criteria_refs") or []),
    }
    if narrow_types:
        # 한 건짜리 배치표로 낱말 규칙을 돌린다. 규칙이 붙인 material_mix를 그대로 쓴다.
        planned = plan_materials({"targets": [target]}, {(job_cd, exec_job_id, unit_key): unit})
        target = planned["targets"][0]
    return target


def write_target_file(target: dict[str, Any], out: str | Path) -> Path:
    """대상 하나를 담은 파일을 쓴다. 부모 폴더가 없으면 만든다."""

    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"schema_version": TARGET_SCHEMA, "targets": [target]}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return path


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="미션 한 건의 대상 파일을 만든다. 직접 또는 분야 한정 연결만 받는다.")
    parser.add_argument("--job", required=True, help="직업 코드(K…)")
    parser.add_argument("--exec", required=True, dest="exec_job_id", help="하는 일 문장의 번호(exec_…)")
    parser.add_argument("--unit", required=True, help="능력단위(직무코드:능력단위번호)")
    parser.add_argument("--difficulty", required=True, help="easy, normal, hard 가운데 하나")
    parser.add_argument("--ncs-root", default="data/ncs/jobs", help="직업별 NCS 파일이 있는 폴더")
    parser.add_argument("--no-narrow", action="store_true", help="자료 형태 목록을 붙이지 않는다(일곱 형태를 모두 연다)")
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--out", default=None, help="대상 파일을 쓸 경로")
    where.add_argument("--print", action="store_true", dest="print_only", help="파일을 쓰지 않고 대상을 찍는다")
    args = parser.parse_args(argv)

    def fail(code: str, message: str) -> int:
        print(json.dumps({"ok": False, "error": {"code": code, "message": message[:500]}}, ensure_ascii=False))
        return 1

    try:
        target = build_target(args.ncs_root, args.job, args.exec_job_id, args.unit, args.difficulty, narrow_types=not args.no_narrow)
    except TargetError as exc:
        return fail(exc.code, str(exc))
    except Exception as exc:  # 낱말 규칙 등에서 난 예상 못 한 오류도 JSON 한 줄로 알린다.
        return fail("TARGET_INTERNAL_ERROR", f"{type(exc).__name__}: {exc}")
    if args.print_only:
        print(json.dumps(target, ensure_ascii=False))
        return 0
    try:
        path = write_target_file(target, args.out)
    except OSError as exc:
        return fail("TARGET_WRITE_FAILED", f"{type(exc).__name__}: {exc}")
    mix = target.get("material_mix")
    allowed = list(mix["allowed_material_types"]) if isinstance(mix, dict) else None
    print(json.dumps({"ok": True, "out": path.as_posix(), "allowed_material_types": allowed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
