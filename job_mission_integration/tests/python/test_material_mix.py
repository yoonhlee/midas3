# 자료 형태 배정(material_planner, 규칙 mix-v1): 한 직업의 세 미션이 서로 다른 자료 형태를 쓰도록 코드가 형태를 좁혀 주는 길을 확인한다.
# 배정이 없는 대상은 전과 같이 일곱 형태를 모두 열고, 요청이 글자까지 같아야 한다.

from __future__ import annotations

import contextlib
import copy
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from basis_fixtures import JOB_CD, PROJECT_ROOT, SCRATCH_ROOT, UNIT_KEY, sample_ncs_job, sample_unit

from src.mission_generation import material_planner as mp
from src.mission_generation.basis_card_exporter import BasisCardExporter
from src.mission_generation.blueprint_designer import (
    DATA_MATERIAL_TYPES,
    STANDARD_MATERIAL_TYPES,
    TWO_STAGE_MATERIAL_TYPES,
    MockBlueprintBuilder,
)
from src.mission_generation.draft_generator import MockMissionDraftBuilder
from src.mission_generation.pilot_runner import PilotRunner, normalize_ncs_targets

WORK = SCRATCH_ROOT / "material_mix"
WORK_RELATIVE = "outputs/_pytest_basis/material_mix"
HAS_KNOW_DATA = (PROJECT_ROOT / "data" / "api_raw" / JOB_CD / "dtlGb_2.xml").exists()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def unit(documents=(), criteria=(), considerations=(), exec_job_id="exec_001", unit_key="00000000:01") -> dict:
    """형태 낱말만 시험하려고 만든 작은 능력단위. 수행준거는 요소 하나에 차례로 넣는다(번호 1.1, 1.2, ...)."""

    return {
        "unit_key": unit_key,
        "exec_job_id": exec_job_id,
        "elements": [{"no": 1, "name": "요소", "criteria": list(criteria)}],
        "scope": {"documents": list(documents), "considerations": list(considerations)},
    }


def signals_for(documents=(), criteria=(), linked=(), phrase="", considerations=()) -> dict:
    pieces = mp.piece_texts(unit(documents, criteria, considerations), phrase, "", list(linked))
    return mp.type_signals(pieces)


# 형태마다 뚜렷한 근거가 있는 대상 셋: 쉬움(기록), 보통(차트), 어려움(일정표)
EASY_LOG = signals_for(documents=["작업일지"], phrase="장비 상태를 점검한다")
NORMAL_CHART = signals_for(documents=["월별 판매 통계"], phrase="고객 문의를 정리한다")
HARD_SCHEDULE = signals_for(documents=["공정표", "체크리스트"], phrase="작업 순서를 정한다")
# 아무 낱말도 걸리지 않는 대상
BLANK = signals_for(documents=["관련 서적"], phrase="디자인한다")


class SignalTest(unittest.TestCase):
    def test_piece_numbers_follow_the_source_pack(self):
        pieces = mp.piece_texts(unit(["가 서류", "나 서류"], ["첫째", "둘째"], ["고려"]), "구절", "문장", ["1.2"])
        self.assertEqual([piece["id"] for piece in pieces], ["N.doc.1", "N.doc.2", "N.c.1.2", "phrase", "N.c.1.1", "N.con.1"])
        self.assertEqual([piece["source"] for piece in pieces][:4], ["doc", "doc", "linked_criterion", "phrase"])
        # 구절이 없으면 문장 전체를 쓴다.
        self.assertEqual(mp.piece_texts(unit(), "", "하는 일 문장", [])[0]["id"], "sentence")

    def test_words_inside_other_words_do_not_count(self):
        signals = signals_for(documents=["응용프로그램 설치 매뉴얼", "수출입 신고서", "프로젝트 산출물"])
        self.assertEqual(signals["log"]["score"], 0)
        self.assertEqual(signals["table"]["evidence"], [])

    def test_one_piece_counts_once_with_its_strongest_word(self):
        signals = signals_for(documents=["작업일지 및 기록 대장"])
        self.assertEqual(signals["log"]["score"], 2.0)
        self.assertEqual(len(signals["log"]["evidence"]), 1)
        self.assertEqual(signals["log"]["evidence"][0]["id"], "N.doc.1")

    def test_weights_by_source(self):
        doc = signals_for(documents=["통계 자료"])["chart"]
        other = signals_for(criteria=["통계를 낼 수 있다."])["chart"]  # 연결이 근거로 들지 않은 수행준거
        linked = signals_for(criteria=["통계를 낼 수 있다."], linked=["1.1"])["chart"]
        self.assertEqual((doc["score"], doc["primary_score"]), (2.0, 2.0))
        self.assertEqual((other["score"], other["primary_score"]), (0.5, 0))
        self.assertEqual((linked["score"], linked["primary_score"]), (2.0, 2.0))

    def test_fit_levels(self):
        self.assertEqual(mp.fit_level("log", EASY_LOG), mp.FIT_STRONG)
        # 약한 낱말 하나(주된 조각)와 다른 조각의 뒷받침 → 약함
        weak = signals_for(phrase="장애가 나면 고친다", criteria=["장애 원인을 찾는다.", "장애 재발을 막는다."])
        self.assertEqual(mp.fit_level("log", weak), mp.FIT_WEAK)
        # 약한 낱말 하나뿐 → 주지 않음
        self.assertIsNone(mp.fit_level("log", signals_for(phrase="장애가 나면 고친다")))
        # '계획'처럼 흔한 말만으로는 일정표가 되지 않는다.
        self.assertIsNone(mp.fit_level("schedule", signals_for(documents=["교육계획서"], phrase="계획을 세운다")))
        # 표·메모·이메일은 근거가 없어도 줄 수 있다.
        for kind in mp.ALWAYS_TYPES:
            self.assertEqual(mp.fit_level(kind, BLANK), mp.FIT_FALLBACK)
        for kind in ("chart", "log", "schedule", "checklist"):
            self.assertIsNone(mp.fit_level(kind, BLANK))


class AssignJobTest(unittest.TestCase):
    def test_three_missions_get_different_data_types_from_their_evidence(self):
        result = mp.assign_job({"easy": EASY_LOG, "normal": NORMAL_CHART, "hard": HARD_SCHEDULE})
        self.assertEqual({d: result[d]["lead_data_type"] for d in result}, {"easy": "log", "normal": "chart", "hard": "schedule"})
        self.assertTrue(all(not result[d]["shared_types"] for d in result))

    def test_no_type_is_offered_to_two_missions_unless_types_run_short(self):
        result = mp.assign_job({"easy": EASY_LOG, "normal": NORMAL_CHART, "hard": HARD_SCHEDULE})
        offered = [kind for d in result for kind in result[d]["allowed_material_types"]]
        self.assertEqual(len(offered), len(set(offered)))

    def test_easy_gets_one_data_type_that_can_carry_the_mission_alone(self):
        # 일정표만 뚜렷해도 쉬움에는 일정표를 주지 않는다(1~2항목으로는 과제를 다 담지 못한다).
        only_schedule = signals_for(documents=["공정표"], phrase="일정을 짠다")
        result = mp.assign_job({"easy": only_schedule, "normal": BLANK, "hard": BLANK})
        self.assertIn(result["easy"]["lead_data_type"], mp.EASY_TYPES)
        self.assertTrue(set(result["easy"]["allowed_material_types"]) <= set(mp.EASY_TYPES))

    def test_normal_and_hard_get_a_standard_type_and_a_data_type(self):
        result = mp.assign_job({"easy": EASY_LOG, "normal": NORMAL_CHART, "hard": HARD_SCHEDULE})
        for difficulty in ("normal", "hard"):
            kinds = set(result[difficulty]["allowed_material_types"])
            self.assertTrue(kinds & set(STANDARD_MATERIAL_TYPES), difficulty)
            self.assertTrue(kinds & set(DATA_MATERIAL_TYPES), difficulty)
            self.assertGreaterEqual(len(kinds), 2)
        self.assertNotEqual(result["normal"]["standard_type"], result["hard"]["standard_type"])
        # 보통은 고객 '문의', 어려움은 '체크리스트'가 걸렸다.
        self.assertEqual((result["normal"]["standard_type"], result["hard"]["standard_type"]), ("email", "checklist"))

    def test_without_evidence_only_the_always_types_repeat(self):
        result = mp.assign_job({"easy": BLANK, "normal": BLANK, "hard": BLANK})
        self.assertEqual({result[d]["lead_data_type"] for d in result}, {"table"})
        self.assertEqual({result["normal"]["standard_type"], result["hard"]["standard_type"]}, {"memo", "email"})
        self.assertEqual(result["easy"]["shared_types"], ["table"])

    def test_a_type_with_evidence_is_not_repeated_to_fill_a_gap(self):
        # 기록은 세 대상 모두에 뚜렷하지만 한 미션에만 준다. 나머지는 표가 겹친다.
        logs = {d: signals_for(documents=["작업일지"]) for d in ("easy", "normal", "hard")}
        result = mp.assign_job(logs)
        leads = [result[d]["lead_data_type"] for d in ("easy", "normal", "hard")]
        self.assertEqual(leads.count("log"), 1)
        self.assertEqual(leads.count("table"), 2)

    def test_weak_types_are_used_only_to_keep_missions_apart(self):
        weak_log = signals_for(phrase="장애가 나면 고친다", criteria=["장애 원인을 찾는다.", "장애 재발을 막는다."])
        # 어려움은 표가 뚜렷하고 다른 형태는 근거가 없다. 쉬움의 약한 기록은 표와 겹치지 않게 하려고 쓴다.
        table_hard = signals_for(documents=["단가 목록"])
        result = mp.assign_job({"easy": weak_log, "normal": NORMAL_CHART, "hard": table_hard})
        self.assertEqual(result["easy"]["lead_data_type"], "log")
        # 겹침을 막을 필요가 없으면(쉬움 혼자) 약한 형태보다 표를 쓴다.
        alone = mp.assign_job({"easy": weak_log})
        self.assertEqual(alone["easy"]["lead_data_type"], "table")

    def test_spare_types_never_put_table_into_easy_or_memo_into_normal(self):
        rich = signals_for(documents=["단가 목록", "작업일지", "월별 통계", "공정표", "운영 지침", "문의 메일", "점검표"])
        result = mp.assign_job({"easy": rich, "normal": rich, "hard": rich})
        self.assertNotIn("table", result["easy"]["spare_types"])
        self.assertNotIn("memo", result["normal"]["spare_types"])
        offered = [kind for d in result for kind in result[d]["allowed_material_types"]]
        self.assertEqual(len(offered), len(set(offered)))
        self.assertEqual(sorted(offered), sorted(TWO_STAGE_MATERIAL_TYPES))

    def test_only_listed_difficulties_are_assigned(self):
        result = mp.assign_job({"hard": HARD_SCHEDULE})
        self.assertEqual(list(result), ["hard"])
        self.assertEqual(result["hard"]["lead_data_type"], "schedule")

    def test_same_input_gives_the_same_assignment(self):
        signals = {"easy": EASY_LOG, "normal": NORMAL_CHART, "hard": HARD_SCHEDULE}
        self.assertEqual(mp.assign_job(copy.deepcopy(signals)), mp.assign_job(copy.deepcopy(signals)))


def plan_fixture() -> tuple[dict, dict]:
    """직업 하나·대상 셋의 작은 배치표와 생성기 입력."""

    units = {
        (JOB_CD, "exec_001", "a:1"): unit(["작업일지"], ["기록을 남길 수 있다."], exec_job_id="exec_001", unit_key="a:1"),
        (JOB_CD, "exec_002", "a:2"): unit(["월별 판매 통계"], ["추이를 볼 수 있다."], exec_job_id="exec_002", unit_key="a:2"),
        (JOB_CD, "exec_003", "a:3"): unit(["공정표", "체크리스트"], ["일정을 정할 수 있다."], exec_job_id="exec_003", unit_key="a:3"),
    }
    targets = [
        {"job_cd": JOB_CD, "job_name": "무역사무원", "difficulty": d, "exec_job_id": e, "unit_key": k, "phrase": "", "exec_job_text": "문장", "criteria_refs": ["1.1"], "unit_name": "능력단위"}
        for d, e, k in (("easy", "exec_001", "a:1"), ("normal", "exec_002", "a:2"), ("hard", "exec_003", "a:3"))
    ]
    return {"schema_version": "mission_target_plan.v1", "rule_version": "plan-v1", "targets": targets}, units


class PlanMaterialsTest(unittest.TestCase):
    def test_adds_a_record_to_every_target_without_changing_the_input(self):
        plan, units = plan_fixture()
        before = copy.deepcopy(plan)
        mixed = mp.plan_materials(plan, units)
        self.assertEqual(plan, before)
        self.assertEqual(mixed["material_mix_rule_version"], mp.MIX_RULE_VERSION)
        for target in mixed["targets"]:
            mix = target["material_mix"]
            self.assertEqual(mix["rule_version"], mp.MIX_RULE_VERSION)
            self.assertEqual(set(mix["job_types"]), {"easy", "normal", "hard"})
            self.assertEqual(set(mix["signals"]), set(TWO_STAGE_MATERIAL_TYPES))
            self.assertIn("같은 직업의 다른 미션", mix["reason"])
        easy = mixed["targets"][0]["material_mix"]
        self.assertEqual(easy["allowed_material_types"], ["log"])
        self.assertIn("N.doc.1 '일지'", easy["reason"])
        self.assertIn("뚜렷함", easy["reason"])
        self.assertEqual(easy["signals"]["log"]["evidence"][0]["text"], "작업일지")

    def test_counts(self):
        plan, units = plan_fixture()
        counts = mp.plan_materials(plan, units)["material_mix_counts"]
        self.assertEqual((counts["jobs"], counts["targets"]), (1, 3))
        self.assertEqual(counts["jobs_with_distinct_data_types"], 1)
        self.assertEqual(counts["jobs_with_shared_types"], 0)
        self.assertEqual(counts["lead_data_type"], {"chart": 1, "log": 1, "schedule": 1})

    def test_missing_generator_input_is_an_error(self):
        plan, units = plan_fixture()
        units.pop((JOB_CD, "exec_003", "a:3"))
        with self.assertRaisesRegex(ValueError, "no generator input"):
            mp.plan_materials(plan, units)

    def test_command_writes_the_plan_table_and_summary(self):
        plan, units = plan_fixture()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "ncs_jobs").mkdir()
            (root / "ncs_jobs" / f"{JOB_CD}.json").write_text(
                json.dumps({"job_cd": JOB_CD, "units": list(units.values())}, ensure_ascii=False), encoding="utf-8"
            )
            (root / "mission_targets.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                code = mp.main(["--plan", str(root / "mission_targets.json"), "--ncs-root", str(root / "ncs_jobs"), "--out", str(root / "out")])
            self.assertEqual(code, 0)
            written = read_json(root / "out" / "mission_targets_mix.json")
            self.assertEqual(len(written["targets"]), 3)
            self.assertEqual(normalize_ncs_targets(written)[0]["material_mix"]["allowed_material_types"], ["log"])
            csv_text = (root / "out" / "material_mix.csv").read_text(encoding="utf-8-sig")
            self.assertIn("쓸 수 있는 형태", csv_text.splitlines()[0])
            self.assertEqual(len(csv_text.splitlines()), 4)
            self.assertIn("counts", read_json(root / "out" / "material_mix_summary.json"))


def target(difficulty: str, exec_job_id: str = "exec_001", **extra) -> dict:
    return {"job_cd": JOB_CD, "exec_job_id": exec_job_id, "unit_key": UNIT_KEY, "difficulty": difficulty, **extra}


def mix(*kinds: str, **extra) -> dict:
    return {"rule_version": mp.MIX_RULE_VERSION, "allowed_material_types": list(kinds), "reason": "시험용 배정", **extra}


class NormalizeWithMixTest(unittest.TestCase):
    def test_keeps_the_assignment_only_when_present(self):
        items = [target("easy", material_mix=mix("log")), target("hard", note="x")]
        normalized = normalize_ncs_targets(items)
        self.assertEqual(normalized[0]["material_mix"]["allowed_material_types"], ["log"])
        self.assertEqual(set(normalized[1]), {"job_cd", "exec_job_id", "unit_key", "difficulty"})
        # 받은 기록을 고쳐도 정규화된 쪽은 바뀌지 않는다.
        items[0]["material_mix"]["allowed_material_types"].append("table")
        self.assertEqual(normalized[0]["material_mix"]["allowed_material_types"], ["log"])

    def test_rejects_bad_assignments(self):
        cases = {
            "non-empty allowed_material_types": mix(),
            "unknown material type": mix("log", "card"),
            "more than once": mix("log", "log"),
        }
        for message, bad in cases.items():
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    normalize_ncs_targets([target("easy", material_mix=bad)])
        with self.assertRaisesRegex(ValueError, "non-empty allowed_material_types"):
            normalize_ncs_targets([target("easy", material_mix=["log"])])

    def test_needs_two_stage_generation(self):
        with self.assertRaisesRegex(ValueError, "requires --two-stage-basis"):
            PilotRunner(use_ncs_background=True, ncs_targets=[target("easy", material_mix=mix("log"))])
        # 배정이 없으면 두 단계가 아니어도 전과 같이 받는다.
        PilotRunner(use_ncs_background=True, ncs_targets=[target("easy")])


@unittest.skipUnless(HAS_KNOW_DATA, "KNOW 원본(data/api_raw)이 없어 전체 실행을 건너뛴다")
class MixRunTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(shutil.rmtree, WORK, True)
        shutil.rmtree(WORK, True)
        (WORK / "ncs_jobs").mkdir(parents=True, exist_ok=True)
        units = [sample_unit(), {**sample_unit(), "exec_job_id": "exec_002"}]
        (WORK / "ncs_jobs" / f"{JOB_CD}.json").write_text(json.dumps({**sample_ncs_job(), "units": units}, ensure_ascii=False), encoding="utf-8")

    def runner(self, out: str, targets: list[dict], **options) -> PilotRunner:
        return PilotRunner(
            output_root=f"{WORK_RELATIVE}/{out}",
            concurrency=1,
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            two_stage_basis=True,
            ncs_targets=targets,
            **options,
        )

    @staticmethod
    def slot(summary: dict, difficulty: str) -> Path:
        return Path(summary["run_dir"]) / "jobs" / JOB_CD / difficulty

    def test_assignment_narrows_the_types_and_is_recorded(self):
        targets = [target("normal", material_mix=mix("email", "log")), target("hard", "exec_002", material_mix=mix("checklist", "chart", "schedule"))]
        summary = self.runner("mix", targets, force_mock=True).run()
        self.assertEqual((summary["saved_count"], summary["failed_count"]), (2, 0))
        for difficulty, kinds in (("normal", ["email", "log"]), ("hard", ["checklist", "chart", "schedule"])):
            with self.subTest(difficulty=difficulty):
                slot = self.slot(summary, difficulty)
                decisions = read_json(slot / "system_decisions.json")
                self.assertEqual(decisions["allowed_material_types"], kinds)
                trace = [item for item in decisions["decision_trace"] if item["step"] == "select_allowed_material_types"]
                self.assertEqual(trace[-1]["method"], "material_mix")
                self.assertEqual(trace[-1]["selected"], kinds)
                self.assertEqual(read_json(slot / "blueprint_request.json")["allowed_material_types"], kinds)
                self.assertEqual(read_json(slot / "material_mix.json")["allowed_material_types"], kinds)
                mission = read_json(slot / "mission_output.json")
                self.assertTrue({material["type"] for material in mission["mission"]["materials"]} <= set(kinds))
                rule_step = read_json(slot / "generation_basis.json")["chain"][6]
                self.assertEqual(rule_step["values"]["allowed_material_types"], kinds)
                self.assertEqual(rule_step["material_mix"]["decided_by"], "코드 (자료 형태 배정, 모델 호출 없음)")
                self.assertEqual([item["type"] for item in rule_step["material_mix"]["why"]], kinds)
                self.assertEqual(read_json(slot / "generation_basis.json")["artifacts"]["material_mix"], "material_mix.json")
        card = (Path(summary["run_dir"]) / "basis_cards" / f"{JOB_CD}_hard.html").read_text(encoding="utf-8")
        self.assertIn("자료 형태 배정", card)
        self.assertEqual(read_json(Path(summary["run_dir"]) / "pilot_config.json")["ncs_targets"][0]["material_mix"]["allowed_material_types"], ["email", "log"])

    def test_without_assignment_everything_is_as_before(self):
        plain = self.runner("plain", [target("normal")], force_mock=True).run()
        slot = self.slot(plain, "normal")
        decisions = read_json(slot / "system_decisions.json")
        self.assertEqual(decisions["allowed_material_types"], list(TWO_STAGE_MATERIAL_TYPES))
        self.assertEqual(decisions["decision_trace"][-2]["method"], "two_stage_types")
        self.assertFalse((slot / "material_mix.json").exists())
        basis = read_json(slot / "generation_basis.json")
        self.assertNotIn("material_mix", basis["chain"][6])
        self.assertEqual(set(basis["artifacts"]), {"source_pack", "blueprint", "mission"})
        self.assertNotIn("자료 형태 배정", (Path(plain["run_dir"]) / "basis_cards" / f"{JOB_CD}_normal.html").read_text(encoding="utf-8"))
        # 같은 대상을 --ncs-unit으로 돌린 것과 요청·산출물이 글자까지 같다.
        old = PilotRunner(
            output_root=f"{WORK_RELATIVE}/old",
            concurrency=1,
            use_ncs_background=True,
            ncs_root=f"{WORK_RELATIVE}/ncs_jobs",
            two_stage_basis=True,
            target_job_codes=[JOB_CD],
            target_difficulty_codes=["normal"],
            ncs_units={JOB_CD: UNIT_KEY},
            force_mock=True,
        ).run()
        for name in ("blueprint_request.json", "source_pack.json", "system_decisions.json", "llm_input_package.json", "mission_output.json"):
            self.assertEqual((slot / name).read_bytes(), (self.slot(old, "normal") / name).read_bytes(), name)


class CardWithoutRunTest(unittest.TestCase):
    def test_rule_step_line_only_when_assigned(self):
        exporter = BasisCardExporter()
        step = {"step": 7, "title": "난이도 규칙", "kind": "rule", "decided_by": "시스템 결정", "values": {"allowed_material_types": ["log"]}}
        self.assertNotIn("자료 형태 배정", exporter._render_step(step, []))
        step["material_mix"] = {"allowed_material_types": ["log"], "decided_by": "코드", "rule_version": "mix-v1", "reason": "이유 <b>"}
        html = exporter._render_step(step, [])
        self.assertIn("자료 형태 배정", html)
        self.assertIn("이유 &lt;b&gt;", html)


if __name__ == "__main__":
    unittest.main()
