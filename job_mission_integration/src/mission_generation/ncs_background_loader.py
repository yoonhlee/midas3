# data/ncs/jobs/{직업코드}.json의 NCS 능력단위를 미션 설계 의도와 LLM 배경 자료로 바꾼다.

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .utils import project_path, to_posix_relative


class NcsBackgroundLoader:
    """data/ncs/jobs/{job_cd}.json에서 능력단위 하나를 골라 배경 JSON으로 만든다.

    두 형식을 모두 읽는다.
    - v1(시험 때 형식): 난이도별 3개, 능력단위마다 `difficulty`
    - v2(1단계 매핑표 형식): 직업당 5개, 능력단위마다 `recommended_difficulty`
    """

    def __init__(self, root: str | Path = "data/ncs/jobs") -> None:
        self.root = project_path(root)

    def load(
        self,
        job_cd: str,
        difficulty_code: str,
        unit_key: str | None = None,
        exec_job_id: str | None = None,
    ) -> dict[str, Any] | None:
        """고른 능력단위가 있으면 배경 JSON을, 없으면 None을 반환한다.

        unit_key("직무코드:능력단위코드")를 주면 그 능력단위를 쓴다. 없으면 난이도로 고른다.
        exec_job_id를 함께 주면 그 하는 일 문장에 이어진 항목만 고른다(한 능력단위가 여러 문장에 이어진 직업이 있다).
        난이도는 어느 쪽이든 difficulty_code를 그대로 쓴다(validator가 이 값을 비교한다).
        """

        path = self.root / f"{job_cd}.json"
        if not path.exists():
            return None
        job = json.loads(path.read_text(encoding="utf-8"))
        unit = self.pick_unit(job.get("units", []), difficulty_code, unit_key, exec_job_id)
        if unit is None:
            return None
        # 지식·기술·태도와 장비·재료는 문서형 미션에 쓰기 어려워 프롬프트에 넣지 않는다.
        return {
            "schema_version": "job_ncs_background.v1",
            "job_cd": job_cd,
            "difficulty": difficulty_code,
            "source_path": to_posix_relative(path, project_path()),
            "exec_job_id": unit["exec_job_id"],
            "duty": {"name": unit.get("duty_name"), "definition": unit.get("duty_def")},
            "competency_unit": {
                "name": unit.get("unit_name"),
                "definition": unit.get("unit_def"),
                "level": unit.get("unit_level"),
            },
            "elements": [
                {"name": element["name"], "performance_criteria": element.get("criteria", [])}
                for element in unit.get("elements", [])
            ],
            "documents": unit.get("scope", {}).get("documents", []),
            "considerations": unit.get("scope", {}).get("considerations", []),
            "eval_considerations": unit.get("eval_considerations", []),
            "usage": "mission_design_basis",
        }

    def trace_ref(
        self,
        job_cd: str,
        difficulty_code: str,
        unit_key: str | None = None,
        exec_job_id: str | None = None,
    ) -> dict[str, Any] | None:
        """미션 사용 근거에 남길 능력단위 출처(코드·버전·하는 일 문장). 프롬프트에는 넣지 않는다."""

        path = self.root / f"{job_cd}.json"
        if not path.exists():
            return None
        units = json.loads(path.read_text(encoding="utf-8")).get("units", [])
        unit = self.pick_unit(units, difficulty_code, unit_key, exec_job_id)
        if unit is None:
            return None
        return {
            "unit_key": self.unit_key(unit),
            "ncs_cl_cd": unit.get("ncs_cl_cd"),
            "unit_name": unit.get("unit_name"),
            "duty_name": unit.get("duty_name"),
            "exec_job_id": unit.get("exec_job_id"),
            "source_path": to_posix_relative(path, project_path()),
        }

    def unit_record(
        self,
        job_cd: str,
        difficulty_code: str,
        unit_key: str | None = None,
        exec_job_id: str | None = None,
    ) -> dict[str, Any] | None:
        """근거 자료 묶음을 만들 때 쓰는 원본: 파일 머리(keco 등)와 고른 능력단위의 전체 내용(link 포함).

        프롬프트용으로 줄인 load()와 달리 원본을 그대로 준다. 파일이나 능력단위가 없으면 None이다.
        """

        path = self.root / f"{job_cd}.json"
        if not path.exists():
            return None
        job = json.loads(path.read_text(encoding="utf-8"))
        unit = self.pick_unit(job.get("units", []), difficulty_code, unit_key, exec_job_id)
        if unit is None:
            return None
        return {"ncs_job": {key: value for key, value in job.items() if key != "units"}, "unit": unit}

    @staticmethod
    def know_only_design(exec_job_text: str) -> dict[str, str]:
        """NCS 비교 시험용: 같은 하는 일 문장을 NCS 자료 없이 만들 때의 설계 의도."""

        return {
            "schema_version": "mission_design.v1",
            "mission_design_type": "know_exec_job_task",
            "design_intent": (
                f"KNOW 하는 일 문장 '{exec_job_text}'의 일을 처음 해 보는 사람이 짧게 체험할 수 있는 업무 요청으로 줄인 미션. "
                "자료는 이 일을 하는 사람이 실제로 보는 업무 문서를 닮게 만든다."
            ),
            "selection_method": "know_only_ablation",
            "selection_reason": "NCS 비교 시험: 같은 하는 일 문장과 난이도 규칙으로, NCS 자료만 빼고 만든다.",
        }

    @staticmethod
    def unit_key(unit: dict[str, Any]) -> str:
        """능력단위를 가리키는 키. scripts/fetch_ncs.py의 unit_key와 같은 "직무코드:능력단위코드" 형식이다."""

        return str(unit.get("unit_key") or f"{unit.get('duty_cd')}:{unit.get('unit_cd')}")

    @classmethod
    def pick_unit(
        cls,
        units: list[dict[str, Any]],
        difficulty_code: str,
        unit_key: str | None = None,
        exec_job_id: str | None = None,
    ) -> dict[str, Any] | None:
        """unit_key가 있으면 그 능력단위를, 없으면 v1 `difficulty` → v2 `recommended_difficulty` 순으로 고른다.

        exec_job_id가 있으면 그 하는 일 문장에 이어진 항목 안에서만 고른다. unit_key와 함께 주면 둘 다 맞는 첫 항목이다.
        """

        if exec_job_id:
            units = [item for item in units if item.get("exec_job_id") == exec_job_id]
            if not unit_key:
                return units[0] if units else None
        if unit_key:
            return next((item for item in units if cls.unit_key(item) == unit_key), None)
        exact = next((item for item in units if item.get("difficulty") == difficulty_code), None)
        if exact is not None:
            return exact
        return next((item for item in units if item.get("recommended_difficulty") == difficulty_code), None)

    @staticmethod
    def difficulty_overrides(difficulty_code: str) -> dict[str, Any]:
        """hard에서만 초보자 제한을 풀어 2단계 과제와 trade-off 판단을 허용한다(실험).

        validator가 mission.difficulty와 system_decisions.difficulty를 그대로 비교하므로 기존 키의 값만 바꾼다.
        """

        if difficulty_code != "hard":
            return {}
        return {
            "estimated_time_minutes": 20,
            "task_count_range": [2, 2],
            "answer_length_hint": "2-4 short sentences per task",
            "requires_tradeoff_judgment": True,
        }

    @staticmethod
    def mission_design(background: dict[str, Any]) -> dict[str, str]:
        """능력단위를 system_decisions.mission_design 형식의 설계 의도로 바꾼다."""

        unit = background["competency_unit"]
        documents = ", ".join(background.get("documents", [])[:4]) or "실무 문서"
        return {
            "schema_version": "mission_design.v1",
            "mission_design_type": "ncs_performance_criterion",
            "design_intent": (
                f"'{background['duty']['name']}' 직무의 '{unit['name']}' 업무에서 수행준거 하나를 골라, "
                f"처음 해 보는 사람이 짧게 체험할 수 있는 업무 요청으로 줄인 미션. "
                f"자료는 {documents} 같은 실무 문서를 닮게 만든다."
            ),
            "selection_method": "ncs_background",
            "selection_reason": f"{background['source_path']}에서 {background['difficulty']} 난이도에 고른 능력단위(수준 {unit.get('level')}).",
        }
