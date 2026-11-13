# 문장 단위 대상 지정(--ncs-targets): 한 실행에서 (직업, 하는 일 문장, 능력단위, 난이도) 조합을 여러 개 받는 길을 확인한다.

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from basis_fixtures import JOB_CD, PROJECT_ROOT, SCRATCH_ROOT, UNIT_KEY, sample_ncs_job, sample_unit

from src.mission_generation.blueprint_designer import MockBlueprintBuilder
from src.mission_generation.draft_generator import MockMissionDraftBuilder
from src.mission_generation.ncs_background_loader import NcsBackgroundLoader
from src.mission_generation.pilot_runner import PilotRunner, _parse_ncs_targets_file, normalize_ncs_targets

WORK = SCRATCH_ROOT / "ncs_targets"
WORK_RELATIVE = "outputs/_pytest_basis/ncs_targets"
HAS_KNOW_DATA = (PROJECT_ROOT / "data" / "api_raw" / JOB_CD / "dtlGb_2.xml").exists()
OTHER_UNIT_KEY = "02040302:11"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def unit_for(exec_job_id: str, unit_key: str = UNIT_KEY, name: str = "수출통관") -> dict:
    """같은 능력단위 내용을 다른 문장(또는 다른 능력단위 키)에 이은 항목."""

    unit = sample_unit()
    unit["exec_job_id"] = exec_job_id
    unit["unit_key"] = unit_key
    unit["unit_cd"] = unit_key.partition(":")[2]
    unit["unit_name"] = name
    return unit


# 한 능력단위(UNIT_KEY)가 문장 1과 문장 2에 모두 이어져 있고, 문장 2에는 다른 능력단위도 이어져 있다.
UNITS = [unit_for("exec_001"), unit_for("exec_002"), unit_for("exec_002", OTHER_UNIT_KEY, "수입통관")]


def target(difficulty: str, exec_job_id: str, unit_key: str = UNIT_KEY, job_cd: str = JOB_CD, **extra) -> dict:
    return {"job_cd": job_cd, "exec_job_id": exec_job_id, "unit_key": unit_key, "difficulty": difficulty, **extra}


class PickUnitBySentenceTest(unittest.TestCase):
    def pick(self, unit_key=None, exec_job_id=None, difficulty="normal"):
        return NcsBackgroundLoader.pick_unit(UNITS, difficulty, unit_key, exec_job_id)

    def test_unit_key_alone_still_takes_the_first_entry(self):
        self.assertIs(self.pick(UNIT_KEY), UNITS[0])
        self.assertIs(self.pick(OTHER_UNIT_KEY), UNITS[2])

    def test_sentence_tells_apart_two_entries_of_the_same_unit(self):
        self.assertIs(self.pick(UNIT_KEY, "exec_001"), UNITS[0])
        self.assertIs(self.pick(UNIT_KEY, "exec_002"), UNITS[1])
        self.assertIs(self.pick(OTHER_UNIT_KEY, "exec_002"), UNITS[2])

    def test_pair_that_is_not_linked_gives_nothing(self):
        self.assertIsNone(self.pick(OTHER_UNIT_KEY, "exec_001"))
        self.assertIsNone(self.pick(UNIT_KEY, "exec_009"))

    def test_sentence_alone_takes_its_first_unit(self):
        self.assertIs(self.pick(None, "exec_002"), UNITS[1])
        self.assertIsNone(self.pick(None, "exec_009"))

    def test_without_sentence_the_old_difficulty_rule_is_unchanged(self):
        units = [{"unit_key": "a:1", "difficulty": "easy"}, {"unit_key": "a:2", "recommended_difficulty": "hard"}]
        self.assertIs(NcsBackgroundLoader.pick_unit(units, "easy"), units[0])
        self.assertIs(NcsBackgroundLoader.pick_unit(units, "hard"), units[1])
        self.assertIsNone(NcsBackgroundLoader.pick_unit(units, "normal"))


class NormalizeTargetsTest(unittest.TestCase):
    def test_keeps_the_four_fields_and_accepts_a_plan_file_shape(self):
        items = [target("easy", "exec_002", exec_job_text="문장", reason="이유"), target("hard", "exec_001")]
        expected = [target("easy", "exec_002"), target("hard", "exec_001")]
        self.assertEqual(normalize_ncs_targets(items), expected)
        self.assertEqual(normalize_ncs_targets({"schema_version": "mission_target_plan.v1", "targets": items}), expected)

    def test_rejects_bad_lists(self):
        cases = {
            "non-empty list": [],
            "not an object": ["K000000918"],
            "missing exec_job_id": [{"job_cd": JOB_CD, "unit_key": UNIT_KEY, "difficulty": "easy"}],
            "unknown difficulty": [target("expert", "exec_001")],
            "DUTY:UNIT": [target("easy", "exec_001", unit_key="0204030210")],
            "more than once": [target("easy", "exec_001"), target("easy", "exec_002")],
        }
        for message, items in cases.items():
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    normalize_ncs_targets(items)
        with self.assertRaisesRegex(ValueError, "non-empty list"):
            normalize_ncs_targets({"targets": None})

    def test_same_job_may_appear_once_per_difficulty(self):
        items = [target("easy", "exec_001"), target("normal", "exec_001"), target("hard", "exec_002")]
        self.assertEqual(len(normalize_ncs_targets(items)), 3)

    def test_file_parser_reads_lists_and_plan_files(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "targets.json"
            path.write_text(json.dumps({"targets": [target("hard", "exec_001", note="x")]}, ensure_ascii=False), encoding="utf-8-sig")
            self.assertEqual(_parse_ncs_targets_file(str(path)), [target("hard", "exec_001")])
            path.write_text("[]", encoding="utf-8")
            with self.assertRaises(argparse.ArgumentTypeError):
                _parse_ncs_targets_file(str(path))
            with self.assertRaises(argparse.ArgumentTypeError):
                _parse_ncs_targets_file(str(Path(folder) / "missing.json"))


class TargetOptionTest(unittest.TestCase):
    def test_needs_ncs_background(self):
        with self.assertRaisesRegex(ValueError, "--ncs-targets requires --ncs-background"):
            PilotRunner(ncs_targets=[target("easy", "exec_001")])

    def test_cannot_be_combined_with_jobs_difficulties_or_ncs_unit(self):
        for option in ({"target_job_codes": [JOB_CD]}, {"target_difficulty_codes": ["easy"]}, {"ncs_units": {JOB_CD: UNIT_KEY}}):
            with self.subTest(option=option):
                with self.assertRaisesRegex(ValueError, "cannot be combined"):
                    PilotRunner(use_ncs_background=True, ncs_targets=[target("easy", "exec_001")], **option)

    def test_targets_decide_the_jobs_and_difficulties(self):
        runner = PilotRunner(
            use_ncs_background=True,
            ncs_targets=[target("hard", "exec_001", job_cd="K000000997"), target("easy", "exec_002"), target("hard", "exec_001")],
        )
        self.assertEqual(runner.target_job_codes, ["K000000997", JOB_CD])
        self.assertEqual(runner.target_difficulty_codes, ["easy", "hard"])  # 실행 순서는 쉬움 → 보통 → 어려움
        config = {"difficulties": [{"code": "easy"}, {"code": "hard"}]}
        self.assertEqual(runner._job_difficulties("K000000997", config), [{"code": "hard"}])
        self.assertEqual(runner._job_difficulties(JOB_CD, config), [{"code": "easy"}, {"code": "hard"}])

    def test_without_targets_every_difficulty_runs_as_before(self):
        runner = PilotRunner(use_ncs_background=True, ncs_units={JOB_CD: UNIT_KEY})
        config = {"difficulties": [{"code": "easy"}, {"code": "normal"}, {"code": "hard"}]}
        self.assertEqual((runner.ncs_targets, runner._ncs_target_by_slot), ([], {}))
        self.assertEqual(runner._job_difficulties(JOB_CD, config), config["difficulties"])


@unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 전체 실행을 건너뛴다")
class TargetRunTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        shutil.rmtree(WORK, True)
        (WORK / "ncs_jobs").mkdir(parents=True, exist_ok=True)
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(json.dumps({**sample_ncs_job(), "units": UNITS}, ensure_ascii=False), encoding="utf-8")

    def runner(self, out: str = "out", **options) -> PilotRunner:
        return PilotRunner(
            output_root=f"{WORK_RELATIVE}/{out}",
            concurrency=1,
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            two_stage_basis=True,
            **options,
        )

    @staticmethod
    def slot(summary: dict, difficulty: str) -> Path:
        return Path(summary["run_dir"]) / "jobs" / JOB_CD / difficulty

    def test_each_difficulty_gets_its_own_sentence_and_unit(self):
        targets = [target("easy", "exec_002", OTHER_UNIT_KEY), target("normal", "exec_002"), target("hard", "exec_001")]
        summary = self.runner(force_mock=True, ncs_targets=targets).run()
        self.assertEqual((summary["total_targets"], summary["saved_count"], summary["failed_count"]), (3, 3, 0))
        expected = {"easy": ("exec_002", OTHER_UNIT_KEY, "K.exec.2"), "normal": ("exec_002", UNIT_KEY, "K.exec.2"), "hard": ("exec_001", UNIT_KEY, "K.exec.1")}
        for difficulty, (exec_job_id, unit_key, exec_ref) in expected.items():
            with self.subTest(difficulty=difficulty):
                slot = self.slot(summary, difficulty)
                self.assertEqual(read_json(slot / "system_decisions.json")["selected_exec_job"]["exec_job_id"], exec_job_id)
                pack = read_json(slot / "source_pack.json")
                self.assertEqual(pack["target_exec_ref"], exec_ref)
                unit_piece = next(piece for piece in pack["pieces"] if piece["id"] == "N.unit")
                self.assertEqual(unit_piece["locator"]["unit_key"], unit_key)
                mission = read_json(slot / "mission_output.json")
                self.assertEqual(mission["target_exec_job"]["exec_job_id"], exec_job_id)
                self.assertEqual(mission["mission_id"], f"mission_{JOB_CD}_{difficulty}_001")
                basis = read_json(slot / "generation_basis.json")
                self.assertEqual(basis["chain"][0]["sources"][0]["id"], exec_ref)
        self.assertEqual(read_json(Path(summary["run_dir"]) / "pilot_config.json")["ncs_targets"], targets)

    def test_only_the_listed_difficulties_run(self):
        summary = self.runner(force_mock=True, ncs_targets=[target("hard", "exec_002")]).run()
        self.assertEqual((summary["total_targets"], summary["saved_count"]), (1, 1))
        self.assertTrue(self.slot(summary, "hard").is_dir())
        self.assertFalse(self.slot(summary, "easy").exists())
        self.assertFalse(self.slot(summary, "normal").exists())

    def test_same_target_gives_the_same_request_as_the_ncs_unit_option(self):
        # 직업당 능력단위 하나(--ncs-unit)로 고른 대상과 같은 대상을 문장 단위로 지정하면 프롬프트 입력이 글자까지 같다.
        old = self.runner("old", force_mock=True, target_job_codes=[JOB_CD], target_difficulty_codes=["normal"], ncs_units={JOB_CD: UNIT_KEY}).run()
        new = self.runner("new", force_mock=True, ncs_targets=[target("normal", "exec_001")]).run()
        for name in ("blueprint_request.json", "source_pack.json", "system_decisions.json", "llm_input_package.json", "mission_output.json"):
            self.assertEqual((self.slot(new, "normal") / name).read_bytes(), (self.slot(old, "normal") / name).read_bytes(), name)

    def test_pair_that_is_not_linked_fails_that_target_only(self):
        summary = self.runner(force_mock=True, ncs_targets=[target("easy", "exec_001", OTHER_UNIT_KEY), target("hard", "exec_001")]).run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (1, 1))
        status = read_json(self.slot(summary, "easy") / "run_status.json")
        self.assertEqual((status["status"], status["error"]["errors"][0]["code"]), ("decision_failed", "NCS_UNIT_MISSING"))
        self.assertIn("exec_job_id=exec_001", status["error"]["errors"][0]["message"])
        self.assertEqual(read_json(self.slot(summary, "hard") / "run_status.json")["status"], "saved")


if __name__ == "__main__":
    unittest.main()
