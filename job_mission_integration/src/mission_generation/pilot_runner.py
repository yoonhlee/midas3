# 직무 profile 로드부터 LLM 생성, 검증, 저장까지 pilot run 전체를 실행한다.

from __future__ import annotations

import argparse
import copy
import json
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .basis_card_exporter import BasisCardExporter
from .basis_source_pack import SourcePackBuilder, pieces_by_id, writer_job_profile
from .blueprint_checker import BlueprintChecker, MissionBasisChecker
from .blueprint_designer import (
    TWO_STAGE_ESTIMATED_MINUTES,
    TWO_STAGE_HARD_ANSWER_LENGTH,
    TWO_STAGE_MATERIAL_TYPES,
    BlueprintDesigner,
    BlueprintPromptBuilder,
    blueprint_mission_design,
)
from .config import PILOT_JOB_CONFIGS, RuntimeConfig, default_pilot_config
from .decision_selector import DecisionSelectorInputBuilder, DecisionSelectorValidator, MissionDecisionSelector
from .draft_generator import LLMInputPackageBuilder, MissionDraftGenerator
from .final_assembler import FinalMissionAssembler
from .generation_basis import GenerationBasisAssembler
from .mission_seed_builder import MissionSeedBuilder
from .ncs_background_loader import NcsBackgroundLoader
from .practice_profile_loader import PracticeProfileLoader
from .practice_sheet_background_loader import PracticeSheetBackgroundLoader
from .progress_reporter import ConsoleProgressReporter
from .profile_loader import JobProfileLoader, ProfileLoadError
from .repair_manager import RepairManager, RepairPromptBuilder
from .schema_constraints_builder import SchemaConstraintsBuilder
from .storage import StorageAdapter
from .system_decision_builder import SystemDecisionBuilder
from .utils import iso_now, normalize_text
from .validator import MissionValidator


class DecisionSelectionError(RuntimeError):
    """LLM selector가 실제 후보를 벗어나 기본 생성을 진행할 수 없을 때의 오류."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "DECISION_SELECTOR_FAILED",
        errors: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.errors = errors or []


class BlueprintFailedError(RuntimeError):
    """두 단계 생성에서 설계서를 얻지 못했을 때의 오류(호출 실패, 또는 검사에서 두 번 걸림)."""

    def __init__(self, message: str, *, code: str, errors: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.errors = errors or []


# 문장 단위 대상에 쓸 수 있는 난이도. 실행 순서도 이 순서다.
NCS_TARGET_DIFFICULTIES = ("easy", "normal", "hard")
NCS_TARGET_KEYS = ("job_cd", "exec_job_id", "unit_key", "difficulty")


def normalize_ncs_targets(targets: Any) -> list[dict[str, str]]:
    """문장 단위 대상 목록을 검사하고 네 칸(직업, 하는 일 문장, 능력단위, 난이도)만 남긴다.

    목록이거나 {"targets": [...]} 모양(배치표 파일)을 받는다. 항목에 다른 칸(문장 원문, 이유 등)이 있어도 된다.
    산출물 폴더와 미션 번호가 직업·난이도로 정해지므로, 한 실행에서 같은 직업·난이도는 한 번만 나올 수 있다.
    """

    if isinstance(targets, dict):
        targets = targets.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ValueError("ncs targets must be a non-empty list of {job_cd, exec_job_id, unit_key, difficulty}")
    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for position, item in enumerate(targets):
        if not isinstance(item, dict):
            raise ValueError(f"ncs target #{position} is not an object")
        target = {key: str(item.get(key) or "").strip() for key in NCS_TARGET_KEYS}
        missing = [key for key, value in target.items() if not value]
        if missing:
            raise ValueError(f"ncs target #{position} is missing {', '.join(missing)}")
        if target["difficulty"] not in NCS_TARGET_DIFFICULTIES:
            raise ValueError(f"ncs target #{position} has unknown difficulty {target['difficulty']!r}")
        if ":" not in target["unit_key"]:
            raise ValueError(f"ncs target #{position} unit_key must be DUTY:UNIT, got {target['unit_key']!r}")
        slot = (target["job_cd"], target["difficulty"])
        if slot in seen:
            raise ValueError(f"ncs targets list {target['job_cd']} {target['difficulty']} more than once")
        seen.add(slot)
        # 자료 형태 배정(material_planner)이 붙은 대상만 그 기록을 함께 남긴다. 없으면 네 칸 그대로다.
        if item.get("material_mix") is not None:
            target["material_mix"] = _checked_material_mix(item["material_mix"], position)
        normalized.append(target)
    return normalized


def _checked_material_mix(mix: Any, position: int) -> dict[str, Any]:
    """대상에 붙은 자료 형태 배정을 검사한다. 쓸 수 있는 형태는 두 단계 생성의 일곱 형태 안에서, 비어 있지 않아야 한다."""

    allowed = mix.get("allowed_material_types") if isinstance(mix, dict) else None
    if not isinstance(allowed, list) or not allowed:
        raise ValueError(f"ncs target #{position} material_mix needs a non-empty allowed_material_types list")
    unknown = [kind for kind in allowed if kind not in TWO_STAGE_MATERIAL_TYPES]
    if unknown:
        raise ValueError(f"ncs target #{position} material_mix has unknown material type(s): {', '.join(map(str, unknown))}")
    if len(set(allowed)) != len(allowed):
        raise ValueError(f"ncs target #{position} material_mix lists a material type more than once")
    return copy.deepcopy(mix)


class PilotRunner:
    """profile 로드부터 LLM 생성, validator, 저장까지 한 target run을 순서대로 실행한다."""

    def __init__(
        self,
        *,
        source_root: str | Path = "data/api_raw",
        output_root: str | Path = "outputs",
        force_mock: bool = False,
        allow_mock_fallback: bool = False,
        concurrency: int = 2,
        target_job_codes: list[str] | None = None,
        target_difficulty_codes: list[str] | None = None,
        use_llm_decision_selector: bool = True,
        use_practice_sheet_background: bool = True,
        practice_sheet_root: str | Path = "data/additional_search",
        use_ncs_background: bool = False,
        ncs_root: str | Path = "data/ncs/jobs",
        ncs_units: dict[str, str] | None = None,
        ncs_trace: bool = False,
        ncs_ablation: bool = False,
        two_stage_basis: bool = False,
        progress_enabled: bool = False,
        ncs_targets: list[dict[str, Any]] | None = None,
    ) -> None:
        self.source_root = Path(source_root)
        self.output_root = Path(output_root)
        self.force_mock = force_mock
        self.allow_mock_fallback = allow_mock_fallback
        self.concurrency = max(1, int(concurrency))
        self.target_job_codes = list(target_job_codes) if target_job_codes is not None else None
        self.target_difficulty_codes = list(target_difficulty_codes) if target_difficulty_codes is not None else None
        self.use_llm_decision_selector = bool(use_llm_decision_selector)
        self.use_practice_sheet_background = bool(use_practice_sheet_background)
        self.use_ncs_background = bool(use_ncs_background)
        # 실험 옵션(NCS 모드에서만): 직업별 능력단위 지정, 사용 근거 기록, NCS 자료를 뺀 비교 조건.
        self.ncs_units = dict(ncs_units or {})
        self.ncs_trace = bool(ncs_trace)
        self.ncs_ablation = bool(ncs_ablation)
        if (self.ncs_units or self.ncs_trace or self.ncs_ablation) and not self.use_ncs_background:
            raise ValueError("--ncs-unit, --ncs-trace, --ncs-ablation require --ncs-background")
        # 문장 단위 대상 지정: (직업, 하는 일 문장, 능력단위, 난이도)의 목록. 주면 실행할 직업과 난이도를 이 목록이 정한다.
        # 직업당 능력단위 하나인 --ncs-unit과 달리, 한 직업의 난이도마다 다른 문장·능력단위를 쓸 수 있다.
        self.ncs_targets = normalize_ncs_targets(ncs_targets) if ncs_targets is not None else []
        self._ncs_target_by_slot = {(item["job_cd"], item["difficulty"]): item for item in self.ncs_targets}
        if ncs_targets is not None:
            if not self.use_ncs_background:
                raise ValueError("--ncs-targets requires --ncs-background")
            if self.ncs_units or self.target_job_codes is not None or self.target_difficulty_codes is not None:
                raise ValueError("--ncs-targets cannot be combined with --jobs, --difficulties, or --ncs-unit")
            self.target_job_codes = list(dict.fromkeys(item["job_cd"] for item in self.ncs_targets))
            used = {item["difficulty"] for item in self.ncs_targets}
            self.target_difficulty_codes = [code for code in NCS_TARGET_DIFFICULTIES if code in used]
        # 두 단계 생성: 설계서를 먼저 만들고 검사한 뒤, 설계서가 가리킨 원문만 보고 미션을 쓴다. 근거 기록을 함께 남긴다.
        self.two_stage_basis = bool(two_stage_basis)
        if self.two_stage_basis and not self.use_ncs_background:
            raise ValueError("--two-stage-basis requires --ncs-background")
        if self.two_stage_basis and (self.ncs_trace or self.ncs_ablation):
            raise ValueError("--two-stage-basis cannot be combined with --ncs-trace or --ncs-ablation")
        # 자료 형태 배정은 두 단계 생성의 허용 형태를 좁힌다. 다른 경로의 허용 형태(난이도별 기본값)는 건드리지 않는다.
        if any("material_mix" in item for item in self.ncs_targets) and not self.two_stage_basis:
            raise ValueError("material_mix in --ncs-targets requires --two-stage-basis")
        self.progress = ConsoleProgressReporter(enabled=progress_enabled)
        self._progress_total_targets = 0
        self._progress_positions: dict[tuple[str, str], int] = {}
        # 생성기마다 설정된 제공자(Claude API 또는 GPT)의 호출부를 스스로 만든다.
        self.runtime_config = RuntimeConfig()
        self.profile_loader = JobProfileLoader(source_root=self.source_root, output_root=self.output_root / "profiles" / "v1")
        self.practice_profile_loader = PracticeProfileLoader()
        self.practice_sheet_background_loader = PracticeSheetBackgroundLoader(root=practice_sheet_root)
        self.ncs_background_loader = NcsBackgroundLoader(root=ncs_root)
        self.seed_builder = MissionSeedBuilder()
        self.decision_builder = SystemDecisionBuilder()
        self.selector_input_builder = DecisionSelectorInputBuilder()
        self.decision_selector = MissionDecisionSelector(force_mock=force_mock)
        self.selector_validator = DecisionSelectorValidator()
        self.constraints_builder = SchemaConstraintsBuilder()
        self.input_builder = LLMInputPackageBuilder()
        self.draft_generator = MissionDraftGenerator(
            allow_mock_without_key=allow_mock_fallback,
            force_mock=force_mock,
        )
        self.repair_manager = RepairManager(
            allow_mock_without_key=allow_mock_fallback,
            force_mock=force_mock,
        )
        self.validator = MissionValidator()
        self.assembler = FinalMissionAssembler()
        self.source_pack_builder = SourcePackBuilder(source_root=self.source_root)
        self.blueprint_designer = BlueprintDesigner(
            allow_mock_without_key=allow_mock_fallback,
            force_mock=force_mock,
        )
        self.blueprint_checker = BlueprintChecker()
        self.mission_basis_checker = MissionBasisChecker()
        self.basis_assembler = GenerationBasisAssembler()
        self.storage = StorageAdapter(output_root=self.output_root)

    def run(self) -> dict[str, Any]:
        """설정된 직무/난이도 target 전체를 실행하고 pilot_summary를 반환한다."""

        started_at = iso_now()
        started_monotonic = time.monotonic()
        pilot_config = self._pilot_config()
        pilot_config["source_root"] = self.source_root.as_posix()
        pilot_config["concurrency"] = self.concurrency
        pilot_config["force_mock"] = self.force_mock
        pilot_config["allow_mock_fallback"] = self.allow_mock_fallback
        pilot_config["use_llm_decision_selector"] = self.use_llm_decision_selector
        pilot_config["use_practice_sheet_background"] = self.use_practice_sheet_background
        pilot_config["use_ncs_background"] = self.use_ncs_background
        if self.ncs_units or self.ncs_trace or self.ncs_ablation:
            pilot_config["ncs_experiment"] = {"units": self.ncs_units, "trace": self.ncs_trace, "ablation": self.ncs_ablation}
        if self.ncs_targets:
            pilot_config["ncs_targets"] = [dict(item) for item in self.ncs_targets]
        if self.two_stage_basis:
            pilot_config["two_stage_basis"] = True
        run_dir = self.storage.create_run(self.runtime_config, pilot_config)
        self._prepare_progress(pilot_config)
        self.progress.run_started(
            run_id=self.storage.run_id,
            total_targets=self._progress_total_targets,
            concurrency=self.concurrency,
        )
        results_by_order: dict[int, dict[str, Any]] = {}
        usage = self._empty_usage()
        targets: list[tuple[int, dict[str, Any], dict[str, str], dict[str, str]]] = []
        target_order = 0

        for job in pilot_config["jobs"]:
            job_cd = job["job_cd"]
            try:
                self.progress.emit(f"{job_cd} - profile loading")
                profile = self.profile_loader.build(job_cd, save=False)
                self.storage.save_canonical_profile(profile)
                self.storage.save_profile_snapshot(profile)
                self.progress.emit(f"{job_cd} - profile loaded")
            except ProfileLoadError as exc:
                self.progress.emit(f"{job_cd} - profile failed ({exc.errors[0]['code'] if exc.errors else 'PROFILE_FAILED'})")
                for difficulty in self._job_difficulties(job_cd, pilot_config):
                    results_by_order[target_order] = self._save_failed_status(
                        job_cd=job_cd,
                        job_name=job["job_name"],
                        difficulty=difficulty,
                        status="profile_failed",
                        reason_code=exc.errors[0]["code"] if exc.errors else "PROFILE_FAILED",
                        error={"errors": exc.errors},
                        results=None,
                    )
                    target_order += 1
                continue

            for difficulty in self._job_difficulties(job_cd, pilot_config):
                targets.append((target_order, profile, job, difficulty))
                target_order += 1

        if self.concurrency <= 1:
            for order, profile, job, difficulty in targets:
                try:
                    output = self._run_one_with_usage(profile, job, difficulty)
                except Exception as exc:
                    output = {
                        "result": self._save_failed_status(
                            job_cd=job["job_cd"],
                            job_name=job["job_name"],
                            difficulty=difficulty,
                            status="runner_failed",
                            reason_code="RUNNER_FAILED",
                            error={"message": str(exc)},
                            results=None,
                        ),
                        "usage": self._empty_usage(),
                    }
                results_by_order[order] = output["result"]
                self._merge_usage(usage, output["usage"])
        else:
            with ThreadPoolExecutor(max_workers=self.concurrency) as executor:
                future_targets = {
                    executor.submit(self._run_one_with_usage, profile, job, difficulty): (order, job, difficulty)
                    for order, profile, job, difficulty in targets
                }
                for future in as_completed(future_targets):
                    order, job, difficulty = future_targets[future]
                    try:
                        output = future.result()
                    except Exception as exc:
                        output = {
                            "result": self._save_failed_status(
                                job_cd=job["job_cd"],
                                job_name=job["job_name"],
                                difficulty=difficulty,
                                status="runner_failed",
                                reason_code="RUNNER_FAILED",
                                error={"message": str(exc)},
                                results=None,
                            ),
                            "usage": self._empty_usage(),
                        }
                    results_by_order[order] = output["result"]
                    self._merge_usage(usage, output["usage"])

        results = [results_by_order[idx] for idx in sorted(results_by_order)]
        self.storage.flush_indexes()
        finished_at = iso_now()
        duration_seconds = round(time.monotonic() - started_monotonic, 3)
        summary = self._summary(
            results,
            usage,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration_seconds,
        )
        if self.two_stage_basis:
            # 근거 기록이 있는 미션마다 사람이 읽는 근거 카드(HTML)를 만든다.
            try:
                cards = BasisCardExporter().export(run_dir)
                summary["basis_cards"] = [path.relative_to(run_dir).as_posix() for path in cards]
            except Exception as exc:
                # 카드는 보기용이다. 만들다 실패해도 미션과 실행 요약은 남긴다.
                summary["basis_cards"] = []
                summary["basis_cards_error"] = f"{type(exc).__name__}: {exc}"
        self.storage.save_pilot_summary(summary)
        self.storage.write_human_review_templates(results)
        json_failures = self.storage.validate_json_outputs()
        secret_findings = self.storage.security_scan()
        summary["post_run_checks"] = {
            "json_parse_failures": json_failures,
            "secret_findings": secret_findings,
        }
        self.storage.save_pilot_summary(summary)
        summary["run_dir"] = run_dir.as_posix()
        self.progress.run_finished(
            saved_count=summary["saved_count"],
            failed_count=summary["failed_count"],
            repair_used_count=summary["repair_used_count"],
        )
        return summary

    def _prepare_progress(self, pilot_config: dict[str, Any]) -> None:
        """콘솔 진행 메시지에 표시할 target 순번과 전체 개수를 준비한다."""

        self._progress_positions = {}
        order = 1
        for job in pilot_config["jobs"]:
            for difficulty in self._job_difficulties(job["job_cd"], pilot_config):
                self._progress_positions[(job["job_cd"], difficulty["code"])] = order
                order += 1
        self._progress_total_targets = max(0, order - 1)

    def _job_difficulties(self, job_cd: str, pilot_config: dict[str, Any]) -> list[dict[str, str]]:
        """이 직업에서 실행할 난이도. 문장 단위 대상 목록이 있으면 그 목록에 적힌 난이도만이다."""

        if not self.ncs_targets:
            return pilot_config["difficulties"]
        return [item for item in pilot_config["difficulties"] if (job_cd, item["code"]) in self._ncs_target_by_slot]

    def _pilot_config(self) -> dict[str, Any]:
        """기본 pilot 설정에 CLI/API로 지정한 직무와 난이도 필터를 반영한다."""

        base = default_pilot_config()
        pilot_config = {
            **base,
            "jobs": [dict(item) for item in base["jobs"]],
            "difficulties": [dict(item) for item in base["difficulties"]],
        }
        if self.target_job_codes is not None:
            requested = self._dedupe_codes(self.target_job_codes, "target_job_codes")
            known = {item["job_cd"]: item for item in pilot_config["jobs"]}
            jobs: list[dict[str, str]] = []
            unknown: list[str] = []
            for code in requested:
                if code in known:
                    jobs.append(dict(known[code]))
                    continue
                raw_api_job = self._job_from_raw_api(code)
                if raw_api_job is None:
                    unknown.append(code)
                else:
                    jobs.append(raw_api_job)
            if unknown:
                raise ValueError(
                    "Unknown job code(s): "
                    + ", ".join(unknown)
                    + ". Available job codes: "
                    + ", ".join(known)
                    + " or any job code under "
                    + self.source_root.as_posix()
                )
            pilot_config["jobs"] = jobs

        if self.target_difficulty_codes is not None:
            requested = self._dedupe_codes(self.target_difficulty_codes, "target_difficulty_codes")
            known = {item["code"]: item for item in pilot_config["difficulties"]}
            unknown = [code for code in requested if code not in known]
            if unknown:
                raise ValueError(
                    "Unknown difficulty code(s): "
                    + ", ".join(unknown)
                    + ". Available difficulty codes: "
                    + ", ".join(known)
                )
            pilot_config["difficulties"] = [dict(known[code]) for code in requested]

        return pilot_config

    def _dedupe_codes(self, values: list[str], label: str) -> list[str]:
        """CLI/API로 받은 코드 목록에서 공백과 중복을 제거한다."""

        codes = [value.strip() for value in values if isinstance(value, str) and value.strip()]
        if not codes:
            raise ValueError(f"{label} must include at least one code.")
        return list(dict.fromkeys(codes))

    def _job_from_raw_api(self, job_cd: str) -> dict[str, str] | None:
        """기본 pilot 목록에 없는 직무라도 data/api_raw 폴더가 있으면 실행 대상으로 만든다."""

        job_dir = self.source_root / job_cd
        if not job_dir.is_dir():
            return None
        job_name = job_cd
        path = job_dir / "dtlGb_2.xml"
        if path.exists():
            try:
                job_name = normalize_text(ET.parse(path).getroot().findtext("jobSmclNm")) or job_cd
            except ET.ParseError:
                job_name = job_cd
        return {"job_cd": job_cd, "job_name": job_name}

    def _run_one(
        self,
        profile: dict[str, Any],
        job: dict[str, str],
        difficulty: dict[str, str],
        usage: dict[str, int],
    ) -> dict[str, Any]:
        """직무/난이도 하나에 대해 decision, draft, validation, save 단계를 실행한다."""

        job_cd = job["job_cd"]
        difficulty_code = difficulty["code"]
        artifacts: dict[str, str] = {}
        repair_count = 0
        two_stage: dict[str, Any] | None = None
        self._progress_target(job_cd, difficulty_code, "target started")

        try:
            # selector/이전 규칙 단계가 끝나야만 draft LLM 입력을 만들 수 있다.
            # 실제 selector 검증 실패는 여기서 decision_failed로 멈추고 fallback하지 않는다.
            # decision_config는 selector 성공 시 쓰이지 않고, 이전 규칙 경로에만 전달된다.
            decision_config = PILOT_JOB_CONFIGS.get(job_cd, {})
            self._progress_target(job_cd, difficulty_code, "decisions started")
            ncs_unit_key = self.ncs_units.get(job_cd)
            # 문장 단위 대상이면 능력단위와 함께 하는 일 문장도 정해져 있다.
            ncs_exec_job_id: str | None = None
            slot_target = self._ncs_target_by_slot.get((job_cd, difficulty_code))
            if slot_target is not None:
                ncs_unit_key, ncs_exec_job_id = slot_target["unit_key"], slot_target["exec_job_id"]
            ncs_background = (
                self.ncs_background_loader.load(job_cd, difficulty_code, unit_key=ncs_unit_key, exec_job_id=ncs_exec_job_id)
                if self.use_ncs_background
                else None
            )
            if self.two_stage_basis and ncs_background is None:
                # 두 단계 생성은 능력단위가 있어야 한다. 조사시트 경로로 조용히 넘어가지 않는다.
                where = f"unit_key={ncs_unit_key}" + (f", exec_job_id={ncs_exec_job_id}" if ncs_exec_job_id else "")
                raise DecisionSelectionError(
                    f"NCS unit for {job_cd} was not found ({where}).",
                    code="NCS_UNIT_MISSING",
                    errors=[{"code": "NCS_UNIT_MISSING", "message": where}],
                )
            # 프롬프트에 실제로 넣을 NCS 배경. 비교 조건(--ncs-ablation)에서는 하는 일 문장만 쓰고 NCS 자료는 뺀다.
            prompt_ncs_background = None
            ncs_withheld = None
            if ncs_background is not None:
                # NCS가 고른 하는 일 문장을 수행직무로 고정하고, 설계 의도는 능력단위에서 가져온다.
                # selector와 pilot 설정의 수행직무·task type 고정은 쓰지 않는다.
                self._progress_target(job_cd, difficulty_code, "ncs background", ncs_background["exec_job_id"])
                decisions = self.decision_builder.build(
                    profile,
                    difficulty_code,
                    {"preferred_exec_job_id": ncs_background["exec_job_id"]},
                )
                decisions["difficulty"].update(NcsBackgroundLoader.difficulty_overrides(difficulty_code))
                if self.ncs_ablation:
                    decisions["mission_design"] = NcsBackgroundLoader.know_only_design(decisions["selected_exec_job"]["text"])
                    ncs_withheld = ncs_background
                else:
                    decisions["mission_design"] = NcsBackgroundLoader.mission_design(ncs_background)
                    prompt_ncs_background = ncs_background
                decisions["decision_trace"].append(
                    {
                        "step": "select_mission_design_type",
                        "method": "know_only_ablation" if self.ncs_ablation else "ncs_background",
                        "selected": decisions["mission_design"]["mission_design_type"],
                        "reason": decisions["mission_design"]["selection_reason"],
                    }
                )
            else:
                if self.use_ncs_background:
                    self._progress_target(job_cd, difficulty_code, "ncs background", "missing")
                decisions = self._build_system_decisions(
                    profile=profile,
                    job_cd=job_cd,
                    difficulty_code=difficulty_code,
                    decision_config=decision_config,
                    usage=usage,
                    artifacts=artifacts,
                )
            self._progress_target(
                job_cd,
                difficulty_code,
                "decisions ready",
                f"exec={decisions['selected_exec_job']['exec_job_id']} task={decisions['primary_task_type']}",
            )
            evidence_names = self._evidence_names(profile)
            if self.ncs_trace and prompt_ncs_background is not None:
                constraints = self.constraints_builder.build(evidence_names=evidence_names, include_ncs_basis=True)
            else:
                constraints = self.constraints_builder.build(evidence_names=evidence_names)
            practice_profile = None
            practice_sheet_background = None
            # 기본 경로는 Markdown 조사시트만 배경지식으로 쓰고, 이전 mission_seed 입력은 만들지 않는다.
            # NCS 배경이 있으면 조사시트 대신 그것만 쓴다(자료 효과를 따로 보려는 실험 경로).
            if ncs_background is not None:
                mission_seed = None
                practice_excerpt = None
            elif self.use_practice_sheet_background:
                mission_seed = None
                practice_excerpt = None
                practice_sheet_background = self.practice_sheet_background_loader.load(job_cd)
                detail = "loaded" if practice_sheet_background is not None else "missing"
                self._progress_target(job_cd, difficulty_code, "practice sheet background", detail)
            else:
                practice_profile = self.practice_profile_loader.load(job_cd)
                mission_seed = self.seed_builder.build(
                    job_profile=profile,
                    practice_profile=practice_profile,
                    system_decisions=decisions,
                )
                practice_excerpt = (
                    self.seed_builder.excerpt(practice_profile, mission_seed)
                    if practice_profile is not None and mission_seed is not None
                    else None
                )
                self._progress_target(job_cd, difficulty_code, "mission seed ready")
            if self.two_stage_basis:
                # 설계서를 만들고 검사한 뒤, 설계서와 설계서가 가리킨 원문만 담은 입력 꾸러미를 쓴다.
                two_stage = self._prepare_two_stage(
                    profile=profile,
                    job_cd=job_cd,
                    difficulty_code=difficulty_code,
                    decisions=decisions,
                    ncs_unit_key=ncs_unit_key,
                    ncs_exec_job_id=ncs_exec_job_id,
                    usage=usage,
                    artifacts=artifacts,
                    material_mix=(slot_target or {}).get("material_mix"),
                )
                constraints = two_stage["constraints"]
                llm_input = two_stage["llm_input"]
            else:
                llm_input = self.input_builder.build(
                    profile,
                    decisions,
                    constraints,
                    job_practice_profile_excerpt=practice_excerpt,
                    mission_seed=mission_seed,
                    job_practice_sheet_background=practice_sheet_background,
                    job_ncs_background=prompt_ncs_background,
                )
            self.storage.save_job_artifact(job_cd, difficulty_code, "system_decisions.json", decisions)
            self.storage.save_job_artifact(job_cd, difficulty_code, "schema_constraints.json", constraints)
            self.storage.save_job_artifact(job_cd, difficulty_code, "llm_input_package.json", llm_input)
            artifacts.update(
                {
                    "system_decisions": "system_decisions.json",
                    "schema_constraints": "schema_constraints.json",
                    "llm_input_package": "llm_input_package.json",
                }
            )
            if practice_profile is not None and mission_seed is not None:
                self.storage.save_job_artifact(job_cd, difficulty_code, "job_practice_profile.json", practice_profile)
                self.storage.save_job_artifact(job_cd, difficulty_code, "mission_seed.json", mission_seed)
                artifacts.update(
                    {
                        "job_practice_profile": "job_practice_profile.json",
                        "mission_seed": "mission_seed.json",
                    }
                )
            if practice_sheet_background is not None:
                self.storage.save_job_artifact(job_cd, difficulty_code, "job_practice_sheet_background.json", practice_sheet_background)
                artifacts["job_practice_sheet_background"] = "job_practice_sheet_background.json"
            if prompt_ncs_background is not None:
                self.storage.save_job_artifact(job_cd, difficulty_code, "job_ncs_background.json", prompt_ncs_background)
                artifacts["job_ncs_background"] = "job_ncs_background.json"
            if ncs_withheld is not None:
                # 비교 조건: 프롬프트에서 뺀 NCS 자료를 기록만 해 둔다.
                self.storage.save_job_artifact(job_cd, difficulty_code, "ncs_ablation_withheld.json", ncs_withheld)
                artifacts["ncs_ablation_withheld"] = "ncs_ablation_withheld.json"
        except DecisionSelectionError as exc:
            self._progress_target(job_cd, difficulty_code, "decision failed", exc.code)
            return self._save_failed_status(
                job_cd=job_cd,
                job_name=job["job_name"],
                difficulty=difficulty,
                status="decision_failed",
                reason_code=exc.code,
                error={"message": str(exc), "errors": exc.errors},
                results=None,
                artifacts=artifacts,
            )
        except BlueprintFailedError as exc:
            self._progress_target(job_cd, difficulty_code, "blueprint failed", exc.code)
            return self._save_failed_status(
                job_cd=job_cd,
                job_name=job["job_name"],
                difficulty=difficulty,
                status="blueprint_failed",
                reason_code=exc.code,
                error={"message": str(exc), "errors": exc.errors},
                results=None,
                artifacts=artifacts,
            )
        except Exception as exc:
            self._progress_target(job_cd, difficulty_code, "decision failed", "DECISION_FAILED")
            return self._save_failed_status(
                job_cd=job_cd,
                job_name=job["job_name"],
                difficulty=difficulty,
                status="decision_failed",
                reason_code="DECISION_FAILED",
                error={"message": str(exc)},
                results=None,
                artifacts=artifacts,
            )

        self._progress_target(job_cd, difficulty_code, "draft LLM started")
        generated = self.draft_generator.generate(llm_input)
        call_result = generated["llm_call_result"]
        draft = generated["mission_draft"]
        self._progress_target(job_cd, difficulty_code, "draft LLM finished", str(call_result.get("status") or "unknown"))
        self._collect_usage(call_result, usage)
        if call_result["provider"] == "mock":
            usage["mock_draft_count"] += 1
        elif call_result["status"] == "completed":
            usage["draft_call_count"] += 1
        self.storage.save_job_artifact(job_cd, difficulty_code, "llm_call_result_attempt_0.json", call_result)
        artifacts["llm_call_result_attempt_0"] = "llm_call_result_attempt_0.json"
        if draft is None:
            self._progress_target(job_cd, difficulty_code, "llm failed")
            return self._save_failed_status(
                job_cd=job_cd,
                job_name=job["job_name"],
                difficulty=difficulty,
                status="llm_failed",
                reason_code=(call_result.get("errors") or [{"code": "LLM_FAILED"}])[0]["code"],
                error={"errors": call_result.get("errors", [])},
                results=None,
            )

        self.storage.save_job_artifact(job_cd, difficulty_code, "mission_draft_attempt_0.json", draft)
        writer_call = call_result
        draft_with_map = draft
        basis_map: dict[str, Any] | None = None
        basis_check: dict[str, Any] | None = None
        if two_stage is not None:
            # basis_map은 미션 파일에 넣지 않는다. 떼어 낸 초안만 검증기와 조립기에 넘긴다.
            draft, basis_map = self._split_basis_map(draft_with_map)
        validation = self.validator.validate(
            job_profile=profile,
            system_decisions=decisions,
            mission_output_draft=draft,
            attempt=0,
        )
        if two_stage is not None:
            basis_check = self._check_mission_basis(job_cd, difficulty_code, draft, basis_map, two_stage["blueprint"], 0, artifacts, decisions["difficulty"])
            validation = self._merge_basis_check(validation, basis_check, 0)
        self._progress_target(job_cd, difficulty_code, "validator attempt 0", validation["status"])
        validator_path = self.storage.save_job_artifact(job_cd, difficulty_code, "validator_result_attempt_0.json", validation)
        artifacts.update(
            {
                "mission_draft_attempt_0": "mission_draft_attempt_0.json",
                "validator_result_attempt_0": "validator_result_attempt_0.json",
            }
        )

        # 첫 검증에서 고칠 수 있는 오류가 나오면 validator 결과를 repair 요청에 그대로 넘긴다.
        if validation["status"] == "repair_required":
            self._progress_target(job_cd, difficulty_code, "repair LLM started")
            if two_stage is not None:
                # basis_map까지 고칠 수 있게 떼어 내기 전의 초안과 설계서가 고른 KNOW 항목 이름을 넘긴다.
                # 수정 호출도 설계서와 설계서가 가리킨 원문을 보고 고치게 한다.
                repair_request = RepairPromptBuilder().build(
                    decisions,
                    draft_with_map,
                    validation,
                    two_stage["evidence_names"],
                    mission_blueprint=two_stage["blueprint"],
                    cited_sources=two_stage["llm_input"].get("cited_sources", []),
                )
            else:
                repair_request = RepairPromptBuilder().build(decisions, draft, validation, self._evidence_names(profile))
            self.storage.save_job_artifact(job_cd, difficulty_code, "repair_request_attempt_1.json", repair_request)
            repaired = self.repair_manager.repair(
                repair_request=repair_request,
                json_schema=constraints["structured_output_schema"],
            )
            repair_call = repaired["llm_call_result"]
            draft = repaired["mission_draft"]
            repair_count = 1
            self._progress_target(job_cd, difficulty_code, "repair LLM finished", str(repair_call.get("status") or "unknown"))
            self._collect_usage(repair_call, usage)
            if repair_call["provider"] == "mock":
                usage["mock_repair_count"] += 1
            elif repair_call["status"] == "completed":
                usage["repair_call_count"] += 1
            self.storage.save_job_artifact(job_cd, difficulty_code, "llm_call_result_attempt_1.json", repair_call)
            self.storage.save_job_artifact(job_cd, difficulty_code, "mission_draft_attempt_1.json", draft)
            writer_call = repair_call
            if two_stage is not None:
                draft_with_map = draft
                draft, basis_map = self._split_basis_map(draft_with_map)
            validation = self.validator.validate(
                job_profile=profile,
                system_decisions=decisions,
                mission_output_draft=draft,
                attempt=1,
            )
            if two_stage is not None:
                basis_check = self._check_mission_basis(job_cd, difficulty_code, draft, basis_map, two_stage["blueprint"], 1, artifacts, decisions["difficulty"])
                validation = self._merge_basis_check(validation, basis_check, 1)
            self._progress_target(job_cd, difficulty_code, "validator attempt 1", validation["status"])
            validator_path = self.storage.save_job_artifact(job_cd, difficulty_code, "validator_result_attempt_1.json", validation)
            artifacts.update(
                {
                    "repair_request_attempt_1": "repair_request_attempt_1.json",
                    "llm_call_result_attempt_1": "llm_call_result_attempt_1.json",
                    "mission_draft_attempt_1": "mission_draft_attempt_1.json",
                    "validator_result_attempt_1": "validator_result_attempt_1.json",
                }
            )

        # 최종 저장은 validator가 pass를 준 draft만 대상으로 한다.
        if validation["status"] == "pass":
            final_output = self.assembler.assemble(
                mission_output_draft=draft,
                validator_result=validation,
                job_cd=job_cd,
                difficulty_code=difficulty_code,
                repair_count=repair_count,
            )
            if self.ncs_trace and prompt_ncs_background is not None:
                final_output["ncs_basis"] = self._ncs_basis_record(
                    final_output.get("ncs_basis"),
                    prompt_ncs_background,
                    self.ncs_background_loader.trace_ref(job_cd, difficulty_code, unit_key=ncs_unit_key, exec_job_id=ncs_exec_job_id),
                )
            mission_path = self.storage.save_job_artifact(job_cd, difficulty_code, "mission_output.json", final_output)
            artifacts["mission_output"] = "mission_output.json"
            if two_stage is not None:
                blueprint_file = f"mission_blueprint_attempt_{two_stage['blueprint_attempt']}.json"
                generation_basis = self.basis_assembler.assemble(
                    final_mission=final_output,
                    source_pack=two_stage["source_pack"],
                    blueprint=two_stage["blueprint"],
                    blueprint_check=two_stage["blueprint_check"],
                    basis_map=basis_map,
                    basis_check=basis_check or {},
                    system_decisions=decisions,
                    blueprint_call=two_stage["blueprint_call"],
                    writer_call=writer_call,
                    artifacts={
                        "source_pack": "source_pack.json",
                        "blueprint": blueprint_file,
                        "mission": "mission_output.json",
                        **({"material_mix": "material_mix.json"} if two_stage.get("material_mix") is not None else {}),
                    },
                    blueprint_attempt=two_stage["blueprint_attempt"],
                    repair_count=repair_count,
                    material_mix=two_stage.get("material_mix"),
                )
                self.storage.save_job_artifact(job_cd, difficulty_code, "generation_basis.json", generation_basis)
                artifacts["generation_basis"] = "generation_basis.json"
            status_path = self.storage.save_run_status(
                job_cd=job_cd,
                job_name=profile["job_identity"].get("job_smcl_nm") or job["job_name"],
                difficulty=difficulty,
                status="saved",
                repair_count=repair_count,
                reliability_score=final_output["reliability"]["score"],
                warning_count=final_output["reliability"]["warning_count"],
                fail_count=final_output["reliability"]["fail_count"],
                artifacts=artifacts,
                error=None,
            )
            result = {
                "job_cd": job_cd,
                "job_name": profile["job_identity"].get("job_smcl_nm") or job["job_name"],
                "difficulty_code": difficulty_code,
                "status": "saved",
                "mission_id": final_output["mission_id"],
                "reliability_score": final_output["reliability"]["score"],
                "warning_count": final_output["reliability"]["warning_count"],
                "repair_count": repair_count,
                "mission_output_path": self.storage.relative_to_run(mission_path),
            }
            self.storage.record_artifact_item(
                job_cd=job_cd,
                difficulty_code=difficulty_code,
                status="saved",
                mission_output_path=self.storage.relative_to_run(mission_path),
                validator_result_path=self.storage.relative_to_run(validator_path),
                run_status_path=self.storage.relative_to_run(status_path) or "",
                flush=False,
            )
            self._progress_target(
                job_cd,
                difficulty_code,
                "saved",
                f"reliability={final_output['reliability']['score']} repair={repair_count}",
            )
            return result

        # pass하지 못한 target도 run_status와 failure_index에 남겨 나중에 원인을 추적할 수 있게 한다.
        status = "discarded" if validation["status"] == "discard" else "repair_failed"
        self._progress_target(job_cd, difficulty_code, status, (validation["errors"] or [{"code": "VALIDATOR_FAILED"}])[0]["code"])
        status_path = self.storage.save_run_status(
            job_cd=job_cd,
            job_name=profile["job_identity"].get("job_smcl_nm") or job["job_name"],
            difficulty=difficulty,
            status=status,
            repair_count=repair_count,
            reliability_score=validation["reliability"]["score"],
            warning_count=validation["reliability"]["warning_count"],
            fail_count=validation["reliability"]["fail_count"],
            artifacts=artifacts,
            error={"errors": validation["errors"], "warnings": validation["warnings"]},
        )
        self.storage.record_artifact_item(
            job_cd=job_cd,
            difficulty_code=difficulty_code,
            status=status,
            mission_output_path=None,
            validator_result_path=self.storage.relative_to_run(validator_path),
            run_status_path=self.storage.relative_to_run(status_path) or "",
            flush=False,
        )
        self.storage.record_failure(
            job_cd=job_cd,
            difficulty_code=difficulty_code,
            status=status,
            reason_code=(validation["errors"] or [{"code": "VALIDATOR_FAILED"}])[0]["code"],
            run_status_path=self.storage.relative_to_run(status_path) or "",
            validator_result_path=self.storage.relative_to_run(validator_path),
            flush=False,
        )
        return {
            "job_cd": job_cd,
            "job_name": profile["job_identity"].get("job_smcl_nm") or job["job_name"],
            "difficulty_code": difficulty_code,
            "status": status,
            "mission_id": None,
            "reliability_score": validation["reliability"]["score"],
            "warning_count": validation["reliability"]["warning_count"],
            "repair_count": repair_count,
            "mission_output_path": None,
        }

    @staticmethod
    def _ncs_basis_record(
        llm_basis: dict[str, Any] | None,
        background: dict[str, Any],
        source: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """LLM이 적은 사용 근거에 출처(능력단위 코드·버전·하는 일 문장)와 원문 대조 결과를 붙인다(실험)."""

        def squash(text: str | None) -> str:
            return re.sub(r"\s+", "", text or "")

        all_criteria = [
            (element.get("name"), criterion)
            for element in background.get("elements", [])
            for criterion in element.get("performance_criteria", [])
        ]
        # NCS 원문에 같은 문장이 두 요소에 들어 있는 경우가 있어(예: 원가분석의 환율 반영) 대조용으로만 합친다.
        source_items = {squash(criterion): (name, criterion) for name, criterion in all_criteria}
        basis = copy.deepcopy(llm_basis) if isinstance(llm_basis, dict) else {}
        checked = []
        for item in basis.get("performance_criteria") or []:
            hit = source_items.get(squash(item.get("text")))
            record = {**item, "found_in_source": hit is not None}
            if hit is not None:
                record["source_element_name"] = hit[0]
            checked.append(record)
        return {
            "recorded_by": "llm" if basis else "missing",
            "unit_name": basis.get("unit_name"),
            "performance_criteria": checked,
            "how_used": basis.get("how_used"),
            "source": source,
            "source_criteria_count": len(all_criteria),
        }

    def _prepare_two_stage(
        self,
        *,
        profile: dict[str, Any],
        job_cd: str,
        difficulty_code: str,
        decisions: dict[str, Any],
        ncs_unit_key: str | None,
        usage: dict[str, int],
        artifacts: dict[str, str],
        ncs_exec_job_id: str | None = None,
        material_mix: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """두 단계 생성의 앞 단계: 근거 자료 묶음 → 설계서(한 번까지 다시 쓰기) → 설계서 검사 → 미션 작성 입력.

        material_mix(자료 형태 배정)를 주면 허용 형태를 그 배정으로 좁히고 배정 기록을 material_mix.json으로 남긴다.
        설계서를 얻지 못하면 BlueprintFailedError를 낸다. 이때 미션 작성 호출은 하지 않는다.
        """

        record = self.ncs_background_loader.unit_record(job_cd, difficulty_code, unit_key=ncs_unit_key, exec_job_id=ncs_exec_job_id)
        if record is None:
            raise DecisionSelectionError(f"NCS unit for {job_cd} was not found.", code="NCS_UNIT_MISSING")
        if material_mix is not None:
            # 자료 형태 배정: 한 직업의 세 미션이 서로 다른 형태를 쓰도록 코드(material_planner)가 대상마다 좁힌 형태만 연다.
            # 왜 그렇게 정했는지(걸린 낱말과 조각)는 material_mix.json과 근거 기록에 남는다.
            allowed = list(material_mix["allowed_material_types"])
            decisions["allowed_material_types"] = allowed
            decisions["decision_trace"].append(
                {
                    "step": "select_allowed_material_types",
                    "method": "material_mix",
                    "selected": allowed,
                    "reason": (
                        f"Assigned per job by the material-mix rule ({material_mix.get('rule_version')}) so the missions of this job "
                        "use different material types; the blueprint picks each type from the cited documents within this list."
                    ),
                }
            )
            self.storage.save_job_artifact(job_cd, difficulty_code, "material_mix.json", material_mix)
            artifacts["material_mix"] = "material_mix.json"
        else:
            # 두 단계 생성에서는 자료 형태 일곱 가지를 연다(카드 제외). 형태는 설계서가 인용한 서류를 보고 고른다.
            # 두 단계가 아닌 경로의 허용 형태(난이도별 기본값)는 건드리지 않는다.
            decisions["allowed_material_types"] = list(TWO_STAGE_MATERIAL_TYPES)
            decisions["decision_trace"].append(
                {
                    "step": "select_allowed_material_types",
                    "method": "two_stage_types",
                    "selected": list(TWO_STAGE_MATERIAL_TYPES),
                    "reason": "Two-stage generation opens every material type except card; the blueprint picks each type from the cited documents.",
                }
            )
        if difficulty_code == "hard":
            # 어려움은 과제 하나에 판정 여럿과 근거를 쓰게 되어 2~4문장으로는 모자랐다. 두 단계 생성에서만 3~5문장으로 늘린다.
            decisions["difficulty"]["answer_length_hint"] = TWO_STAGE_HARD_ANSWER_LENGTH
        # 보통의 분량은 난이도 기본값(2-3)을 그대로 쓴다. blueprint-v10의 3-4 덮어쓰기는 v11에서 뺐다.
        if difficulty_code in TWO_STAGE_ESTIMATED_MINUTES:
            # 예상 시간: 쉬움 10분, 보통 15분, 어려움 20분. 두 단계가 아닌 경로의 시간은 그대로다.
            decisions["difficulty"]["estimated_time_minutes"] = TWO_STAGE_ESTIMATED_MINUTES[difficulty_code]
        exec_job_id = decisions["selected_exec_job"]["exec_job_id"]
        source_pack = self.source_pack_builder.build(
            job_profile=profile,
            ncs_job=record["ncs_job"],
            unit=record["unit"],
            exec_job_id=exec_job_id,
        )
        self.storage.save_job_artifact(job_cd, difficulty_code, "source_pack.json", source_pack)
        request = BlueprintPromptBuilder().request(
            source_pack=source_pack,
            system_decisions=decisions,
            job_name=profile["job_identity"].get("job_smcl_nm") or "",
        )
        self.storage.save_job_artifact(job_cd, difficulty_code, "blueprint_request.json", request)
        artifacts.update({"source_pack": "source_pack.json", "blueprint_request": "blueprint_request.json"})

        blueprint: dict[str, Any] | None = None
        blueprint_check: dict[str, Any] = {}
        blueprint_call: dict[str, Any] = {}
        check_errors: list[dict[str, Any]] | None = None
        attempt = 0
        for attempt in (0, 1):
            self._progress_target(job_cd, difficulty_code, "blueprint LLM started", f"attempt {attempt}")
            if check_errors:
                designed = self.blueprint_designer.design(request, check_errors=check_errors, previous=blueprint)
            else:
                designed = self.blueprint_designer.design(request)
            blueprint_call = designed["llm_call_result"]
            blueprint = designed["mission_blueprint"]
            self._collect_usage(blueprint_call, usage)
            if blueprint_call.get("provider") == "mock":
                usage["mock_blueprint_count"] += 1
            elif blueprint_call.get("status") == "completed":
                usage["blueprint_call_count"] += 1
            call_file = f"llm_call_result_blueprint_{attempt}.json"
            self.storage.save_job_artifact(job_cd, difficulty_code, call_file, blueprint_call)
            artifacts[f"llm_call_result_blueprint_{attempt}"] = call_file
            if blueprint is None:
                call_errors = blueprint_call.get("errors") or [
                    {"code": "BLUEPRINT_LLM_FAILED", "message": "Blueprint call returned no output."}
                ]
                raise BlueprintFailedError(
                    "Blueprint call failed.",
                    code=call_errors[0].get("code") or "BLUEPRINT_LLM_FAILED",
                    errors=call_errors,
                )
            blueprint_file = f"mission_blueprint_attempt_{attempt}.json"
            check_file = f"blueprint_check_attempt_{attempt}.json"
            self.storage.save_job_artifact(job_cd, difficulty_code, blueprint_file, blueprint)
            blueprint_check = self.blueprint_checker.check(
                blueprint=blueprint,
                source_pack=source_pack,
                system_decisions=decisions,
                attempt=attempt,
            )
            self.storage.save_job_artifact(job_cd, difficulty_code, check_file, blueprint_check)
            artifacts[f"mission_blueprint_attempt_{attempt}"] = blueprint_file
            artifacts[f"blueprint_check_attempt_{attempt}"] = check_file
            self._progress_target(
                job_cd, difficulty_code, f"blueprint check {attempt}", "pass" if blueprint_check["passed"] else "errors"
            )
            if blueprint_check["passed"]:
                break
            check_errors = blueprint_check["errors"]
        else:
            raise BlueprintFailedError(
                "Blueprint check failed twice.",
                code=blueprint_check["errors"][0]["code"],
                errors=blueprint_check["errors"],
            )

        decisions["mission_design"] = blueprint_mission_design(blueprint, attempt)
        decisions["decision_trace"].append(
            {
                "step": "select_mission_design_type",
                "method": "blueprint_two_stage",
                "selected": decisions["mission_design"]["mission_design_type"],
                "reason": decisions["mission_design"]["selection_reason"],
            }
        )

        pieces = pieces_by_id(source_pack)
        # 설계서가 고른 KNOW 항목만 미션의 자료와 채점 기준에 연결할 수 있게 허용값을 좁힌다.
        evidence_names: list[str] = []
        for basis in blueprint.get("evaluation_basis", []):
            for ref in basis.get("know_refs", []):
                name = pieces.get(ref, {}).get("text")
                if name and name not in evidence_names:
                    evidence_names.append(name)
        constraints = self.constraints_builder.build(evidence_names=evidence_names, include_basis_map=True)

        # 미션 작성 단계에는 설계서가 가리킨 조각과 기본 맥락(대상 문장, 능력단위 정의)만 준다.
        cited_ids: list[Any] = [source_pack["target_exec_ref"], "N.unit"]
        cited_ids += [item.get("ref") for item in blueprint.get("criteria", [])]
        for material in blueprint.get("materials", []):
            cited_ids += list(material.get("refs", []))
            cited_ids += [term.get("ref") for term in material.get("borrowed_terms", [])]
        for task in blueprint.get("tasks", []):
            cited_ids += list(task.get("refs", []))
        for basis in blueprint.get("evaluation_basis", []):
            cited_ids += list(basis.get("refs", [])) + list(basis.get("know_refs", []))
        cited_ids += [term.get("ref") for term in blueprint.get("glossary_terms", [])]
        cited_sources: list[dict[str, Any]] = []
        for piece_id in cited_ids:
            piece = pieces.get(piece_id)
            if piece is not None and all(item["id"] != piece_id for item in cited_sources):
                cited_sources.append(
                    {"id": piece["id"], "kind": piece["kind"], "text": piece["text"], "meta": piece.get("meta", {})}
                )

        llm_input = self.input_builder.build(
            writer_job_profile(profile, exec_job_id, evidence_names),
            decisions,
            constraints,
            mission_blueprint=blueprint,
            cited_sources=cited_sources,
        )
        return {
            "source_pack": source_pack,
            "blueprint": blueprint,
            "blueprint_attempt": attempt,
            "blueprint_check": blueprint_check,
            "blueprint_call": blueprint_call,
            "constraints": constraints,
            "llm_input": llm_input,
            "evidence_names": evidence_names,
            "material_mix": material_mix,
        }

    def _check_mission_basis(
        self,
        job_cd: str,
        difficulty_code: str,
        draft: dict[str, Any] | None,
        basis_map: dict[str, Any] | None,
        blueprint: dict[str, Any],
        attempt: int,
        artifacts: dict[str, str],
        difficulty: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """쓰인 미션이 설계서를 따랐는지 검사하고 결과를 저장한다. difficulty는 시스템 결정의 난이도(분량·예상 시간 검사에 쓴다)."""

        basis_check = self.mission_basis_checker.check(
            mission_draft=draft,
            basis_map=basis_map,
            blueprint=blueprint,
            attempt=attempt,
            difficulty=difficulty,
        )
        file_name = f"mission_basis_check_attempt_{attempt}.json"
        self.storage.save_job_artifact(job_cd, difficulty_code, file_name, basis_check)
        artifacts[f"mission_basis_check_attempt_{attempt}"] = file_name
        return basis_check

    @staticmethod
    def _split_basis_map(draft: dict[str, Any] | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """초안에서 basis_map을 떼어 (나머지 초안, basis_map)으로 돌려준다. 원본은 바꾸지 않는다."""

        if not isinstance(draft, dict):
            return draft, None
        stripped = {key: value for key, value in draft.items() if key != "basis_map"}
        basis_map = draft.get("basis_map")
        return stripped, basis_map if isinstance(basis_map, dict) else None

    @staticmethod
    def _merge_basis_check(validation: dict[str, Any], basis_check: dict[str, Any], attempt: int) -> dict[str, Any]:
        """미션 뒤 검사의 오류를 검증 결과에 합친다. 오류가 있으면 첫 시도는 수정 요청, 그 뒤는 폐기다."""

        errors = basis_check.get("errors") or []
        if not errors:
            return validation
        merged = copy.deepcopy(validation)
        merged["errors"] = list(merged.get("errors") or []) + copy.deepcopy(errors)
        status = "repair_required" if attempt == 0 else "discard"
        merged["status"] = status
        merged["passed"] = False
        merged["repairable"] = status == "repair_required"
        merged["discarded"] = status == "discard"
        reliability = dict(merged.get("reliability") or {})
        reliability["fail_count"] = len(merged["errors"])
        merged["reliability"] = reliability
        return merged

    def _save_failed_status(
        self,
        *,
        job_cd: str,
        job_name: str,
        difficulty: dict[str, str],
        status: str,
        reason_code: str,
        error: dict[str, Any],
        results: list[dict[str, Any]] | None,
        artifacts: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """profile/decision/LLM 단계에서 중단된 target의 실패 산출물과 index를 저장한다."""

        status_path = self.storage.save_run_status(
            job_cd=job_cd,
            job_name=job_name,
            difficulty=difficulty,
            status=status,
            repair_count=0,
            reliability_score=None,
            warning_count=0,
            fail_count=1,
            artifacts=artifacts or {},
            error=error,
        )
        self.storage.record_artifact_item(
            job_cd=job_cd,
            difficulty_code=difficulty["code"],
            status=status,
            mission_output_path=None,
            validator_result_path=None,
            run_status_path=self.storage.relative_to_run(status_path) or "",
            flush=False,
        )
        self.storage.record_failure(
            job_cd=job_cd,
            difficulty_code=difficulty["code"],
            status=status,
            reason_code=reason_code,
            run_status_path=self.storage.relative_to_run(status_path) or "",
            flush=False,
        )
        result = {
            "job_cd": job_cd,
            "job_name": job_name,
            "difficulty_code": difficulty["code"],
            "status": status,
            "mission_id": None,
            "reliability_score": None,
            "warning_count": 0,
            "repair_count": 0,
            "mission_output_path": None,
        }
        if results is not None:
            results.append(result)
        return result

    def _run_one_with_usage(
        self,
        profile: dict[str, Any],
        job: dict[str, str],
        difficulty: dict[str, str],
    ) -> dict[str, Any]:
        """병렬 실행 시 target 결과와 해당 target의 usage를 함께 반환한다."""

        usage = self._empty_usage()
        result = self._run_one(profile, job, difficulty, usage)
        return {"result": result, "usage": usage}

    def _build_system_decisions(
        self,
        *,
        profile: dict[str, Any],
        job_cd: str,
        difficulty_code: str,
        decision_config: dict[str, Any],
        usage: dict[str, int],
        artifacts: dict[str, str],
    ) -> dict[str, Any]:
        """기본 selector 경로 또는 --no-llm-selector 규칙 경로로 system_decisions를 만든다."""

        if not self.use_llm_decision_selector:
            self._progress_target(job_cd, difficulty_code, "selector disabled", "이전 규칙 사용")
            return self.decision_builder.build(profile, difficulty_code, decision_config)

        # selector는 미션 본문이 아니라 system_decisions 후보만 고른다.
        # 검증을 통과한 selector 결과만 이후 draft 생성 단계로 넘어간다.
        selector_input = self.selector_input_builder.build(profile, difficulty_code)
        self.storage.save_job_artifact(job_cd, difficulty_code, "decision_selector_input.json", selector_input)
        artifacts["decision_selector_input"] = "decision_selector_input.json"

        self._progress_target(job_cd, difficulty_code, "selector started")
        selector_run = self.decision_selector.select(selector_input)
        call_result = selector_run["llm_call_result"]
        selector_result = selector_run.get("selector_result")
        self._collect_usage(call_result, usage)
        if call_result.get("status") == "completed" and call_result.get("provider") != "local":
            usage["selector_call_count"] += 1
        self.storage.save_job_artifact(job_cd, difficulty_code, "decision_selector_call_result.json", call_result)
        self.storage.save_job_artifact(job_cd, difficulty_code, "decision_selector_result.json", selector_result)
        artifacts.update(
            {
                "decision_selector_call_result": "decision_selector_call_result.json",
                "decision_selector_result": "decision_selector_result.json",
            }
        )

        validation = self.selector_validator.validate(selector_input, selector_result, job_profile=profile)
        self.storage.save_job_artifact(job_cd, difficulty_code, "decision_selector_validation.json", validation)
        artifacts["decision_selector_validation"] = "decision_selector_validation.json"
        if validation["status"] == "passed":
            self._progress_target(job_cd, difficulty_code, "selector passed")
            return self.decision_builder.build_from_selector(profile, difficulty_code, selector_result)

        if self._selector_was_locally_skipped(call_result):
            usage["selector_fallback_count"] += 1
            self._progress_target(job_cd, difficulty_code, "selector skipped", "이전 규칙 사용")
            return self.decision_builder.build(profile, difficulty_code, decision_config)

        usage["selector_failed_count"] += 1
        errors = validation.get("errors", [])
        codes = ", ".join(error.get("code", "UNKNOWN") for error in errors) or "UNKNOWN"
        self._progress_target(job_cd, difficulty_code, "selector failed", codes)
        raise DecisionSelectionError(
            f"Decision selector validation failed: {codes}",
            errors=errors,
        )

    def _progress_target(
        self,
        job_cd: str,
        difficulty_code: str,
        stage: str,
        detail: str | None = None,
    ) -> None:
        """직무/난이도 기준으로 현재 target의 진행 메시지를 출력한다."""

        current = self._progress_positions.get((job_cd, difficulty_code))
        total = self._progress_total_targets or None
        self.progress.target(
            current=current,
            total=total,
            job_cd=job_cd,
            difficulty_code=difficulty_code,
            stage=stage,
            detail=detail,
        )

    def _selector_was_locally_skipped(self, call_result: dict[str, Any]) -> bool:
        """selector 호출 전 skip된 경우만 의사결정 후보를 이전 규칙으로 대체한다.

        이 fallback은 draft/repair mock 생성 허용 여부와 별개이며, 최종 미션 본문은
        allow_mock_fallback 또는 force_mock이 켜져 있지 않으면 실제 LLM이 필요하다.
        """

        if call_result.get("provider") != "local" or call_result.get("status") != "skipped":
            return False
        codes = {
            error.get("code")
            for error in call_result.get("errors", [])
            if isinstance(error, dict)
        }
        return bool(codes & {"DECISION_SELECTOR_MOCK_MODE", "OPENAI_API_KEY_MISSING", "LLM_API_KEY_MISSING"})

    def _empty_usage(self) -> dict[str, int]:
        """run/target 단위 LLM usage 누적값의 초기 구조를 만든다."""

        usage = {
            "selector_call_count": 0,
            "selector_fallback_count": 0,
            "selector_failed_count": 0,
            "draft_call_count": 0,
            "repair_call_count": 0,
            "mock_draft_count": 0,
            "mock_repair_count": 0,
            "blueprint_call_count": 0,
            "mock_blueprint_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "total_tokens": 0,
        }
        return usage

    def _merge_usage(self, total: dict[str, int], delta: dict[str, int]) -> None:
        """target별 usage를 run 전체 usage에 더한다."""

        for key in total:
            total[key] += int(delta.get(key) or 0)

    def _collect_usage(self, call_result: dict[str, Any], usage: dict[str, int]) -> None:
        """LLM call_result 안의 token usage를 누적 dict에 반영한다."""

        call_usage = call_result.get("usage") or {}
        for key in ("input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"):
            usage[key] += int(call_usage.get(key) or 0)

    def _evidence_names(self, profile: dict[str, Any]) -> list[str]:
        """schema/repair에 넘길 profile evidence 이름을 중복 없이 수집한다."""

        names: list[str] = []
        for group in profile.get("evidence", {}).values():
            for item in group:
                name = item.get("name") if isinstance(item, dict) else None
                if isinstance(name, str) and name and name not in names:
                    names.append(name)
        return names

    def _summary(
        self,
        results: list[dict[str, Any]],
        usage: dict[str, int],
        *,
        started_at: str,
        finished_at: str,
        duration_seconds: float,
    ) -> dict[str, Any]:
        """target 결과와 LLM usage를 run 단위 pilot_summary 구조로 집계한다."""

        saved = [item for item in results if item["status"] == "saved"]
        failed = [item for item in results if item["status"] != "saved"]
        scores = [item["reliability_score"] for item in saved if item.get("reliability_score") is not None]
        summary = {
            "schema_version": "pilot_summary.v1",
            "run_id": self.storage.run_id,
            "created_at": iso_now(),
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": duration_seconds,
            "concurrency": self.concurrency,
            "total_targets": len(results),
            "saved_count": len(saved),
            "failed_count": len(failed),
            "repair_used_count": sum(1 for item in results if item["repair_count"] > 0),
            "average_reliability_score": round(sum(scores) / len(scores), 2) if scores else None,
            "llm_usage": usage,
            "openai_api_called": usage["selector_call_count"] + usage["draft_call_count"] + usage["repair_call_count"] > 0,
            "results": results,
        }
        return summary


def main() -> None:
    """CLI에서 pilot runner를 실행하는 진입점."""

    parser = argparse.ArgumentParser(description="미션 생성 v1 pilot을 실행합니다.")
    parser.add_argument("--source-root", default="data/api_raw")
    parser.add_argument("--output-root", default="outputs")
    parser.add_argument("--mock", action="store_true", help="Force local mock generation even when OPENAI_API_KEY is set.")
    parser.add_argument(
        "--allow-mock-fallback",
        action="store_true",
        help="Use local mock generation only when OPENAI_API_KEY is missing. Default is to fail instead.",
    )
    parser.add_argument("--concurrency", type=int, default=2, help="직무/난이도 target을 동시에 실행할 개수입니다.")
    parser.add_argument("--jobs", type=_parse_codes, default=None, help="실행할 직무 코드를 쉼표로 구분해 입력합니다. 예: K000000997,K000001080")
    parser.add_argument("--difficulties", type=_parse_codes, default=None, help="실행할 난이도 코드를 쉼표로 구분해 입력합니다. 예: normal")
    parser.add_argument("--no-llm-selector", action="store_true", help="LLM decision selector를 끄고 이전 규칙 기반 system_decisions를 사용합니다.")
    parser.add_argument("--quiet", action="store_true", help="콘솔 진행 메시지를 출력하지 않습니다.")
    parser.add_argument(
        "--practice-sheet-background",
        dest="use_practice_sheet_background",
        action="store_true",
        help="mission_seed 대신 data/additional_search/{job_cd}.md 직무조사시트를 배경지식으로 사용합니다. 기본값입니다.",
    )
    parser.add_argument(
        "--mission-seed",
        dest="use_practice_sheet_background",
        action="store_false",
        help="직무조사시트 배경지식 대신 이전 mission_seed 흐름을 사용합니다.",
    )
    parser.set_defaults(use_practice_sheet_background=True)
    parser.add_argument("--practice-sheet-root", default="data/additional_search", help="{job_cd}.md 직무조사시트 파일이 있는 폴더 경로입니다.")
    parser.add_argument(
        "--ncs-background",
        action="store_true",
        help="scripts/fetch_ncs.py가 고른 NCS 능력단위로 수행직무와 설계 의도를 정하고 조사시트 대신 배경으로 씁니다. selector는 쓰지 않습니다.",
    )
    parser.add_argument("--ncs-root", default="data/ncs/jobs", help="{job_cd}.json NCS 자료가 있는 폴더 경로입니다.")
    parser.add_argument(
        "--ncs-unit",
        type=_parse_ncs_units,
        default=None,
        help="(실험) 직업별 NCS 능력단위 키입니다. 예: K000000918=02040302:10,K000001093=12030101:03",
    )
    parser.add_argument("--ncs-trace", action="store_true", help="(실험) NCS 모드 미션에 실제로 쓴 수행준거(ncs_basis)를 남깁니다.")
    parser.add_argument(
        "--ncs-ablation",
        action="store_true",
        help="(실험) 같은 하는 일 문장과 난이도 규칙으로 만들되 NCS 자료는 프롬프트에서 뺍니다(NCS 비교 시험).",
    )
    parser.add_argument(
        "--two-stage-basis",
        action="store_true",
        help="설계서를 먼저 만들고 검사한 뒤 설계서가 가리킨 원문만 보고 미션을 씁니다. 근거 기록(generation_basis.json)을 남깁니다. --ncs-background와 함께 씁니다.",
    )
    parser.add_argument(
        "--ncs-targets",
        type=_parse_ncs_targets_file,
        default=None,
        help="문장 단위 대상 목록(JSON 파일)입니다. 항목마다 job_cd, exec_job_id, unit_key, difficulty를 적습니다. "
        "목록이거나 {\"targets\": [...]} 모양이면 됩니다(src.mission_generation.target_planner가 만드는 배치표). "
        "실행할 직업과 난이도를 이 목록이 정하므로 --jobs, --difficulties, --ncs-unit과 함께 쓰지 않습니다.",
    )
    args = parser.parse_args()
    runner = PilotRunner(
        source_root=args.source_root,
        output_root=args.output_root,
        force_mock=args.mock,
        allow_mock_fallback=args.allow_mock_fallback,
        concurrency=args.concurrency,
        target_job_codes=args.jobs,
        target_difficulty_codes=args.difficulties,
        use_llm_decision_selector=not args.no_llm_selector,
        use_practice_sheet_background=args.use_practice_sheet_background,
        practice_sheet_root=args.practice_sheet_root,
        use_ncs_background=args.ncs_background,
        ncs_root=args.ncs_root,
        ncs_units=args.ncs_unit,
        ncs_trace=args.ncs_trace,
        ncs_ablation=args.ncs_ablation,
        two_stage_basis=args.two_stage_basis,
        progress_enabled=not args.quiet,
        ncs_targets=args.ncs_targets,
    )
    try:
        summary = runner.run()
    except ValueError as exc:
        parser.error(str(exc))
    print(summary["run_dir"])
    print(f"saved={summary['saved_count']} failed={summary['failed_count']} openai_api_called={summary['openai_api_called']}")


def _parse_ncs_targets_file(value: str) -> list[dict[str, str]]:
    """문장 단위 대상 목록 파일을 읽어 검사한다."""

    try:
        data = json.loads(Path(value).read_text(encoding="utf-8-sig"))
        return normalize_ncs_targets(data)
    except (OSError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"{value}: {exc}") from exc


def _parse_ncs_units(value: str) -> dict[str, str]:
    """'직업코드=직무코드:능력단위코드'를 쉼표로 이은 값을 {직업코드: 능력단위 키}로 바꾼다."""

    units: dict[str, str] = {}
    for part in (p.strip() for p in value.split(",") if p.strip()):
        job_cd, sep, unit_key = part.partition("=")
        if not sep or not job_cd.strip() or ":" not in unit_key:
            raise argparse.ArgumentTypeError(f"expected JOB=DUTY:UNIT, got {part!r}")
        units[job_cd.strip()] = unit_key.strip()
    if not units:
        raise argparse.ArgumentTypeError("must include at least one JOB=DUTY:UNIT")
    return units


def _parse_codes(value: str) -> list[str]:
    """쉼표로 구분된 CLI 코드 목록을 공백 제거된 리스트로 변환한다."""

    codes = [part.strip() for part in value.split(",") if part.strip()]
    if not codes:
        raise argparse.ArgumentTypeError("must include at least one comma-separated code")
    return codes


if __name__ == "__main__":
    main()
