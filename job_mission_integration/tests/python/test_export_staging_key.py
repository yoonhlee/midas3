# 관리자 페이지가 카탈로그에 미션을 넣을 때의 키를 못박는다.
# 서버는 이름이 고정된 폴더(admin_export/runs/jobsim_admin_v1/jobs/<직업>/<난이도>/)에 미션 하나만 두고
# scripts/export_missions.py를 부른다. 스크립트는 runs 바로 아래 폴더 이름을 키의 앞부분으로 쓰므로 키에 날짜가 없다.

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "export_missions.py"


class ExportStagingKeyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="export-staging-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        index = json.loads((ROOT / "missions" / "index.json").read_text(encoding="utf-8"))
        self.mission_text = (ROOT / "missions" / index["missions"][0]["path"]).read_text(encoding="utf-8")
        self.mission = json.loads(self.mission_text)

    def export_once(self) -> dict:
        """준비 폴더를 새로 만들고 스크립트를 한 번 돌린 뒤, 임시 missions/index.json의 마지막 미션 줄을 돌려준다."""

        staging = self.tmp / "admin_export"
        shutil.rmtree(staging, ignore_errors=True)
        job_cd = self.mission["job_identity"]["job_cd"]
        level = self.mission["mission"]["difficulty"]["level"]
        target = staging / "runs" / "jobsim_admin_v1" / "jobs" / job_cd / level / "mission_output.json"
        target.parent.mkdir(parents=True)
        target.write_text(self.mission_text, encoding="utf-8")
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--outputs", str(staging), "--missions-dir", str(self.tmp / "missions")],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        index = json.loads((self.tmp / "missions" / "index.json").read_text(encoding="utf-8"))
        return index["missions"][-1]

    def test_key_comes_from_the_fixed_folder_has_no_date_and_the_number_goes_up(self) -> None:
        first = self.export_once()
        second = self.export_once()
        self.assertEqual(first["key"], f"jobsim_admin_v1__{first['mission_id']}")
        self.assertIsNone(re.search(r"\d{8}", first["key"].replace(first["job_cd"], "")))
        self.assertTrue(first["mission_id"].endswith("_001") and second["mission_id"].endswith("_002"))
        self.assertEqual(second["key"], f"jobsim_admin_v1__{second['mission_id']}")
        self.assertEqual(len({first["key"], second["key"]}), 2)


if __name__ == "__main__":
    unittest.main()
