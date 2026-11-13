# 테스트가 로컬 .env와 셸 환경 변수의 영향을 받지 않게 격리한다.

from __future__ import annotations

import contextlib
import os
import tempfile
from pathlib import Path
from unittest import mock

# 미션 생성 설정에 쓰이는 환경 변수. 격리할 때 모두 지우고 시작한다.
GENERATION_ENV_NAMES = [
    "MISSION_LLM_PROVIDER",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_GENERATION_MODEL",
    "ANTHROPIC_GENERATION_EFFORT",
    "ANTHROPIC_GENERATION_FALLBACKS",
    "ANTHROPIC_GENERATION_SPEED",
    "OPENAI_API_KEY",
    "OPENAI_GENERATION_MODEL",
    "OPENAI_GENERATION_APPLY_TEMPERATURE",
]


@contextlib.contextmanager
def isolated_env(dotenv: bytes | None = None, dotenv_local: bytes | None = None, **env: str):
    """빈 임시 폴더를 작업 폴더로 삼고, 생성 관련 환경 변수를 비운 뒤 env만 넣는다.

    dotenv, dotenv_local을 주면 그 폴더에 .env, .env.local로 쓴다. 폴더 경로를 돌려준다.
    """

    previous_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as folder:
        if dotenv is not None:
            (Path(folder) / ".env").write_bytes(dotenv)
        if dotenv_local is not None:
            (Path(folder) / ".env.local").write_bytes(dotenv_local)
        cleaned = {key: value for key, value in os.environ.items() if key not in GENERATION_ENV_NAMES}
        cleaned.update(env)
        with mock.patch.dict(os.environ, cleaned, clear=True):
            os.chdir(folder)
            try:
                yield Path(folder)
            finally:
                os.chdir(previous_cwd)
