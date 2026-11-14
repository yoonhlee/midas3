# 사람이 직접 작성한 미션 초안(missions/manual/*.draft.json)을 검증해 카탈로그에 넣는다(U11).
# LLM 생성과 같은 validator.v1·final assembler를 거치므로 저장 형식과 신뢰도 계산이 생성 미션과 같다.
#
#   python3 scripts/build_manual_missions.py K000001196           # 검증 + 저장 + missions/index.json 갱신
#   python3 scripts/build_manual_missions.py K000001196 --check   # 검증만(파일을 바꾸지 않음)

from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.mission_generation.final_assembler import FinalMissionAssembler  # noqa: E402
from src.mission_generation.profile_loader import JobProfileLoader  # noqa: E402
from src.mission_generation.system_decision_builder import SystemDecisionBuilder  # noqa: E402
from src.mission_generation.validator import MissionValidator  # noqa: E402

DIFFICULTIES = [("easy", 1), ("normal", 2), ("hard", 3)]
JOB_ICONS = {"K000001196": "🤝"}
KEY_PREFIX = "manual_v1_20261030"


def build_draft(manual: dict, profile: dict, decisions: dict) -> dict:
    """초안에 system_decisions가 정한 고정 값(수행직무·과제 유형·난이도)을 그대로 채운다."""

    mission = copy.deepcopy(manual["mission"])
    mission["task_type"] = decisions["primary_task_type"]
    mission["secondary_task_types"] = decisions["secondary_task_types"]
    mission["difficulty"] = copy.deepcopy(decisions["difficulty"])
    ordered_mission = {
        "title": mission["title"],
        "task_type": mission["task_type"],
        "secondary_task_types": mission["secondary_task_types"],
        "difficulty": mission["difficulty"],
        "scenario": mission["scenario"],
        "materials": mission["materials"],
        "tasks": mission["tasks"],
        "submission_format": mission["submission_format"],
    }
    selected = decisions["selected_exec_job"]
    return {
        "schema_version": "mission_output.v1",
        "mission_id": "draft",
        "job_identity": copy.deepcopy(profile["job_identity"]),
        "target_exec_job": {
            "exec_job_id": selected["exec_job_id"],
            "text": selected["text"],
            "source_ref": copy.deepcopy(selected["source_ref"]),
            "selection_reason": "조사 시트(인사∙교육∙훈련사무원 HR)의 의사결정 사례(온보딩·복리후생)와 맞닿은 수행직무라 사람이 직접 골라 작성함.",
        },
        "mission_facts": copy.deepcopy(manual["mission_facts"]),
        "mission": ordered_mission,
        "evaluation": copy.deepcopy(manual["evaluation"]),
        "evidence_chain_draft": {"note": "validator가 profile evidence로 다시 만든다."},
        "reliability": {"status": "pending_validation"},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_cd")
    parser.add_argument("--check", action="store_true", help="검증만 하고 파일은 바꾸지 않는다")
    args = parser.parse_args()

    job_cd = args.job_cd
    profile = JobProfileLoader(source_root=ROOT / "data/api_raw", output_root=ROOT / "outputs/profiles/v1").build(job_cd, save=False)
    decision_builder = SystemDecisionBuilder()
    validator = MissionValidator()
    assembler = FinalMissionAssembler()
    index_path = ROOT / "missions/index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))

    built = []
    failed = False
    for difficulty, sequence in DIFFICULTIES:
        manual_path = ROOT / f"missions/manual/{job_cd}_{difficulty}.draft.json"
        if not manual_path.exists():
            continue
        manual = json.loads(manual_path.read_text(encoding="utf-8"))
        decisions = decision_builder.build(profile, difficulty)
        draft = build_draft(manual, profile, decisions)
        result = validator.validate(job_profile=profile, system_decisions=decisions, mission_output_draft=draft)
        reliability = result["reliability"]
        print(f"{manual_path.name}: passed={result['passed']} score={reliability['score']} errors={len(result['errors'])} warnings={len(result['warnings'])}")
        for item in result["errors"] + result["warnings"]:
            print(f"  - [{item['severity']}] {item['code']} {item['path']}: {item['message']}")
        if not result["passed"]:
            failed = True
            continue
        final = assembler.assemble(
            mission_output_draft=draft,
            validator_result=result,
            job_cd=job_cd,
            difficulty_code=difficulty,
            repair_count=0,
            sequence=1,
        )
        # 사람이 쓴 미션임을 남긴다(생성 미션과 구분).
        final["reliability"]["authored_by"] = "human"
        built.append((difficulty, sequence, final))

    if failed:
        print("검증에 실패한 초안이 있어 저장하지 않았어.")
        return 1
    if args.check:
        print("검증만 했어(--check).")
        return 0

    job_name = profile["job_identity"]["job_smcl_nm"]
    index["missions"] = [m for m in index["missions"] if m.get("job_cd") != job_cd]
    index["jobs"] = [j for j in index["jobs"] if j.get("job_cd") != job_cd]
    keys = []
    for difficulty, sequence, final in built:
        rel_path = f"scenarios/{job_cd}_{sequence:02d}.json"
        (ROOT / "missions" / rel_path).write_text(json.dumps(final, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        key = f"{KEY_PREFIX}__{final['mission_id']}"
        keys.append(key)
        index["missions"].append({
            "key": key,
            "path": rel_path,
            "mission_id": final["mission_id"],
            "job_cd": job_cd,
            "job_name": job_name,
            "difficulty": difficulty,
            "title": final["mission"]["title"],
            "task_type": final["mission"]["task_type"],
            "estimated_time_minutes": final["mission"]["difficulty"]["estimated_time_minutes"],
            "axis_signals": final["axis_signals_derived"],
        })
    index["jobs"].append({"job_cd": job_cd, "job_name": job_name, "icon": JOB_ICONS.get(job_cd, "💼"), "mission_keys": sorted(keys)})
    index["generated_at"] = date.today().isoformat()
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"저장: {len(built)}개 미션, missions/index.json 갱신")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
