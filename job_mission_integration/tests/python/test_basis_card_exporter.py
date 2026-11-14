# 근거 카드(HTML)를 확인한다: 단계 표시, 낱말 강조, 이스케이프, 독립 파일, 내보내기.

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from basis_fixtures import CRITERION, JOB_CD, sample_blueprint, sample_decisions, sample_mission, sample_pack, sample_unit, sample_unit_v03

from src.mission_generation.basis_card_exporter import BasisCardExporter
from src.mission_generation.blueprint_checker import BlueprintChecker, MissionBasisChecker
from src.mission_generation.generation_basis import GenerationBasisAssembler

OK_MAP = {"rubric": [{"rubric_index": 0, "evaluation_basis_index": 0}, {"rubric_index": 1, "evaluation_basis_index": 0}]}
CALL = {"provider": "anthropic", "model": "claude-opus-5-5", "reasoning_effort": "medium"}


def build_basis(folder: Path, mission: dict, unit: dict | None = None) -> dict:
    pack = sample_pack(folder, unit=unit)
    blueprint, decisions = sample_blueprint(), sample_decisions()
    return GenerationBasisAssembler().assemble(
        final_mission=mission,
        source_pack=pack,
        blueprint=blueprint,
        blueprint_check=BlueprintChecker().check(blueprint=blueprint, source_pack=pack, system_decisions=decisions),
        basis_map=OK_MAP,
        basis_check=MissionBasisChecker().check(mission_draft=mission, basis_map=OK_MAP, blueprint=blueprint),
        system_decisions=decisions,
        blueprint_call=CALL,
        writer_call=CALL,
        artifacts={"source_pack": "source_pack.json", "blueprint": "mission_blueprint_attempt_0.json", "mission": "mission_output.json"},
    )


class BasisCardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)

    def card(self, mission: dict | None = None, unit: dict | None = None) -> str:
        mission = sample_mission() if mission is None else mission
        return BasisCardExporter().render_card(mission, build_basis(self.folder, mission, unit))

    @staticmethod
    def step3(html: str) -> str:
        return re.search(r'<article class="step[^"]*" data-step="3">.*?</article>', html, re.S).group(0)

    def test_step3_shows_phrase_verdict_and_criteria(self):
        part = self.step3(self.card(unit=sample_unit_v03()))
        for needle in (
            "구절",
            "세관 신고서류를 작성",
            "판정",
            "확정",
            "수출신고서 항목 작성이 신고서류 작성 그대로다",
            'data-piece="N.c.2.1"',
            "수출신고서 작성하기",
        ):
            self.assertIn(needle, part)

    def test_step4_marks_criteria_from_the_link_basis(self):
        html = self.card(unit=sample_unit_v03())
        part = re.search(r'<article class="step[^"]*" data-step="4">.*?</article>', html, re.S).group(0)
        self.assertIn("연결 판단이 근거로 든 수행준거", part)
        old = re.search(r'<article class="step[^"]*" data-step="4">.*?</article>', self.card(), re.S).group(0)
        self.assertNotIn("연결 판단이 근거로", old)

    def test_step3_of_old_link_shows_no_phrase_or_verdict(self):
        part = self.step3(self.card())
        self.assertNotIn("구절", part)
        self.assertNotIn("판정", part)
        self.assertNotIn('data-piece="N.c.', part)

    def test_step3_phrase_is_escaped(self):
        unit = sample_unit_v03()
        unit["link"]["phrase"] = "<b>세관</b>"
        part = self.step3(self.card(unit=unit))
        self.assertIn("&lt;b&gt;세관&lt;/b&gt;", part)
        self.assertNotIn("<b>세관</b>", part)

    def test_card_shows_mission_and_seven_steps(self):
        html = self.card()
        self.assertTrue(html.startswith("<!doctype html>"))
        self.assertIn('<html lang="ko">', html)
        self.assertIn('<meta charset="utf-8">', html)
        self.assertIn('<section id="mission">', html)
        self.assertIn('<section id="basis">', html)
        self.assertEqual(html.count('<article class="step'), 7)
        self.assertEqual(re.findall(r'data-step="(\d)"', html), list("1234567"))
        for label in ("데이터", "연결 판단", "AI 판단", "규칙"):
            self.assertIn(f'<span class="tag">{label}</span>', html)
        for kind in ("kind-data", "kind-link_decision", "kind-ai_decision", "kind-rule"):
            self.assertIn(kind, html)
        self.assertIn('data-piece="N.c.2.1"', html)
        self.assertIn('data-piece="K.exec.1"', html)
        self.assertIn("수출신고서 초안 확인하기", html)
        self.assertIn("가상 회사 구름나루의 무역사무 인턴", html)
        self.assertIn("<table", html)
        self.assertIn("NCS–KECO 연계표", html)
        self.assertIn("claude-opus-5-5", html)

    def test_design_step_shows_why_each_type_was_chosen(self):
        html = self.card()
        part = re.search(r'<article class="step[^"]*" data-step="5">.*?</article>', html, re.S).group(0)
        self.assertIn("형태", part)
        self.assertIn("수출신고서의 구성항목을 항목별로 적은 서식이라 표로 보인다", part)

    def test_borrowed_terms_are_marked_on_both_sides(self):
        html = self.card()
        mission_part, basis_part = html.split('<section id="basis">')
        mark = '<mark class="term term-1">신고자 상호</mark>'
        self.assertIn(mark, mission_part)
        self.assertIn(mark, basis_part)
        self.assertIn('<mark class="term term-2">수출신고가격</mark>', mission_part)
        self.assertIn('<mark class="term term-3">환급신청인</mark>', basis_part)

    def test_term_is_marked_in_source_despite_spacing(self):
        unit = sample_unit()
        unit["elements"][1]["criteria"] = [CRITERION.replace("신고자 상호", "신고자  상호")]
        html = self.card(unit=unit)
        self.assertIn('<mark class="term term-1">신고자  상호</mark>', html.split('<section id="basis">')[1])

    def test_special_characters_are_escaped(self):
        mission = sample_mission()
        mission["mission"]["title"] = '<script>alert(1)</script> & "따옴표"'
        unit = sample_unit()
        unit["elements"][1]["criteria"] = [CRITERION + " A<B & C"]
        html = self.card(mission=mission, unit=unit)
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;따옴표&quot;", html)
        self.assertIn("A&lt;B &amp; C", html)
        self.assertIn('<mark class="term term-1">신고자 상호</mark>', html)  # 이스케이프와 강조가 함께 된다

    def test_card_is_self_contained(self):
        html = self.card()
        for needle in ("<script", "http://", "https://", "<link", "@import", "url("):
            self.assertNotIn(needle, html)
        self.assertIn("<style>", html)

    def test_long_unbroken_text_wraps_inside_its_box(self):
        # 파일 경로처럼 띄어쓰기 없는 긴 글자가 상자 밖으로 넘치지 않게 한다(브라우저에서 가로 스크롤이 생겼다).
        style = self.card().split("<style>")[1].split("</style>")[0]
        self.assertRegex(style, r"blockquote[^}]*overflow-wrap: anywhere")
        self.assertRegex(style, r"\.by[^}]*overflow-wrap: anywhere")

    def test_rubric_and_expected_answer_are_only_inside_details(self):
        html = self.card()
        # 자료의 쓰임("항목 대조")은 학습자도 보므로 밖에 있어도 된다. 채점 기준에만 있는 글자로 확인한다.
        rubric_only = ("140만 원이지만", "수출신고가격이 다르다는 점을 짚는다.", "수정 내용 전달")
        outside = re.sub(r"<details.*?</details>", "", html, flags=re.S)
        for text in rubric_only:
            self.assertIn(text, html)
            self.assertNotIn(text, outside)

    def test_warnings_listed(self):
        html = self.card()
        warnings = re.search(r'<ul class="warnings">(.*?)</ul>', html, flags=re.S)
        self.assertIsNotNone(warnings)
        self.assertIn("BP_COVERAGE_PARTIAL", warnings.group(1))

    def test_learner_visible_notes_are_shown(self):
        # 앱은 자료 설명, 자료 쓰임, 유의 사항을 학습자에게 보여 준다. 카드에서 빠지면 미션을 풀 수 없어 보인다
        # (실제 예: 표 자료의 설명에 '고객 요청 메모'가 들어 있었다).
        mission = sample_mission()
        mission["mission"]["materials"][0]["description"] = "[고객 요청 메모] 신고자 상호를 먼저 확인"
        mission["mission"]["materials"][0]["used_for"] = "초안과 맞춰 보는 데 <사용>"
        mission["mission"]["scenario"]["constraints"] = ["제공된 자료만 사용하세요.", "금액은 원 단위"]
        html = self.card(mission=mission)
        mission_part = html.split('<section id="basis">')[0]
        outside = re.sub(r"<details.*?</details>", "", mission_part, flags=re.S)
        self.assertIn('[고객 요청 메모] <mark class="term term-1">신고자 상호</mark>를 먼저 확인', outside)
        self.assertIn("초안과 맞춰 보는 데 &lt;사용&gt;", outside)
        self.assertIn("<h4>유의 사항</h4>", outside)
        self.assertIn("<li>제공된 자료만 사용하세요.</li>", outside)
        self.assertIn("<li>금액은 원 단위</li>", outside)

    def test_mission_without_notes_has_no_empty_blocks(self):
        mission = sample_mission()
        for material in mission["mission"]["materials"]:
            material.pop("description", None)
            material.pop("used_for", None)
        mission["mission"]["scenario"].pop("constraints", None)
        html = self.card(mission=mission)
        self.assertNotIn("유의 사항", html)
        self.assertNotIn('class="mat-note"', html)

    def test_non_table_material_does_not_break_the_card(self):
        mission = sample_mission()
        mission["mission"]["materials"][1] = {
            "material_id": "mat_002",
            "type": "chart",
            "title": "주간 신고 건수",
            "description": "설명",
            "data": {"chart_type": "bar", "x_axis": ["1주", "2주"], "y_axis": "건", "series": [{"name": "건수", "values": [3, 5]}]},
        }
        html = self.card(mission=mission)
        self.assertIn("주간 신고 건수", html)
        self.assertEqual(html.count('<article class="step'), 7)


def shaped(kind: str, data: dict) -> dict:
    return {"material_id": "mat_x", "type": kind, "title": f"{kind} 자료", "description": "설명", "used_for": "쓰임", "data": data}


# 형태마다 앱 화면에 보이는 내용. 근거 카드도 JSON 원문이 아니라 같은 내용을 읽기 쉽게 보여 줘야 한다.
SHAPED_MATERIALS = {
    "email": (
        {"thread": [{"from": "한솔상사 김대리", "to": "상품팀", "subject": "견적 요청", "body": "30명 워크숍 견적을 부탁드립니다."}]},
        ["보낸 사람", "한솔상사 김대리", "받는 사람", "상품팀", "제목", "견적 요청", "30명 워크숍 견적을 부탁드립니다."],
    ),
    "memo": (
        {"author": "상품팀장", "items": ["20명 이상은 10% 할인한다.", "견적은 14일 동안 유효하다."]},
        ["작성", "상품팀장", "<li>20명 이상은 10% 할인한다.</li>", "<li>견적은 14일 동안 유효하다.</li>"],
    ),
    "checklist": (
        {
            "items": [
                {"label": "인원이 요청과 같다", "status": "checked", "importance": "high"},
                {"label": "회의실 시간을 적었다", "status": "unchecked", "importance": "normal"},
                {"label": "유효 기간을 적었다", "status": "issue", "importance": "normal"},
            ]
        },
        ["인원이 요청과 같다", "확인 완료", "확인 필요", "주의 필요", "중요"],
    ),
    "log": (
        {"entries": [{"time": "09-02 10:10", "actor": "박사원", "event": "문의 접수", "note": "인원 30명"}]},
        ["<th>시각</th>", "09-02 10:10", "박사원", "문의 접수", "인원 30명"],
    ),
    "schedule": (
        {"items": [{"period": "9월 2주", "task": "견적서 발송", "constraint": "발행 후 14일 유효"}]},
        ["<th>기간</th>", "9월 2주", "견적서 발송", "발행 후 14일 유효"],
    ),
    "card": (
        {"cards": [{"title": "솔바람 리조트", "attributes": {"strength": "회의실 50석", "weakness": "1인 14만 원", "fit": "30명 단체"}}]},
        ["솔바람 리조트", "<th>강점</th>", "<th>약점</th>", "<th>적합도</th>", "회의실 50석", "1인 14만 원", "30명 단체"],
    ),
    "chart": (
        {
            "chart_type": "bar",
            "x_axis": {"label": "월", "values": ["7월", "8월"]},
            "y_axis": {"label": "예약 건수", "unit": "건"},
            "series": [{"name": "작년", "values": [12, 18]}, {"name": "올해", "values": [14, 16]}],
        },
        ["막대", "예약 건수", "(건)", "<th>월</th>", "<th>작년</th>", "<th>올해</th>", "<td>7월</td>", "<td>12</td>", "<td>16</td>"],
    ),
}


class MaterialShapeTest(unittest.TestCase):
    """표가 아닌 일곱 형태도 근거 카드에서 읽을 수 있게 보인다."""

    @staticmethod
    def render(material: dict, terms: list[str] | None = None) -> str:
        return BasisCardExporter()._render_material(material, terms or [])

    def test_each_shape_is_readable_without_raw_json(self):
        for kind, (data, needles) in SHAPED_MATERIALS.items():
            with self.subTest(kind=kind):
                html = self.render(shaped(kind, data))
                self.assertNotIn("<pre>", html)
                self.assertNotIn("&quot;", html)  # JSON 따옴표가 그대로 나오지 않는다
                for needle in needles:
                    self.assertIn(needle, html)
                self.assertIn(f"({kind})", html)

    def test_borrowed_terms_are_marked_inside_every_shape(self):
        cases = {
            "email": "견적 요청",
            "memo": "10% 할인",
            "checklist": "회의실 시간",
            "log": "문의 접수",
            "schedule": "견적서 발송",
            "card": "회의실 50석",
            "chart": "작년",
        }
        for kind, term in cases.items():
            with self.subTest(kind=kind):
                html = self.render(shaped(kind, SHAPED_MATERIALS[kind][0]), [term])
                self.assertIn(f'<mark class="term term-1">{term}</mark>', html)

    def test_values_are_escaped_in_every_shape(self):
        risky = {
            "email": {"thread": [{"from": "<b>a</b>", "to": "t", "subject": "s", "body": "x & y"}]},
            "memo": {"author": "<b>a</b>", "items": ["x & y"]},
            "checklist": {"items": [{"label": "<b>a</b>", "status": "checked", "importance": "x & y"}]},
            "log": {"entries": [{"time": "t", "actor": "<b>a</b>", "event": "x & y", "note": ""}]},
            "schedule": {"items": [{"period": "<b>a</b>", "task": "x & y", "constraint": ""}]},
            "card": {"cards": [{"title": "<b>a</b>", "attributes": {"strength": "x & y", "weakness": "", "fit": ""}}]},
            "chart": {"chart_type": "line", "x_axis": {"label": "<b>a</b>", "values": ["x & y"]}, "y_axis": {"label": "l", "unit": "u"}, "series": [{"name": "n", "values": [1]}]},
        }
        for kind, data in risky.items():
            with self.subTest(kind=kind):
                html = self.render(shaped(kind, data))
                self.assertNotIn("<b>a</b>", html)
                self.assertIn("&lt;b&gt;a&lt;/b&gt;", html)
                self.assertIn("x &amp; y", html)

    def test_unexpected_data_falls_back_to_raw_text(self):
        # 형식에서 벗어난 자료(옛 산출물 등)는 깨지지 않고 내용을 그대로 보여 준다.
        for kind in SHAPED_MATERIALS:
            for data in ({}, {"items": "글자"}, {"thread": [1, 2]}, {"cards": [{"title": "a"}]}, {"x_axis": ["1주"], "series": [{"values": [1]}]}):
                with self.subTest(kind=kind, data=data):
                    html = self.render(shaped(kind, data))
                    self.assertIn(f"{kind} 자료", html)

    def test_checklist_shows_the_mark_the_learner_sees(self):
        # 앱은 상태를 "확인 완료 / 확인 필요 / 주의 필요"로 보여 준다. 답을 알려 주는 표시인지 카드에서 볼 수 있어야 한다.
        html = self.render(shaped("checklist", SHAPED_MATERIALS["checklist"][0]))
        rows = re.findall(r"<tr>(.*?)</tr>", html, re.S)
        self.assertIn("주의 필요", next(row for row in rows if "유효 기간을 적었다" in row))
        self.assertIn("확인 완료", next(row for row in rows if "인원이 요청과 같다" in row))


class BasisCardExportTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.run_dir = Path(tmp.name) / "run"
        self.slot = self.run_dir / "jobs" / JOB_CD / "normal"
        self.slot.mkdir(parents=True)

    def write_slot(self, with_mission: bool = True):
        mission = sample_mission()
        (self.slot / "generation_basis.json").write_text(
            json.dumps(build_basis(self.run_dir, mission), ensure_ascii=False), encoding="utf-8"
        )
        if with_mission:
            (self.slot / "mission_output.json").write_text(json.dumps(mission, ensure_ascii=False), encoding="utf-8")

    def test_export_writes_cards_and_index(self):
        self.write_slot()
        paths = BasisCardExporter().export(self.run_dir)
        self.assertEqual(sorted(p.name for p in paths), ["K000000918_normal.html", "index.html"])
        self.assertTrue(all(p.parent == self.run_dir / "basis_cards" for p in paths))
        index = (self.run_dir / "basis_cards" / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="K000000918_normal.html"', index)
        self.assertIn("수출신고서 초안 확인하기", index)
        card = (self.run_dir / "basis_cards" / "K000000918_normal.html").read_text(encoding="utf-8")
        self.assertEqual(card.count('<article class="step'), 7)

    def test_export_without_basis_writes_nothing(self):
        self.assertEqual(BasisCardExporter().export(self.run_dir), [])
        self.assertFalse((self.run_dir / "basis_cards").exists())

    def test_basis_without_mission_file_is_skipped(self):
        self.write_slot(with_mission=False)
        self.assertEqual(BasisCardExporter().export(self.run_dir), [])
        self.assertFalse((self.run_dir / "basis_cards").exists())


if __name__ == "__main__":
    unittest.main()
