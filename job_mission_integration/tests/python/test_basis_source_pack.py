# 근거 자료 묶음: 조각 번호, 원문 대조, 작성 단계용 프로필 줄이기를 확인한다.

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from basis_fixtures import (
    CRITERION,
    EXEC_TEXT,
    JOB_CD,
    SCRATCH_ROOT,
    UNIT_KEY,
    sample_ncs_job,
    sample_pack,
    sample_profile,
    sample_unit,
    sample_unit_v03,
)

from src.mission_generation.basis_source_pack import (
    contains_verbatim,
    numbered_criteria,
    pieces_by_id,
    prompt_pieces,
    squash,
    writer_job_profile,
)
from src.mission_generation.ncs_background_loader import NcsBackgroundLoader


class SourcePackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.pack = sample_pack(self.folder)
        self.by = pieces_by_id(self.pack)

    def test_header(self):
        self.assertEqual(self.pack["schema_version"], "basis_source_pack.v1")
        self.assertEqual((self.pack["job_cd"], self.pack["exec_job_id"]), (JOB_CD, "exec_001"))
        self.assertEqual((self.pack["target_exec_ref"], self.pack["unit_key"]), ("K.exec.1", UNIT_KEY))
        self.assertIn("NCS–KECO 연계표", self.pack["link_table"]["label"])
        self.assertEqual(self.pack["know_source_root"], "data/api_raw")
        self.assertEqual(self.pack["warnings"], [])

    def test_piece_ids_and_text(self):
        by = self.by
        self.assertEqual(by["K.exec.1"]["text"], EXEC_TEXT)
        self.assertEqual(by["K.exec.1"]["locator"], {"file": f"{JOB_CD}/dtlGb_2.xml", "field": "jobsDo.execJob", "index": 1})
        self.assertEqual(by["N.c.2.1"]["text"], CRITERION)  # 원문 그대로(이중 공백 유지)
        self.assertEqual(by["N.c.2.1"]["meta"]["element_name"], "수출신고서 작성하기")
        self.assertEqual(by["N.c.1.1"]["kind"], "ncs_criterion")
        self.assertEqual(by["K.abil.2"]["text"], "읽고 이해하기")
        self.assertEqual(by["K.abil.2"]["meta"]["score"], 90)
        self.assertEqual(by["K.act.2"]["text"], "정보 처리")
        self.assertEqual(by["K.know.1"]["text"], "운송")
        self.assertEqual(by["N.eval.3"]["text"], "수출신고서 작성능력")
        self.assertEqual(by["N.doc.2"]["text"], "관세법")
        self.assertEqual(by["N.con.1"]["kind"], "ncs_consideration")
        self.assertEqual(by["N.unit"]["text"], "수출통관")
        self.assertEqual(by["N.unit"]["meta"]["ncs_cl_cd"], "0204030210_24v3")
        self.assertEqual(by["N.unit"]["meta"]["level"], 3)
        self.assertEqual(by["N.duty"]["text"], "수출입관리")
        self.assertEqual(by["K.sum"]["kind"], "know_summary")
        self.assertNotIn("K.exec.2", by)  # 대상 문장만 넣는다
        self.assertFalse(any(piece_id.startswith("K.env") for piece_id in by))  # 근무 환경 항목은 넣지 않는다

    def test_link_rows_only_for_job_keco(self):
        self.assertEqual([p["id"] for p in self.pack["pieces"] if p["kind"] == "link_row"], ["L.1", "L.2"])
        self.assertEqual(self.by["L.1"]["text"], "0281 무역 사무원 ↔ 02040302 수출입관리")
        self.assertTrue(self.by["L.1"]["meta"]["matches_unit_duty"])
        self.assertFalse(self.by["L.2"]["meta"]["matches_unit_duty"])
        self.assertEqual(self.by["K.keco"]["text"], "0281 무역 사무원")

    def test_sentence_unit_link_piece(self):
        link = self.by["M.1"]
        self.assertEqual(link["kind"], "sentence_unit_link")
        self.assertIn("수출통관의 서류작성", link["text"])
        self.assertEqual((link["meta"]["match"], link["meta"]["criteria"]), ("직접", "v0.1"))

    def test_record_only_pieces_are_not_in_prompt(self):
        self.assertEqual({p["id"] for p in self.pack["pieces"] if not p["in_prompt"]}, {"K.keco", "L.1", "L.2", "M.1"})
        prompt_ids = [p["id"] for p in prompt_pieces(self.pack)]
        self.assertIn("N.c.2.1", prompt_ids)
        self.assertTrue({"K.keco", "L.1", "L.2", "M.1"}.isdisjoint(prompt_ids))
        self.assertEqual(set(prompt_pieces(self.pack)[0]), {"id", "kind", "text", "meta"})

    def test_old_format_without_link_and_keco_warns_and_continues(self):
        unit = sample_unit()
        del unit["link"]
        ncs_job = sample_ncs_job()
        del ncs_job["keco"]
        pack = sample_pack(self.folder, unit=unit, ncs_job=ncs_job)
        self.assertEqual(
            {w["code"] for w in pack["warnings"]},
            {"SP_LINK_REASON_MISSING", "SP_KECO_MISSING", "SP_LINK_ROW_MISSING"},
        )
        by = pieces_by_id(pack)
        self.assertNotIn("M.1", by)
        self.assertNotIn("K.keco", by)
        self.assertIn("N.c.2.1", by)

    def test_numbered_criteria_matches_piece_ids(self):
        numbers = [item["number"] for item in numbered_criteria(sample_unit())]
        self.assertEqual(numbers, ["1.1", "2.1"])
        self.assertEqual([f"N.c.{n}" for n in numbers], [p["id"] for p in self.pack["pieces"] if p["kind"] == "ncs_criterion"])
        second = numbered_criteria(sample_unit())[1]
        self.assertEqual(
            (second["element_no"], second["criterion_no"], second["element_name"], second["text"]),
            (2, 1, "수출신고서 작성하기", CRITERION),
        )

    def test_numbered_criteria_falls_back_to_position(self):
        unit = sample_unit()
        unit["elements"][1]["no"] = "둘"
        self.assertEqual([item["number"] for item in numbered_criteria(unit)], ["1.1", "2.1"])
        self.assertEqual(numbered_criteria({"elements": [{"name": "빈 요소"}]}), [])

    def test_link_phrase_and_refs_go_into_m1(self):
        pack = sample_pack(self.folder, unit=sample_unit_v03())
        link = pieces_by_id(pack)["M.1"]
        meta = link["meta"]
        self.assertEqual((meta["phrase"], meta["verdict"], meta["criteria_refs"]), ("세관 신고서류를 작성", "확정", ["2.1"]))
        self.assertEqual(meta["verdict_reason"], "수출신고서 항목 작성이 신고서류 작성 그대로다")
        self.assertEqual((meta["match"], meta["criteria"]), ("직접", "v0.3"))
        self.assertFalse(link["in_prompt"])
        self.assertEqual(pack["warnings"], [])

    def test_old_link_keeps_the_same_meta_keys(self):
        self.assertEqual(set(self.by["M.1"]["meta"]), {"match", "judged_by", "criteria", "judged_at"})

    def test_unknown_criteria_ref_warns(self):
        unit = sample_unit_v03()
        unit["link"]["criteria_refs"] = ["2.1", "9.9"]
        warnings = sample_pack(self.folder, unit=unit)["warnings"]
        self.assertEqual([w["code"] for w in warnings], ["SP_LINK_CRITERIA_REF_UNKNOWN"])
        self.assertIn("9.9", warnings[0]["message"])

    def test_keco_falls_back_to_know_xml(self):
        raw = self.folder / "api_raw" / JOB_CD
        raw.mkdir(parents=True)
        (raw / "dtlGb_3.xml").write_text(
            "<root><kecoCd>0281</kecoCd><kecoNm>무역 사무원</kecoNm></root>", encoding="utf-8"
        )
        ncs_job = sample_ncs_job()
        del ncs_job["keco"]
        pack = sample_pack(self.folder, ncs_job=ncs_job)
        by = pieces_by_id(pack)
        self.assertEqual(by["K.keco"]["text"], "0281 무역 사무원")
        self.assertEqual(by["K.keco"]["locator"]["file"], f"{JOB_CD}/dtlGb_3.xml")
        self.assertEqual(pack["warnings"], [])

    def test_unknown_exec_job_raises(self):
        unit = sample_unit()
        with self.assertRaisesRegex(ValueError, "exec_999"):
            from src.mission_generation.basis_source_pack import SourcePackBuilder

            SourcePackBuilder(link_csv=self.folder / "ncs_keco_link.csv").build(
                job_profile=sample_profile(), ncs_job=sample_ncs_job(), unit=unit, exec_job_id="exec_999"
            )


class VerbatimTest(unittest.TestCase):
    def test_squash_removes_all_whitespace(self):
        self.assertEqual(squash(" 가 나\n다\t라 "), "가나다라")
        self.assertEqual(squash(None), "")

    def test_contains_verbatim_ignores_whitespace_differences(self):
        self.assertTrue(contains_verbatim(CRITERION, "구성항목에 따라 신고자 상호"))  # 원문은 이중 공백
        self.assertTrue(contains_verbatim("환급\n신청인", "환급신청인"))
        self.assertTrue(contains_verbatim(EXEC_TEXT, "세관  신고서류를\n작성"))
        self.assertFalse(contains_verbatim(CRITERION, ""))
        self.assertFalse(contains_verbatim(CRITERION, "   "))
        self.assertFalse(contains_verbatim(CRITERION, "수입신고서"))
        self.assertFalse(contains_verbatim(None, "신고"))


class WriterProfileTest(unittest.TestCase):
    def test_writer_job_profile_keeps_only_target_and_chosen_evidence(self):
        profile = writer_job_profile(sample_profile(), "exec_001", ["읽고 이해하기"])
        self.assertEqual([e["exec_job_id"] for e in profile["work"]["exec_jobs"]], ["exec_001"])
        self.assertEqual([i["name"] for i in profile["evidence"]["abilities"]], ["읽고 이해하기"])
        self.assertEqual(profile["evidence"]["work_activities"], [])
        self.assertEqual(set(profile["evidence"]), {"work_activities", "abilities", "knowledge", "work_environment"})
        self.assertEqual(profile["job_identity"]["job_cd"], JOB_CD)
        self.assertNotIn("technical_context", profile)

    def test_writer_job_profile_does_not_change_the_original(self):
        original = sample_profile()
        writer_job_profile(original, "exec_001", ["읽고 이해하기"])
        self.assertEqual(original, sample_profile())


class LoaderUnitRecordTest(unittest.TestCase):
    def setUp(self):
        self.root = SCRATCH_ROOT / "loader"
        self.root.mkdir(parents=True, exist_ok=True)
        self.addCleanup(shutil.rmtree, SCRATCH_ROOT, True)
        (self.root / f"{JOB_CD}.json").write_text(
            json.dumps({**sample_ncs_job(), "units": [sample_unit()]}, ensure_ascii=False), encoding="utf-8"
        )

    def test_loader_unit_record_and_load_unchanged(self):
        loader = NcsBackgroundLoader(root=self.root)
        record = loader.unit_record(JOB_CD, "normal", unit_key=UNIT_KEY)
        self.assertEqual(record["unit"]["link"]["match"], "직접")
        self.assertEqual(record["ncs_job"]["keco"]["code"], "0281")
        self.assertNotIn("units", record["ncs_job"])
        background = loader.load(JOB_CD, "normal", unit_key=UNIT_KEY)
        self.assertNotIn("link", background)
        self.assertNotIn("keco", background)

    def test_unit_record_is_none_when_missing(self):
        loader = NcsBackgroundLoader(root=self.root)
        self.assertIsNone(loader.unit_record(JOB_CD, "normal", unit_key="99999999:99"))
        self.assertIsNone(loader.unit_record("K999999999", "normal", unit_key=UNIT_KEY))


if __name__ == "__main__":
    unittest.main()
