# 근거 자료 묶음: KNOW 프로필, NCS–KECO 연계표, NCS 능력단위의 원문을 번호 붙은 조각으로 만든다.
#
# 두 단계 생성(설계서 → 미션 작성)의 모든 단계가 이 번호로 원문을 가리킨다.
# 번호 규칙: K.* = KNOW, L.* = 연계표 행, M.1 = 문장과 능력단위의 연결, N.* = NCS 능력단위.

from __future__ import annotations

import copy
import csv
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .utils import project_path

SOURCE_PACK_SCHEMA = "basis_source_pack.v1"
LINK_TABLE_FILE = "data/ncs/ncs_keco_link_20230407.csv"
LINK_TABLE_LABEL = "NCS–KECO 연계표(ncs.go.kr 일반자료실 2023-04-10 게시, 2022-11-28 NCS 개정고시 기준)"

# 설계서가 채점 근거로 고를 수 있는 KNOW 항목 묶음: (프로필의 키, 번호 머리, 조각 종류)
_KNOW_GROUPS = (
    ("work_activities", "K.act", "know_activity"),
    ("abilities", "K.abil", "know_ability"),
    ("knowledge", "K.know", "know_knowledge"),
)

# 연결 판단(link)에서 M.1 조각에 싣는 값. 앞의 넷은 늘 싣고, 뒤의 넷(v0.3 기준부터 있음)은 값이 있을 때만 싣는다.
_LINK_META_KEYS = ("match", "judged_by", "criteria", "judged_at")
_LINK_OPTIONAL_KEYS = ("phrase", "verdict", "criteria_refs", "verdict_reason")


def squash(text: str | None) -> str:
    """공백 문자를 모두 지운다. NCS 원문에 이중 공백과 줄바꿈이 섞여 있어 대조 전에 쓴다."""

    return re.sub(r"\s+", "", text or "")


def contains_verbatim(haystack: str | None, needle: str | None) -> bool:
    """공백 차이만 무시하고 needle이 haystack에 글자 그대로 들어 있는지 본다. 빈 needle은 거짓이다."""

    target = squash(needle)
    return bool(target) and target in squash(haystack)


def numbered_criteria(unit: dict[str, Any]) -> list[dict[str, Any]]:
    """능력단위의 수행준거에 `요소 번호.순번`(예: 2.1)을 붙여 돌려준다.

    근거 자료 묶음의 N.c.* 번호와 문장–능력단위 짝 짓기(scripts/ncs_link.py)가 이 규칙 하나를 함께 쓴다.
    요소 번호는 `no`가 정수면 그 값, 아니면 순서(1부터)다.
    """

    numbered: list[dict[str, Any]] = []
    for position, element in enumerate(unit.get("elements") or [], start=1):
        element_no = element.get("no") if isinstance(element.get("no"), int) else position
        for order, criterion in enumerate(element.get("criteria") or [], start=1):
            numbered.append(
                {
                    "number": f"{element_no}.{order}",
                    "element_no": element_no,
                    "criterion_no": order,
                    "element_name": element.get("name"),
                    "text": criterion,
                }
            )
    return numbered


def pieces_by_id(source_pack: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {piece["id"]: piece for piece in source_pack.get("pieces", [])}


def link_basis(source_pack: dict[str, Any]) -> dict[str, Any] | None:
    """연결 판단(M.1)이 남긴 근거 가운데 설계서에 알려 줄 것: 구절, 직접/간접, 확정된 수행준거의 조각 번호.

    설계서 프롬프트에 들어가는 수행준거 조각만 남긴다. 그런 번호가 하나도 없으면(구절·번호가 없는 옛 연결 포함) None이다.
    """

    pieces = pieces_by_id(source_pack)
    meta = (pieces.get("M.1") or {}).get("meta") or {}
    refs = meta.get("criteria_refs") if isinstance(meta.get("criteria_refs"), list) else []
    ids = [f"N.c.{ref}" for ref in refs if (pieces.get(f"N.c.{ref}") or {}).get("in_prompt")]
    if not ids:
        return None
    return {"phrase": meta.get("phrase"), "match": meta.get("match"), "criteria_refs": ids}


def prompt_pieces(source_pack: dict[str, Any]) -> list[dict[str, Any]]:
    """설계서 프롬프트에 넣을 조각만 추린다(번호, 종류, 원문, 덧붙임 정보)."""

    return [
        {"id": piece["id"], "kind": piece["kind"], "text": piece["text"], "meta": piece.get("meta", {})}
        for piece in source_pack.get("pieces", [])
        if piece.get("in_prompt")
    ]


def writer_job_profile(job_profile: dict[str, Any], exec_job_id: str, know_names: list[str]) -> dict[str, Any]:
    """미션 작성 단계에 줄 프로필. 대상 하는 일 문장과 설계서가 고른 KNOW 항목만 남긴다."""

    work = job_profile.get("work", {})
    chosen = set(know_names)
    return {
        "schema_version": job_profile.get("schema_version"),
        "job_identity": copy.deepcopy(job_profile.get("job_identity", {})),
        "work": {
            "job_summary": copy.deepcopy(work.get("job_summary")),
            "exec_jobs": [copy.deepcopy(item) for item in work.get("exec_jobs", []) if item.get("exec_job_id") == exec_job_id],
        },
        "evidence": {
            group: [copy.deepcopy(item) for item in items if isinstance(item, dict) and item.get("name") in chosen]
            for group, items in job_profile.get("evidence", {}).items()
        },
    }


class SourcePackBuilder:
    """직업 하나의 (하는 일 문장, 능력단위) 짝에 대한 근거 자료 묶음을 만든다."""

    def __init__(self, link_csv: str | Path = LINK_TABLE_FILE, source_root: str | Path = "data/api_raw") -> None:
        # 상대 경로는 작업 폴더 기준으로 풀고, 절대 경로는 그대로 쓴다.
        self.link_csv_label = Path(link_csv).as_posix()
        self.link_csv = self._resolve(link_csv)
        self.source_root = self._resolve(source_root)

    @staticmethod
    def _resolve(path: str | Path) -> Path:
        candidate = Path(path)
        return candidate if candidate.is_absolute() else project_path(candidate)

    def build(self, *, job_profile: dict[str, Any], ncs_job: dict[str, Any], unit: dict[str, Any], exec_job_id: str) -> dict[str, Any]:
        job_cd = str(job_profile.get("job_identity", {}).get("job_cd") or ncs_job.get("job_cd") or "")
        pieces: list[dict[str, Any]] = []
        warnings: list[dict[str, str]] = []

        target = next(
            (item for item in job_profile.get("work", {}).get("exec_jobs", []) if item.get("exec_job_id") == exec_job_id),
            None,
        )
        if target is None:
            raise ValueError(f"exec job {exec_job_id} is not in the job profile of {job_cd}")
        exec_index = (target.get("source_ref") or {}).get("index")
        if not isinstance(exec_index, int):
            exec_index = job_profile["work"]["exec_jobs"].index(target) + 1
        target_exec_ref = f"K.exec.{exec_index}"
        pieces.append(self._piece(target_exec_ref, "know_exec", target.get("text"), target.get("source_ref")))

        summary = job_profile.get("work", {}).get("job_summary") or {}
        if summary.get("text"):
            pieces.append(self._piece("K.sum", "know_summary", summary["text"], summary.get("source_ref")))

        for group, prefix, kind in _KNOW_GROUPS:
            for position, item in enumerate(job_profile.get("evidence", {}).get(group, []), start=1):
                if not isinstance(item, dict) or not item.get("name"):
                    continue
                rank = item.get("rank") if isinstance(item.get("rank"), int) else position
                meta = {"score": item.get("score"), "description": item.get("description")}
                pieces.append(self._piece(f"{prefix}.{rank}", kind, item["name"], item.get("source_ref"), meta=meta))

        duty_cd = str(unit.get("duty_cd") or str(unit.get("unit_key") or "").partition(":")[0])
        unit_key = str(unit.get("unit_key") or f"{duty_cd}:{unit.get('unit_cd')}")

        keco = self._keco(job_cd, ncs_job)
        if keco is None:
            warnings.append({"code": "SP_KECO_MISSING", "message": f"{job_cd}의 KECO 코드를 능력단위 파일과 KNOW 원본에서 찾지 못했다."})
        else:
            pieces.append(
                self._piece(
                    "K.keco",
                    "know_keco",
                    f"{keco['code']} {keco['name']}".strip(),
                    {"file": f"{job_cd}/dtlGb_3.xml", "field": "kecoCd"},
                    in_prompt=False,
                    meta={"code": keco["code"], "name": keco["name"]},
                )
            )

        link_rows = self._link_rows(keco["code"]) if keco is not None else []
        for number, row in enumerate(link_rows, start=1):
            pieces.append(
                self._piece(
                    f"L.{number}",
                    "link_row",
                    f"{row.get('keco_cd', '')} {row.get('keco_nm', '')} ↔ {row.get('duty_cd', '')} {row.get('duty_nm', '')}",
                    {"file": self.link_csv_label, "keco_cd": row.get("keco_cd"), "duty_cd": row.get("duty_cd")},
                    in_prompt=False,
                    meta={**row, "matches_unit_duty": row.get("duty_cd") == duty_cd},
                )
            )
        if not any(row.get("duty_cd") == duty_cd for row in link_rows):
            warnings.append(
                {"code": "SP_LINK_ROW_MISSING", "message": f"연계표에서 이 직업의 KECO 코드와 직무 {duty_cd}를 잇는 행을 찾지 못했다."}
            )

        criteria = numbered_criteria(unit)
        link = unit.get("link")
        if isinstance(link, dict) and (link.get("reason") or link.get("match")):
            link_meta = {key: link.get(key) for key in _LINK_META_KEYS}
            # 구절, 판정, 수행준거 번호는 있을 때만 싣는다. 없는 옛 파일은 예전과 같은 조각이 나온다.
            link_meta.update({key: copy.deepcopy(link[key]) for key in _LINK_OPTIONAL_KEYS if link.get(key)})
            pieces.append(
                self._piece(
                    "M.1",
                    "sentence_unit_link",
                    link.get("reason"),
                    {"unit_key": unit_key, "exec_job_id": exec_job_id},
                    in_prompt=False,
                    meta=link_meta,
                )
            )
            known_numbers = {item["number"] for item in criteria}
            refs = link.get("criteria_refs") if isinstance(link.get("criteria_refs"), list) else []
            unknown = [str(ref) for ref in refs if str(ref) not in known_numbers]
            if unknown:
                warnings.append(
                    {
                        "code": "SP_LINK_CRITERIA_REF_UNKNOWN",
                        "message": f"연결 판단이 적은 수행준거 번호 {', '.join(unknown)}이(가) 이 능력단위의 수행준거에 없다.",
                    }
                )
        else:
            warnings.append({"code": "SP_LINK_REASON_MISSING", "message": "능력단위 파일에 문장과 능력단위를 이은 이유(link)가 없다."})

        unit_locator = {"unit_key": unit_key, "ncs_cl_cd": unit.get("ncs_cl_cd")}
        pieces.append(self._piece("N.duty", "ncs_duty", unit.get("duty_name"), {"duty_cd": duty_cd}, meta={"definition": unit.get("duty_def")}))
        pieces.append(
            self._piece(
                "N.unit",
                "ncs_unit",
                unit.get("unit_name"),
                unit_locator,
                meta={
                    "definition": unit.get("unit_def"),
                    "level": unit.get("unit_level"),
                    "unit_key": unit_key,
                    "ncs_cl_cd": unit.get("ncs_cl_cd"),
                },
            )
        )
        for item in criteria:
            pieces.append(
                self._piece(
                    f"N.c.{item['number']}",
                    "ncs_criterion",
                    item["text"],
                    {**unit_locator, "element_no": item["element_no"], "criterion_no": item["criterion_no"]},
                    meta={"element_name": item["element_name"]},
                )
            )
        scope = unit.get("scope") or {}
        sections = (
            ("N.doc", "ncs_document", "documents", scope.get("documents", [])),
            ("N.con", "ncs_consideration", "considerations", scope.get("considerations", [])),
            ("N.eval", "ncs_eval", "eval_considerations", unit.get("eval_considerations", [])),
        )
        for prefix, kind, section, items in sections:
            for number, text in enumerate(items or [], start=1):
                pieces.append(self._piece(f"{prefix}.{number}", kind, text, {**unit_locator, "section": section, "index": number}))

        return {
            "schema_version": SOURCE_PACK_SCHEMA,
            "job_cd": job_cd,
            "exec_job_id": exec_job_id,
            "target_exec_ref": target_exec_ref,
            "unit_key": unit_key,
            "know_source_root": job_profile.get("source_root"),
            "link_table": {"file": self.link_csv_label, "label": LINK_TABLE_LABEL},
            "pieces": pieces,
            "warnings": warnings,
        }

    @staticmethod
    def _piece(
        piece_id: str,
        kind: str,
        text: Any,
        locator: dict[str, Any] | None,
        *,
        in_prompt: bool = True,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "id": piece_id,
            "kind": kind,
            "text": "" if text is None else str(text),
            "locator": copy.deepcopy(locator or {}),
            "in_prompt": in_prompt,
            "meta": meta or {},
        }

    def _keco(self, job_cd: str, ncs_job: dict[str, Any]) -> dict[str, str] | None:
        """직업의 KECO 코드. 능력단위 파일에 없으면 KNOW 원본(dtlGb_3.xml)에서 읽는다."""

        keco = ncs_job.get("keco")
        if isinstance(keco, dict) and keco.get("code"):
            return {"code": str(keco["code"]), "name": str(keco.get("name") or "")}
        path = self.source_root / job_cd / "dtlGb_3.xml"
        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError):
            return None
        code = (root.findtext(".//kecoCd") or "").strip()
        if not code:
            return None
        return {"code": code, "name": (root.findtext(".//kecoNm") or "").strip()}

    def _link_rows(self, keco_cd: str) -> list[dict[str, str]]:
        """연계표에서 이 KECO 코드의 행을 파일 순서대로 돌려준다. 파일이 없으면 빈 목록이다."""

        try:
            with self.link_csv.open(encoding="utf-8-sig", newline="") as handle:
                return [dict(row) for row in csv.DictReader(handle) if (row.get("keco_cd") or "").strip() == keco_cd]
        except OSError:
            return []
