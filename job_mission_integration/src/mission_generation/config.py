# 파이프라인 기본 상수, 직무/난이도 기본값, OpenAI runtime 설정을 정의한다.

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


PIPELINE_VERSION = "v1"
SOURCE_ROOT = "data/api_raw"
OUTPUT_ROOT = "outputs"

PILOT_JOBS: list[dict[str, str]] = [
    {"job_cd": "K000000997", "job_name": "상품기획자"},
    {"job_cd": "K000001080", "job_name": "데이터분석가(빅데이터분석가)"},
    {"job_cd": "K000001179", "job_name": "투자분석가"},
    {"job_cd": "K000007519", "job_name": "보험상품개발자"},
]

DIFFICULTIES: list[dict[str, str]] = [
    {"code": "easy", "label": "쉬움"},
    {"code": "normal", "label": "보통"},
    {"code": "hard", "label": "어려움"},
]

# 기본 selector 성공 경로에서는 사용하지 않는다.
# --no-llm-selector 또는 selector가 API 호출 전에 local skip될 때 이전 규칙 경로에서만 참조한다.
PILOT_JOB_CONFIGS: dict[str, dict[str, Any]] = {
    "K000000997": {
        "preferred_exec_job_id": "exec_004",
        "preferred_exec_job_keywords": ["판매수준", "소비자", "평가", "정보", "수집", "분석"],
        "preferred_primary_task_type": "research_and_analysis",
        "materials": {
            "easy": ["memo"],
            "normal": ["chart", "memo"],
            "hard": ["email", "chart", "table"],
        },
    },
    "K000001080": {
        "preferred_exec_job_id": "exec_003",
        "preferred_exec_job_keywords": ["데이터", "처리", "분석", "플랫폼"],
        "preferred_primary_task_type": "research_and_analysis",
        "materials": {
            "easy": ["table"],
            "normal": ["chart", "table"],
            "hard": ["chart", "table", "log"],
        },
    },
    "K000001179": {
        "preferred_exec_job_id": "exec_001",
        "preferred_exec_job_keywords": ["경제상황", "산업", "기업", "정보", "수집", "분석"],
        "preferred_primary_task_type": "research_and_analysis",
        "materials": {
            "easy": ["chart"],
            "normal": ["chart", "table"],
            "hard": ["email", "chart", "table"],
        },
    },
    "K000007519": {
        "preferred_exec_job_id": "exec_002",
        "preferred_exec_job_keywords": ["분석결과", "사회환경", "경제사정", "보험상품", "개발"],
        "preferred_primary_task_type": "planning_and_proposal",
        "materials": {
            "easy": ["table"],
            "normal": ["table", "chart"],
            "hard": ["email", "table", "chart"],
        },
    },
}

TASK_TYPES = {
    "research_and_analysis",
    "planning_and_proposal",
    "decision_making",
    "coordination_and_negotiation",
    "diagnosis_and_improvement",
    "operation_and_scheduling",
    "communication_and_reporting",
}

MATERIAL_TYPES = {"chart", "table", "memo", "email", "schedule", "checklist", "log", "card"}
EXCLUDED_MATERIAL_TYPES = {"image", "screenshot"}


def _env_flag(name: str, default: bool) -> bool:
    """환경변수의 0/false/no/off 값만 명시적 비활성화로 해석한다."""

    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


LLM_PROVIDERS = ("anthropic", "openai")
DEFAULT_LLM_PROVIDER = "anthropic"
DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5"
DEFAULT_REASONING_EFFORT = "medium"


def _read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE 줄만 읽는다. 주석과 빈 줄은 건너뛰고, CRLF·BOM과 값 양끝의 따옴표를 뗀다."""

    values: dict[str, str] = {}
    try:
        raw = path.read_bytes()
    except OSError:
        return values
    # Windows PowerShell 5.1의 `>>`는 UTF-16으로 덧붙인다. 그런 파일에서도 죽지 않고 ASCII 설정 줄을 읽도록
    # 풀 수 없는 바이트는 건너뛰고 UTF-16이 남기는 NUL을 지운다.
    text = raw.decode("utf-8-sig", errors="replace").replace("\x00", "").replace("�", "")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


def local_env_value(name: str, base_dir: str | Path | None = None) -> str | None:
    """설정 값을 셸 환경 변수 → .env.local → .env 순서로 찾는다. 빈 값은 없는 것으로 본다.

    base_dir를 주지 않으면 현재 작업 폴더의 파일을 읽는다. os.environ은 바꾸지 않는다.
    """

    value = os.environ.get(name)
    if value is not None and value.strip():
        return value.strip()
    folder = Path(base_dir) if base_dir is not None else Path.cwd()
    for file_name in (".env.local", ".env"):
        value = _read_env_file(folder / file_name).get(name)
        if value is not None and value.strip():
            return value.strip()
    return None


def _local_env_flag(name: str, default: bool) -> bool:
    """local_env_value로 읽은 값이 0/false/no/off면 끔으로 본다."""

    value = local_env_value(name)
    if value is None:
        return default
    return value.lower() not in {"0", "false", "no", "off"}


def llm_provider() -> str:
    """미션 생성에 쓸 LLM 제공자. MISSION_LLM_PROVIDER가 없으면 Claude(anthropic)다."""

    value = (local_env_value("MISSION_LLM_PROVIDER") or DEFAULT_LLM_PROVIDER).lower()
    if value not in LLM_PROVIDERS:
        raise ValueError(f"MISSION_LLM_PROVIDER must be anthropic or openai, got {value!r}")
    return value


def _generation_speed() -> str | None:
    """ANTHROPIC_GENERATION_SPEED를 읽는다. 비어 있으면 보통 속도(None), fast면 빠른 모드다."""

    value = local_env_value("ANTHROPIC_GENERATION_SPEED")
    if value is None:
        return None
    if value.lower() != "fast":
        raise ValueError(f"ANTHROPIC_GENERATION_SPEED must be fast or empty, got {value!r}")
    return "fast"


def _provider_defaults(provider: str) -> dict[str, Any]:
    """제공자에 딸린 설정의 기본값. 한 설정 안에서 제공자와 key 이름·모델이 어긋나지 않게 한곳에서 정한다."""

    if provider == "anthropic":
        return {
            "api": "messages",
            "model": local_env_value("ANTHROPIC_GENERATION_MODEL") or DEFAULT_ANTHROPIC_MODEL,
            "reasoning_effort": local_env_value("ANTHROPIC_GENERATION_EFFORT") or DEFAULT_REASONING_EFFORT,
            "api_key_env": "ANTHROPIC_API_KEY",
            "fallbacks_enabled": _local_env_flag("ANTHROPIC_GENERATION_FALLBACKS", True),
            "speed": _generation_speed(),
        }
    return {
        "api": "responses",
        "model": os.environ.get("OPENAI_GENERATION_MODEL", "gpt-5.4-nano"),
        "reasoning_effort": DEFAULT_REASONING_EFFORT,
        "api_key_env": "OPENAI_API_KEY",
        "fallbacks_enabled": False,
        "speed": None,
    }


@dataclass(frozen=True)
class RuntimeConfig:
    """LLM 호출과 pilot 실행에 공통으로 쓰는 runtime 설정.

    provider를 주지 않으면 llm_provider()를 따른다. api, model, reasoning_effort, api_key_env, fallbacks_enabled는
    비워 두면 그 provider의 기본값으로 채운다. 그래서 RuntimeConfig(provider="openai")는 기본 제공자가 Claude여도
    OpenAI의 key 이름과 모델을 갖는다(다른 제공자의 key가 섞이지 않게 하려는 것이다).
    """

    provider: str = field(default_factory=llm_provider)
    api: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    draft_temperature: float = 0.8
    repair_temperature: float = 0.4
    max_output_tokens_draft: int = 12000
    max_output_tokens_repair: int = 8000
    # 미션 초안을 쓰는 호출이 120초를 넘길 때가 있다.
    # 재시도까지 두 번 모두 넘기면 생성이 실패하므로 여유를 둔다. 호출마다 걸린 시간은 llm_call_result의 elapsed_ms에 남는다.
    timeout_seconds: int = 240
    max_api_retries: int = 1
    api_key_env: str | None = None
    # 기본은 temperature를 API body에 직접 넣되, 모델이 거부하면 runtime에서 안전하게 재시도한다.
    apply_temperature: bool = field(
        default_factory=lambda: _env_flag("OPENAI_GENERATION_APPLY_TEMPERATURE", True)
    )
    # Claude 전용: 요청이 안전 정책으로 거절되면 다른 Claude 모델이 이어받게 한다. ANTHROPIC_GENERATION_FALLBACKS=false로 끈다.
    fallbacks_enabled: bool | None = None
    # Claude 전용: None이면 보통 속도, "fast"면 빠른 모드(요청에 speed="fast"를 넣는다). ANTHROPIC_GENERATION_SPEED=fast로 켠다.
    speed: str | None = None

    def __post_init__(self) -> None:
        if self.provider not in LLM_PROVIDERS:
            raise ValueError(f"LLM provider must be anthropic or openai, got {self.provider!r}")
        for name, value in _provider_defaults(self.provider).items():
            if getattr(self, name) is None:
                # frozen dataclass라 초기화 단계에서만 이렇게 채운다.
                object.__setattr__(self, name, value)

    def temperature_application(self) -> dict[str, Any]:
        """현재 모델에서 temperature를 실제 API body에 적용할지 기록한다."""

        if self.provider == "anthropic":
            # claude-opus-5-5는 temperature를 받지 않는다. 추론 강도(effort)로만 조절한다.
            return {
                "request_parameter": "omitted",
                "temperature_applied": False,
                "temperature_omitted_reason": "unsupported_by_model",
                "fallback_on_unsupported": False,
            }
        if not self.apply_temperature:
            return {
                "request_parameter": "omitted",
                "temperature_applied": False,
                "temperature_omitted_reason": "disabled_by_env",
                "fallback_on_unsupported": False,
            }
        return {
            "request_parameter": "temperature",
            "temperature_applied": True,
            "temperature_omitted_reason": None,
            "fallback_on_unsupported": True,
        }

    def as_manifest(self) -> dict[str, Any]:
        """run_manifest.json에 남길 안전한 runtime 요약을 반환한다."""

        return {
            "provider": self.provider,
            "api": self.api,
            "model": self.model,
            "reasoning_effort": self.reasoning_effort,
            "speed": self.speed or "standard",
            "draft_temperature": self.draft_temperature,
            "repair_temperature": self.repair_temperature,
            "temperature_application": self.temperature_application(),
        }

    def as_full_config(self) -> dict[str, Any]:
        """pilot_config.json에 저장할 전체 runtime 설정을 반환한다."""

        return {
            "schema_version": "llm_runtime_config.v1",
            "provider": self.provider,
            "api": self.api,
            "model": self.model,
            "reasoning": {"effort": self.reasoning_effort},
            "speed": self.speed or "standard",
            "temperature": {
                "draft_generation": self.draft_temperature,
                "repair_generation": self.repair_temperature,
                "apply_to_api_request": self.apply_temperature,
            },
            "temperature_application": self.temperature_application(),
            "output_mode": "structured_outputs",
            "structured_output": {
                "enabled": True,
                "strict": True,
                "schema_name": "mission_output_v1_draft",
            },
            "tools": {
                "enabled": False,
                "allow_web_search": False,
                "allow_file_search": False,
                "allow_code_interpreter": False,
            },
            "limits": {
                "max_output_tokens": self.max_output_tokens_draft,
                "timeout_ms": self.timeout_seconds * 1000,
            },
            "retry": {
                "max_api_retries": self.max_api_retries,
                "retry_on": ["timeout", "rate_limit", "server_error"],
            },
            "security": {
                "api_key_env": self.api_key_env,
                "key_flow": "secure_encrypted_key_setup",
                "log_prompts": False,
                "log_raw_responses": False,
                "redact_secrets": True,
            },
        }


def default_pilot_config() -> dict[str, Any]:
    """옵션 없이 실행할 때 사용할 기본 직무/난이도/pipeline 설정을 만든다."""

    return {
        "schema_version": "pilot_generation_config.v1",
        "source_root": SOURCE_ROOT,
        "use_kmeans": False,
        "use_llm_decision_selector": True,
        "use_practice_sheet_background": True,
        "jobs": PILOT_JOBS,
        "difficulties": DIFFICULTIES,
        "max_repair_attempts": 1,
    }
