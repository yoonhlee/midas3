# 생성 시작 전 확인(preflight): 패키지, 키, 모델 조회를 API 없이 확인한다.

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from basis_fixtures import PROJECT_ROOT
from envutil import GENERATION_ENV_NAMES, isolated_env
from test_llm_runtime import (
    FAKE_SDK,
    FakeAPIConnectionError,
    FakeAPIStatusError,
    FakeAuthenticationError,
    FakeMessages,
    FakePermissionDeniedError,
)

from src.mission_generation import preflight
from src.mission_generation.config import RuntimeConfig
from src.mission_generation.preflight import PREFLIGHT_SCHEMA, check_generation_ready, main

SECRET = "sk-test-secret"


class FakeNotFoundError(FakeAPIStatusError):
    pass


class FakeModels:
    def __init__(self, calls: list, outcome=None) -> None:
        self.calls, self.outcome = calls, outcome

    def retrieve(self, model_id: str):
        self.calls.append(("models.retrieve", model_id))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return SimpleNamespace(id=model_id)


class FakeClient:
    """models.retrieve 호출을 기록한다. messages.create가 불리면 같은 목록에 남는다."""

    def __init__(self, outcome=None) -> None:
        self.calls: list = []
        self.models = FakeModels(self.calls, outcome)
        self.messages = FakeMessages("plain", [], self.calls)
        self.beta = SimpleNamespace(messages=FakeMessages("beta", [], self.calls))


def fake_sdk(client: FakeClient | None = None, created: list | None = None) -> SimpleNamespace:
    """가짜 패키지. Anthropic(...)으로 클라이언트를 만들면 받은 인자를 created에 적는다."""

    def make_client(**kwargs):
        if created is not None:
            created.append(kwargs)
        return client or FakeClient()

    return SimpleNamespace(**vars(FAKE_SDK), NotFoundError=FakeNotFoundError, Anthropic=make_client)


def run_main() -> tuple[int, str]:
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        code = main([])
    return code, printed.getvalue()


class CheckGenerationReadyTest(unittest.TestCase):
    def test_missing_package_stops_at_the_first_check(self):
        with isolated_env(ANTHROPIC_API_KEY=SECRET):
            with mock.patch.object(preflight, "_import_sdk", side_effect=ImportError("No module named 'anthropic'")):
                result = check_generation_ready()
        self.assertEqual([c["name"] for c in result["checks"]], ["package"])
        self.assertEqual(result["checks"][0]["code"], "ANTHROPIC_SDK_MISSING")
        self.assertFalse(result["ok"])

    def test_missing_key_stops_at_the_second_check(self):
        client = FakeClient()
        with isolated_env():
            result = check_generation_ready(sdk=fake_sdk(), client=client)
        self.assertEqual([(c["name"], c["ok"]) for c in result["checks"]], [("package", True), ("api_key", False)])
        self.assertEqual(result["checks"][-1]["code"], "LLM_API_KEY_MISSING")
        self.assertEqual(result["checks"][-1]["message"], "ANTHROPIC_API_KEY is not set.")
        self.assertFalse(result["ok"])
        self.assertEqual(client.calls, [])

    def test_model_found_is_ok_and_makes_no_message_call(self):
        client = FakeClient()
        with isolated_env(ANTHROPIC_API_KEY=SECRET):
            result = check_generation_ready(sdk=fake_sdk(), client=client)
        self.assertTrue(result["ok"])
        self.assertEqual(client.calls, [("models.retrieve", "claude-opus-5-5")])
        self.assertEqual(
            [(c["name"], c["ok"], c["code"], c["message"]) for c in result["checks"]],
            [("package", True, None, ""), ("api_key", True, None, ""), ("model", True, None, "")],
        )
        self.assertEqual(
            (result["schema_version"], result["provider"], result["model"], result["reasoning_effort"], result["speed"]),
            ("generation_preflight.v1", "anthropic", "claude-opus-5-5", "medium", "standard"),
        )

    def test_unknown_model_auth_failure_and_network_failure_have_their_own_codes(self):
        cases = [
            (FakeNotFoundError(404, "model: claude-nope"), "ANTHROPIC_MODEL_NOT_FOUND"),
            (FakeAuthenticationError(401, "invalid x-api-key"), "ANTHROPIC_AUTH_FAILED"),
            (FakePermissionDeniedError(403, "forbidden"), "ANTHROPIC_AUTH_FAILED"),
            (FakeAPIConnectionError("Connection error."), "ANTHROPIC_PREFLIGHT_FAILED"),
            (FakeAPIStatusError(500, "overloaded"), "ANTHROPIC_PREFLIGHT_FAILED"),
        ]
        for outcome, code in cases:
            with self.subTest(code=code, error=type(outcome).__name__):
                with isolated_env(ANTHROPIC_API_KEY=SECRET):
                    result = check_generation_ready(sdk=fake_sdk(), client=FakeClient(outcome))
                self.assertFalse(result["ok"])
                self.assertEqual([(c["name"], c["ok"]) for c in result["checks"]], [("package", True), ("api_key", True), ("model", False)])
                self.assertEqual(result["checks"][-1]["code"], code)
                self.assertTrue(result["checks"][-1]["message"])

    def test_config_of_another_provider_is_refused(self):
        # 다른 제공자의 설정을 받으면 그 제공자의 key가 Claude 쪽으로 나갈 수 있다.
        with isolated_env(OPENAI_API_KEY="openai-key-not-real"):
            with self.assertRaisesRegex(ValueError, "anthropic"):
                check_generation_ready(RuntimeConfig(provider="openai"), sdk=fake_sdk(), client=FakeClient())


class PreflightMainTest(unittest.TestCase):
    def test_key_never_appears_in_the_output(self):
        # 패키지의 오류 글에 key가 그대로 들어 있어도 출력에는 나오지 않는다.
        client = FakeClient(FakeAuthenticationError(401, f"invalid x-api-key: {SECRET}"))
        created: list = []
        with isolated_env(ANTHROPIC_API_KEY=SECRET):
            with mock.patch.object(preflight, "_import_sdk", return_value=fake_sdk(client, created)):
                code, printed = run_main()
        self.assertEqual(code, 1)
        self.assertNotIn(SECRET, printed)
        self.assertIn("***", printed)
        self.assertEqual(json.loads(printed)["checks"][-1]["code"], "ANTHROPIC_AUTH_FAILED")
        # 조회만 하고 오래 기다리지 않는다.
        self.assertEqual(created, [{"api_key": SECRET, "timeout": 15.0, "max_retries": 0}])

    def test_main_prints_one_json_line_and_sets_the_exit_code(self):
        with isolated_env(ANTHROPIC_API_KEY=SECRET):
            with mock.patch.object(preflight, "_import_sdk", return_value=fake_sdk()):
                code, printed = run_main()
        self.assertEqual(code, 0)
        self.assertEqual(printed.count("\n"), 1)
        self.assertEqual(json.loads(printed)["schema_version"], PREFLIGHT_SCHEMA)
        self.assertTrue(json.loads(printed)["ok"])
        with isolated_env():
            with mock.patch.object(preflight, "_import_sdk", return_value=fake_sdk()):
                code, printed = run_main()
        self.assertEqual(code, 1)
        self.assertEqual(printed.count("\n"), 1)
        self.assertFalse(json.loads(printed)["ok"])

    def test_bad_setting_is_reported_as_json_not_a_traceback(self):
        # 설정 값이 틀려 설정을 못 만들 때도 JSON 한 줄과 종료 코드 1로 알린다(서버가 이 출력을 읽는다).
        with isolated_env(ANTHROPIC_API_KEY=SECRET, ANTHROPIC_GENERATION_SPEED="turbo"):
            with mock.patch.object(preflight, "_import_sdk", return_value=fake_sdk()):
                code, printed = run_main()
        self.assertEqual((code, printed.count("\n")), (1, 1))
        result = json.loads(printed)
        self.assertEqual((result["schema_version"], result["ok"]), (PREFLIGHT_SCHEMA, False))
        self.assertEqual([(c["name"], c["ok"], c["code"]) for c in result["checks"]], [("config", False, "GENERATION_CONFIG_INVALID")])
        self.assertIn("ANTHROPIC_GENERATION_SPEED", result["checks"][0]["message"])
        self.assertNotIn(SECRET, printed)

    def test_output_is_utf8_without_the_utf8_flag(self):
        # Windows에서 -X utf8이나 PYTHONIOENCODING 없이 띄워도 출력이 UTF-8 JSON으로 읽혀야 한다.
        # 빈 폴더에서 띄워 .env.local의 key를 읽지 않게 한다(key가 없으니 조회 전에 끝난다).
        # 패키지가 깔려 있지 않은 Python에서는 첫 검사(패키지)에서 멈춘다. 어느 쪽이든 조회 전에 끝나면 된다.
        dropped = set(GENERATION_ENV_NAMES) | {"PYTHONIOENCODING", "PYTHONUTF8"}
        env = {name: value for name, value in os.environ.items() if name not in dropped}
        env["PYTHONPATH"] = str(PROJECT_ROOT)
        env["ANTHROPIC_GENERATION_MODEL"] = "모델-이름"
        with tempfile.TemporaryDirectory() as folder:
            done = subprocess.run([sys.executable, "-m", "src.mission_generation.preflight"], cwd=folder, env=env, capture_output=True, timeout=120)
        result = json.loads(done.stdout.decode("utf-8"))
        self.assertEqual(done.returncode, 1)
        self.assertEqual((result["ok"], result["model"]), (False, "모델-이름"))
        self.assertIn(result["checks"][-1]["code"], ("ANTHROPIC_SDK_MISSING", "LLM_API_KEY_MISSING"))
        self.assertNotIn("model", [check["name"] for check in result["checks"]])


if __name__ == "__main__":
    unittest.main()
