# 근거 설계(두 단계 생성) 테스트가 함께 쓰는 작은 데이터. 무역사무원의 수출통관 능력단위를 줄인 것이다.

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from src.mission_generation.basis_source_pack import SourcePackBuilder

JOB_CD = "K000000918"
EXEC_TEXT = "수출입 허가서, 신용장 등 통관 서류를 인수하여 세관 신고서류를 작성하고 통관절차를 밟는다."
SUMMARY_TEXT = "재료나 상품의 통관 및 수출입 계약 거래 등에 관한 사무적인 업무를 수행한다."
# NCS 원문 그대로다. "따라" 뒤의 이중 공백도 원문에 있다.
CRITERION = "수출신고서의 구성항목에 따라  신고자 상호, 대행자 상호, 수출신고가격, 환급신청인 등을 작성할 수 있다."
UNIT_KEY = "02040302:10"
# 로더와 실행기는 작업 폴더 안의 경로만 받는다. 그런 테스트는 이 폴더 아래에 파일을 만들고 지운다.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRATCH_ROOT = PROJECT_ROOT / "outputs" / "_pytest_basis"


def _evidence(name: str, score: int, rank: int, file_name: str, field: str) -> dict[str, Any]:
    return {
        "name": name,
        "score": score,
        "description": f"{name}에 관한 설명",
        "rank": rank,
        "source_ref": {"file": f"{JOB_CD}/{file_name}", "field": field, "index": rank},
    }


def sample_profile() -> dict[str, Any]:
    return {
        "schema_version": "job_mission_profile.v1",
        "source_root": "data/api_raw",
        "job_identity": {
            "job_cd": JOB_CD,
            "job_lrcl_nm": "경영·사무·금융·보험직",
            "job_mdcl_nm": "무역·운송·생산·품질 사무원",
            "job_smcl_nm": "무역사무원",
            "source_ref": {"file": f"{JOB_CD}/dtlGb_2.xml", "field": "jobsDo", "index": None},
        },
        "work": {
            "job_summary": {"text": SUMMARY_TEXT, "source_ref": {"file": f"{JOB_CD}/dtlGb_2.xml", "field": "jobsDo.jobSum"}},
            "exec_jobs": [
                {
                    "exec_job_id": "exec_001",
                    "text": EXEC_TEXT,
                    "source_ref": {"file": f"{JOB_CD}/dtlGb_2.xml", "field": "jobsDo.execJob", "index": 1},
                },
                {
                    "exec_job_id": "exec_002",
                    "text": "수출입 계약문서를 작성한다.",
                    "source_ref": {"file": f"{JOB_CD}/dtlGb_2.xml", "field": "jobsDo.execJob", "index": 2},
                },
            ],
        },
        "technical_context": {"techn_know": {"text": "무역, 유통 관련 지식이 필요하다."}},
        "evidence": {
            "work_activities": [
                _evidence("행정, 관리 업무", 97, 1, "dtlGb_7.xml", "jobActv.jobActvImprtnc"),
                _evidence("정보 처리", 93, 2, "dtlGb_7.xml", "jobActv.jobActvImprtnc"),
            ],
            "abilities": [
                _evidence("전산", 92, 1, "dtlGb_5.xml", "ablKnwEnv.jobAbil"),
                _evidence("읽고 이해하기", 90, 2, "dtlGb_5.xml", "ablKnwEnv.jobAbil"),
            ],
            "knowledge": [_evidence("운송", 97, 1, "dtlGb_5.xml", "ablKnwEnv.Knwldg")],
            "work_environment": [_evidence("재택근무", 93, 1, "dtlGb_5.xml", "ablKnwEnv.jobsEnv")],
        },
        "source_files": [],
        "loader_warnings": [],
        "loader_errors": [],
    }


def sample_unit() -> dict[str, Any]:
    return {
        "unit_key": UNIT_KEY,
        "exec_job_id": "exec_001",
        "exec_job_text": EXEC_TEXT,
        "duty_cd": "02040302",
        "duty_name": "수출입관리",
        "duty_def": "수출입관리란 수출입 계약, 통관, 대금 결제를 관리하는 일이다.",
        "unit_cd": "10",
        "ncs_cl_cd": "0204030210_24v3",
        "unit_name": "수출통관",
        "unit_def": "수출통관이란 수출물품의 신속한 통관을 위하여 서류작성 등의 통관계획을 수립하고 진행하는 능력이다.",
        "unit_level": 3,
        "elements": [
            {
                "no": 1,
                "name": "수출통관 준비하기",
                "criteria": ["수출통관 절차에 따라 물품소재지 관할 세관에 수출신고를 준비할 수 있다."],
            },
            {"no": 2, "name": "수출신고서 작성하기", "criteria": [CRITERION]},
        ],
        "scope": {
            "documents": ["UNIPASS", "관세법"],
            "considerations": ["FTA란 회원국 간의 무역장벽을 완화하는 협정이다."],
        },
        "eval_considerations": ["수출신고를 위한 UNIPASS의 이해", "관세환급에 필요한 서류 준비", "수출신고서 작성능력"],
        "link": {
            "match": "직접",
            "reason": "통관 서류를 받아 세관 신고서류를 쓰는 일이 수출통관의 서류작성과 같다",
            "judged_by": "시범 판단자",
            "criteria": "v0.1",
            "judged_at": "판단한 날",
        },
    }


# v0.3 연결 판단이 더하는 값: 문장의 구절, 2차 판정, 맞는 수행준거 번호.
V03_LINK = {
    "criteria": "v0.3",
    "phrase": "세관 신고서류를 작성",
    "verdict": "확정",
    "criteria_refs": ["2.1"],
    "verdict_reason": "수출신고서 항목 작성이 신고서류 작성 그대로다",
}


def sample_unit_v03() -> dict[str, Any]:
    """v0.3 연결 판단(구절, 판정, 수행준거 번호)이 실린 능력단위."""

    unit = sample_unit()
    unit["link"].update(copy.deepcopy(V03_LINK))
    return unit


def sample_ncs_job() -> dict[str, Any]:
    return {
        "schema_version": "ncs_job_material.v2",
        "job_cd": JOB_CD,
        "job_name": "무역사무원",
        "keco": {"code": "0281", "name": "무역 사무원"},
    }


def write_link_csv(folder: Path) -> Path:
    path = Path(folder) / "ncs_keco_link.csv"
    path.write_text(
        "duty_cd,lclas_nm,mclas_nm,sclas_nm,duty_nm,keco_cd,keco_nm\n"
        "02040302,경영·회계·사무,생산·품질관리,물류무역관리,수출입관리,0233,관세사\n"
        "02040302,경영·회계·사무,생산·품질관리,물류무역관리,수출입관리,0281,무역 사무원\n"
        "02040303,경영·회계·사무,생산·품질관리,물류무역관리,원산지관리,0281,무역 사무원\n",
        encoding="utf-8",
    )
    return path


_DIFFICULTY = {
    "easy": {"label": "쉬움", "material_count_range": [1, 1], "task_count_range": [1, 1], "answer_length_hint": "1-2 short sentences"},
    "normal": {"label": "보통", "material_count_range": [2, 2], "task_count_range": [1, 1], "answer_length_hint": "2-3 short sentences"},
    "hard": {"label": "어려움", "material_count_range": [3, 3], "task_count_range": [2, 2], "answer_length_hint": "2-4 short sentences per task"},
}


def sample_decisions(level: str = "normal") -> dict[str, Any]:
    """검사와 설계서에 필요한 시스템 결정의 일부(난이도 규칙, 허용 자료 형태)."""

    profile = sample_profile()
    return {
        "schema_version": "system_decisions.v1",
        "job_cd": JOB_CD,
        "job_name": "무역사무원",
        "difficulty": {"level": level, "estimated_time_minutes": 15, **copy.deepcopy(_DIFFICULTY[level])},
        "selected_exec_job": copy.deepcopy(profile["work"]["exec_jobs"][0]),
        "primary_task_type": "communication_and_reporting",
        "secondary_task_types": [],
        "allowed_material_types": ["chart", "table"],
    }


def sample_pack(folder: Path, *, unit: dict[str, Any] | None = None, ncs_job: dict[str, Any] | None = None) -> dict[str, Any]:
    """임시 폴더에 작은 연계표를 쓰고 근거 자료 묶음을 만든다. KNOW 원본 폴더는 비어 있다."""

    builder = SourcePackBuilder(link_csv=write_link_csv(folder), source_root=Path(folder) / "api_raw")
    return builder.build(
        job_profile=sample_profile(),
        ncs_job=sample_ncs_job() if ncs_job is None else ncs_job,
        unit=sample_unit() if unit is None else unit,
        exec_job_id="exec_001",
    )


def sample_blueprint() -> dict[str, Any]:
    """보통 난이도(자료 2개, 과제 1개)용 설계서."""

    return {
        "schema_version": "mission_blueprint.v1",
        "focus": {
            "exec_ref": "K.exec.1",
            "focus_phrase": "세관 신고서류를 작성",
            "coverage": "partial",
            "uncovered_note": "통관 서류 인수와 통관절차 진행은 다루지 않는다",
            "reason": "신고서류 작성은 자료를 보고 판단하는 문서형 과제로 만들 수 있다",
        },
        "criteria": [{"ref": "N.c.2.1", "reason": "서식 칸이 구체적으로 나와 있어 자료로 만들 수 있다"}],
        "materials": [
            {
                "slot": 1,
                "type": "table",
                "type_reason": "수출신고서의 구성항목을 항목별로 적은 서식이라 표로 보인다",
                "role": "기준이 되는 확정 내용",
                "refs": ["N.c.2.1"],
                "borrowed_terms": [
                    {"term": "신고자 상호", "ref": "N.c.2.1"},
                    {"term": "수출신고가격", "ref": "N.c.2.1"},
                    {"term": "환급신청인", "ref": "N.c.2.1"},
                ],
                "content_plan": "이번 수출 건에서 확정된 값을 항목별로 적은 표",
            },
            {
                "slot": 2,
                "type": "table",
                "type_reason": "같은 서식의 초안이라 같은 표로 보인다",
                "role": "검토할 신고서 초안",
                "refs": ["N.c.2.1"],
                "borrowed_terms": [],
                "content_plan": "같은 항목을 적되 한 칸의 값이 확정 내용과 다른 표",
            },
        ],
        "tasks": [
            {
                "slot": 1,
                "action": "두 표를 대조해 다른 칸을 찾아 전달한다",
                "refs": ["N.c.2.1"],
                "reason": "보통 난이도는 과제 하나에 비교 하나다",
            }
        ],
        "evaluation_basis": [
            {
                "refs": ["N.eval.3"],
                "know_refs": ["K.abil.2"],
                "what_to_check": "다른 칸을 정확히 짚고 고칠 값을 전달하는가",
                "reason": "평가 지침의 '수출신고서 작성능력'에 해당한다",
            }
        ],
        "glossary_terms": [{"term": "수출신고서", "ref": "N.c.2.1"}],
    }


def _table(material_id: str, title: str, price: str) -> dict[str, Any]:
    rows = [("신고자 상호", "구름나루"), ("수출신고가격", price), ("환급신청인", "구름나루")]
    return {
        "material_id": material_id,
        "type": "table",
        "subtype": "comparison",
        "title": title,
        "description": "항목별 내용을 적은 표입니다.",
        "factual_status": "synthetic_mission_material",
        "used_for": "항목 대조",
        "evidence_source": ["읽고 이해하기"],
        "mission_fact_refs": ["org_name"],
        "data": {
            "columns": [{"key": "option", "label": "항목"}, {"key": "strength", "label": "내용"}],
            "rows": [{"option": name, "strength": value, "weakness": "-", "priority": idx} for idx, (name, value) in enumerate(rows, start=1)],
        },
    }


def sample_mission() -> dict[str, Any]:
    """sample_blueprint대로 쓴 미션(mission_output.v1에서 검사와 근거 기록에 쓰는 부분)."""

    profile = sample_profile()
    return {
        "schema_version": "mission_output.v1",
        "mission_id": "mission_K000000918_normal_001",
        "job_identity": copy.deepcopy(profile["job_identity"]),
        "target_exec_job": copy.deepcopy(profile["work"]["exec_jobs"][0]),
        "mission": {
            "title": "수출신고서 초안 확인하기",
            "task_type": "communication_and_reporting",
            "difficulty": {"level": "normal", "label": "보통"},
            "scenario": {
                "role": "가상 회사 구름나루의 무역사무 인턴",
                "context": "담당자가 이번 수출 건의 신고서 초안을 만들었습니다.",
                "goal": "담당자에게 초안에서 고칠 내용을 짧게 전달합니다.",
                "constraints": [],
                "glossary": [{"term": "수출신고서", "definition": "물품을 해외로 보낼 때 세관에 제출하는 신고 내용입니다."}],
            },
            "materials": [
                _table("mat_001", "이번 수출 건의 확정 내용", "120만 원"),
                _table("mat_002", "전자 수출신고서 초안", "140만 원"),
            ],
            "tasks": [
                {
                    "task_id": "task_001",
                    "instruction": "두 자료를 보고, 초안에서 고칠 항목과 그 이유를 2~3문장으로 전달해 보세요.",
                    "required_materials": ["mat_001", "mat_002"],
                    "expected_action": "다른 항목을 찾아 전달한다",
                }
            ],
        },
        "evaluation": {
            "expected_insights": ["초안의 수출신고가격은 140만 원이지만 확정 내용은 120만 원이다."],
            "rubric": [
                {"criterion": "항목 대조", "description": "수출신고가격이 다르다는 점을 짚는다.", "points": 50, "linked_evidence": ["읽고 이해하기"]},
                {"criterion": "수정 내용 전달", "description": "고칠 값을 담당자에게 전달한다.", "points": 50, "linked_evidence": ["읽고 이해하기"]},
            ],
        },
    }
