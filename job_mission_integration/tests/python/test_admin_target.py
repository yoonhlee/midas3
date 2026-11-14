# 한 건짜리 대상 파일 만들기(admin_target): 고를 수 있는 연결만 받고, 자료 형태를 좁힌 대상을 실행기가 받는 모양으로 쓴다.

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from basis_fixtures import EXEC_TEXT, JOB_CD, PROJECT_ROOT, SCRATCH_ROOT, UNIT_KEY, sample_ncs_job, sample_unit

from src.mission_generation import admin_target
from src.mission_generation.admin_target import (
    SELECTABLE_INDIRECT_KINDS,
    TARGET_SCHEMA,
    TargetError,
    build_target,
    link_is_selectable,
    main,
    selectable_units,
    write_target_file,
)
from src.mission_generation.blueprint_designer import TWO_STAGE_MATERIAL_TYPES
from src.mission_generation.pilot_runner import PilotRunner, normalize_ncs_targets

WORK = SCRATCH_ROOT / "admin_target"
WORK_RELATIVE = "outputs/_pytest_basis/admin_target"
HAS_KNOW_DATA = (PROJECT_ROOT / "data" / "api_raw" / JOB_CD / "dtlGb_2.xml").exists()
REAL_ROOT = PROJECT_ROOT / "data" / "ncs" / "jobs"
HAS_REAL_DATA = any(REAL_ROOT.glob("*.json"))

FIELD_UNIT = "02040302:11"
BROAD_UNIT = "02040302:12"


def unit_for(exec_job_id: str, unit_key: str, name: str, text: str, **link) -> dict:
    unit = sample_unit()
    unit.update({"exec_job_id": exec_job_id, "exec_job_text": text, "unit_key": unit_key, "unit_cd": unit_key.partition(":")[2], "unit_name": name})
    unit["link"].update({"phrase": "세관 신고서류를 작성", "criteria_refs": ["2.1"], **link})
    return unit


def small_job() -> dict:
    """연결 셋(직접, 분야 한정, 범위 넓음)이 든 작은 직업 파일."""

    return {
        **sample_ncs_job(),
        "units": [
            unit_for("exec_001", UNIT_KEY, "수출통관", EXEC_TEXT, match="직접"),
            unit_for("exec_002", FIELD_UNIT, "수입통관", "수입 물품의 통관 서류를 작성한다.", match="간접", indirect_kind="분야 한정"),
            unit_for("exec_003", BROAD_UNIT, "원산지관리", "무역 관련 사무를 수행한다.", match="간접", indirect_kind="범위 넓음"),
        ],
    }


def run_main(*args: str) -> tuple[int, str]:
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        code = main(list(args))
    return code, printed.getvalue()


class AdminTargetTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        self.root = WORK / "ncs_jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / f"{JOB_CD}.json").write_text(json.dumps(small_job(), ensure_ascii=False), encoding="utf-8")
        self.out = WORK / "targets" / "one.json"

    def test_direct_and_field_limited_links_are_selectable(self):
        job = small_job()
        self.assertEqual(SELECTABLE_INDIRECT_KINDS, ("분야 한정",))
        self.assertEqual([link_is_selectable(unit["link"]) for unit in job["units"]], [True, True, False])
        self.assertEqual([unit["unit_key"] for unit in selectable_units(job)], [UNIT_KEY, FIELD_UNIT])
        self.assertFalse(link_is_selectable({"match": "간접", "indirect_kind": "상위 수준"}))
        self.assertFalse(link_is_selectable({}))

    def test_target_passes_the_runner_check(self):
        target = build_target(self.root, JOB_CD, "exec_001", UNIT_KEY, "normal")
        self.assertEqual(len(normalize_ncs_targets({"targets": [target]})), 1)
        self.assertEqual(
            (target["job_cd"], target["job_name"], target["exec_job_id"], target["exec_job_text"], target["unit_key"], target["unit_name"]),
            (JOB_CD, "무역사무원", "exec_001", EXEC_TEXT, UNIT_KEY, "수출통관"),
        )
        self.assertEqual((target["difficulty"], target["match_label"], target["phrase"], target["criteria_refs"]), ("normal", "직접", "세관 신고서류를 작성", ["2.1"]))
        self.assertEqual(build_target(self.root, JOB_CD, "exec_002", FIELD_UNIT, "easy")["match_label"], "간접(분야 한정)")
        # 파일의 모양: 실행기의 --ncs-targets가 그대로 읽는다.
        code, printed = run_main("--job", JOB_CD, "--exec", "exec_001", "--unit", UNIT_KEY, "--difficulty", "normal", "--ncs-root", str(self.root), "--out", str(self.out))
        written = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual((code, written["schema_version"], written["targets"]), (0, TARGET_SCHEMA, [target]))
        self.assertEqual(json.loads(printed), {"ok": True, "out": self.out.as_posix(), "allowed_material_types": target["material_mix"]["allowed_material_types"]})
        self.assertEqual(write_target_file(target, WORK / "deep" / "er" / "two.json"), WORK / "deep" / "er" / "two.json")

    def test_broad_link_is_refused_and_no_file_is_written(self):
        with self.assertRaises(TargetError) as caught:
            build_target(self.root, JOB_CD, "exec_003", BROAD_UNIT, "normal")
        self.assertEqual(caught.exception.code, "TARGET_LINK_NOT_SELECTABLE")
        code, printed = run_main("--job", JOB_CD, "--exec", "exec_003", "--unit", BROAD_UNIT, "--difficulty", "normal", "--ncs-root", str(self.root), "--out", str(self.out))
        self.assertEqual(code, 1)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.out.parent.exists())
        result = json.loads(printed)
        self.assertEqual((result["ok"], result["error"]["code"]), (False, "TARGET_LINK_NOT_SELECTABLE"))
        self.assertTrue(result["error"]["message"])

    def test_other_failures_are_reported_as_json_not_a_traceback(self):
        # 파일을 쓸 수 없거나 예상 못 한 오류가 나도 JSON 한 줄과 종료 코드 1로 알린다(서버가 이 출력을 읽는다).
        args = ["--job", JOB_CD, "--exec", "exec_001", "--unit", UNIT_KEY, "--difficulty", "normal", "--ncs-root", str(self.root)]
        blocker = WORK / "blocker"
        blocker.write_text("폴더가 아니라 파일이다", encoding="utf-8")
        code, printed = run_main(*args, "--out", str(blocker / "one.json"))
        result = json.loads(printed)
        self.assertEqual((code, printed.count("\n"), result["ok"], result["error"]["code"]), (1, 1, False, "TARGET_WRITE_FAILED"))
        with mock.patch.object(admin_target, "plan_materials", side_effect=RuntimeError("규칙이 깨졌다")):
            code, printed = run_main(*args, "--out", str(self.out))
        result = json.loads(printed)
        self.assertEqual((code, printed.count("\n"), result["ok"], result["error"]["code"]), (1, 1, False, "TARGET_INTERNAL_ERROR"))
        self.assertIn("RuntimeError", result["error"]["message"])
        self.assertFalse(self.out.exists())

    def test_unknown_job_link_and_difficulty_have_their_own_codes(self):
        cases = [
            (("K000000000", "exec_001", UNIT_KEY, "normal"), "TARGET_JOB_NOT_FOUND"),
            ((f"../ncs_jobs/{JOB_CD}", "exec_001", UNIT_KEY, "normal"), "TARGET_JOB_NOT_FOUND"),  # 직업 코드로 다른 경로를 가리킬 수 없다
            ((JOB_CD, "exec_009", UNIT_KEY, "normal"), "TARGET_LINK_NOT_FOUND"),
            ((JOB_CD, "exec_001", FIELD_UNIT, "normal"), "TARGET_LINK_NOT_FOUND"),  # 있는 문장과 있는 능력단위지만 서로 이어져 있지 않다
            ((JOB_CD, "exec_001", UNIT_KEY, "expert"), "TARGET_BAD_DIFFICULTY"),
        ]
        for args, code in cases:
            with self.subTest(code=code, args=args):
                with self.assertRaises(TargetError) as caught:
                    build_target(self.root, *args)
                self.assertEqual(caught.exception.code, code)

    def test_narrowing_attaches_a_mix_and_no_narrow_leaves_it_out(self):
        target = build_target(self.root, JOB_CD, "exec_001", UNIT_KEY, "normal")
        self.assertEqual(target["material_mix"]["rule_version"], "mix-v1")
        self.assertTrue(target["material_mix"]["allowed_material_types"])
        plain = build_target(self.root, JOB_CD, "exec_001", UNIT_KEY, "normal", narrow_types=False)
        self.assertNotIn("material_mix", plain)
        self.assertEqual({key: value for key, value in target.items() if key != "material_mix"}, plain)
        code, printed = run_main(
            "--job", JOB_CD, "--exec", "exec_001", "--unit", UNIT_KEY, "--difficulty", "normal", "--ncs-root", str(self.root), "--no-narrow", "--out", str(self.out)
        )
        self.assertEqual((code, json.loads(printed)["allowed_material_types"]), (0, None))
        self.assertNotIn("material_mix", json.loads(self.out.read_text(encoding="utf-8"))["targets"][0])

    def test_easy_targets_only_get_table_chart_or_log(self):
        for exec_job_id, unit_key in (("exec_001", UNIT_KEY), ("exec_002", FIELD_UNIT)):
            allowed = build_target(self.root, JOB_CD, exec_job_id, unit_key, "easy")["material_mix"]["allowed_material_types"]
            self.assertTrue(allowed)
            self.assertLessEqual(set(allowed), {"table", "chart", "log"})

    @unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 mock 전체 실행을 건너뛴다")
    def test_mock_run_without_narrowing_opens_all_seven_types(self):
        code, _printed = run_main(
            "--job", JOB_CD, "--exec", "exec_001", "--unit", UNIT_KEY, "--difficulty", "normal", "--ncs-root", str(self.root), "--no-narrow", "--out", str(self.out)
        )
        self.assertEqual(code, 0)
        summary = PilotRunner(
            output_root=f"{WORK_RELATIVE}/out",
            force_mock=True,
            concurrency=1,
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            two_stage_basis=True,
            ncs_targets=json.loads(self.out.read_text(encoding="utf-8")),
        ).run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 0))
        decisions = json.loads((Path(summary["run_dir"]) / "jobs" / JOB_CD / "normal" / "system_decisions.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(decisions["allowed_material_types"]), sorted(TWO_STAGE_MATERIAL_TYPES))
        self.assertEqual(len(TWO_STAGE_MATERIAL_TYPES), 7)

    def test_print_output_is_utf8_without_the_utf8_flag(self):
        # Windows에서 -X utf8이나 PYTHONIOENCODING 없이 띄워도 한글이 든 출력이 UTF-8 JSON으로 읽혀야 한다.
        env = {name: value for name, value in os.environ.items() if name not in ("PYTHONIOENCODING", "PYTHONUTF8")}
        env["PYTHONPATH"] = str(PROJECT_ROOT)
        command = [sys.executable, "-m", "src.mission_generation.admin_target", "--job", JOB_CD, "--exec", "exec_001", "--unit", UNIT_KEY]
        command += ["--difficulty", "hard", "--ncs-root", str(self.root.resolve()), "--print"]
        done = subprocess.run(command, cwd=WORK, env=env, capture_output=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", errors="replace"))
        target = json.loads(done.stdout.decode("utf-8"))
        self.assertEqual((target["exec_job_text"], target["job_name"]), (EXEC_TEXT, "무역사무원"))
        self.assertFalse(self.out.exists())


@unittest.skipUnless(HAS_REAL_DATA, "직업별 NCS 자료(data/ncs/jobs)가 없어 건너뛴다")
class RealDataTest(unittest.TestCase):
    """직업별 NCS 자료(data/ncs/jobs)에서 고를 수 있는 직업·문장·연결의 수를 못박는다."""

    def test_selectable_counts_match_the_design(self):
        jobs, sentences, links = set(), set(), 0
        files = sorted(REAL_ROOT.glob("*.json"))
        for path in files:
            job = json.loads(path.read_text(encoding="utf-8"))
            for unit in selectable_units(job):
                jobs.add(job["job_cd"])
                sentences.add((job["job_cd"], unit["exec_job_id"]))
                links += 1
        self.assertEqual(len(files), 76)
        self.assertEqual((len(jobs), len(sentences), links), (74, 399, 548))

    def test_known_targets_get_the_measured_types(self):
        def types(difficulty: str) -> list[str]:
            return build_target(REAL_ROOT, "K000000832", "exec_001", "20010601:15", difficulty)["material_mix"]["allowed_material_types"]

        self.assertEqual(types("hard"), ["memo", "checklist", "table", "log"])
        self.assertEqual(types("normal"), ["checklist", "table"])
        self.assertEqual(types("easy"), ["table", "log"])


if __name__ == "__main__":
    unittest.main()
