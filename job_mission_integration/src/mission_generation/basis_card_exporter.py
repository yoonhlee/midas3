# 근거 카드: 미션 하나와 그 근거 기록(generation_basis.json)을 사람이 읽는 HTML 한 장으로 만든다.
#
# 외부 파일 없이 열리는 독립 문서다. 위에는 학습자가 보는 미션, 아래에는 근거 사슬 일곱 단계를 보여 준다.
# 원문에서 가져온 낱말은 미션 쪽과 원문 쪽에 같은 색으로 표시한다. 값에서 온 글자는 모두 이스케이프한다.

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

KIND_LABELS = {"data": "데이터", "link_decision": "연결 판단", "ai_decision": "AI 판단", "rule": "규칙"}
STEP_NUMBERS = "①②③④⑤⑥⑦⑧⑨"
TERM_COLOR_COUNT = 8
# 앱의 미션 화면이 학습자에게 보여 주는 낱말과 같게 맞춘다(app/components/missionScreens.js).
CHECK_MARKS = {"checked": "✓ 확인 완료", "unchecked": "○ 확인 필요", "issue": "! 주의 필요"}
CARD_LABELS = {"strength": "강점", "weakness": "약점", "fit": "적합도"}
CHART_KINDS = {"bar": "막대", "line": "꺾은선", "pie": "원"}

STYLE = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; background: #f4f5f7; color: #1f2933; line-height: 1.6; }
header { background: #1f3a5f; color: #fff; padding: 20px 28px; }
header h1 { margin: 0 0 4px; font-size: 22px; }
header .meta { margin: 0; font-size: 13px; opacity: 0.85; }
main { max-width: 980px; margin: 0 auto; padding: 20px 16px 48px; }
section { background: #fff; border: 1px solid #d9dee5; border-radius: 10px; padding: 18px 22px; margin-bottom: 20px; }
h2 { font-size: 18px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e4e8ee; }
h3 { font-size: 16px; margin: 0 0 6px; }
h4 { font-size: 14px; margin: 14px 0 6px; color: #33475b; }
p { margin: 6px 0; }
.label { display: inline-block; min-width: 3.5em; font-weight: 700; color: #52606d; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 14px; }
th, td { border: 1px solid #cfd6de; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #eef2f6; }
pre { background: #f6f8fa; border: 1px solid #d9dee5; border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 13px; white-space: pre-wrap; }
.legend { font-size: 13px; color: #52606d; }
.step { border-left: 6px solid #9aa5b1; background: #fbfcfd; border-radius: 6px; padding: 12px 16px; margin: 14px 0; }
.step.kind-data { border-left-color: #2f855a; }
.step.kind-link_decision { border-left-color: #b7791f; }
.step.kind-ai_decision { border-left-color: #2b6cb0; }
.step.kind-rule { border-left-color: #6b46c1; }
.num { font-size: 18px; margin-right: 4px; }
.tag { display: inline-block; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 10px; margin-left: 8px; background: #e4e8ee; color: #33475b; }
.kind-data .tag { background: #c6f6d5; color: #22543d; }
.kind-link_decision .tag { background: #feebc8; color: #7b341e; }
.kind-ai_decision .tag { background: #bee3f8; color: #2a4365; }
.kind-rule .tag { background: #e9d8fd; color: #44337a; }
.by { font-size: 13px; color: #52606d; overflow-wrap: anywhere; }
blockquote { margin: 8px 0; padding: 8px 12px; background: #fff; border: 1px solid #d9dee5; border-radius: 6px; overflow-wrap: anywhere; }
blockquote .pid { display: inline-block; font-family: Consolas, monospace; font-size: 12px; background: #1f3a5f; color: #fff; border-radius: 4px; padding: 0 6px; margin-right: 6px; }
blockquote cite { display: block; font-size: 12px; color: #7b8794; font-style: normal; margin-top: 4px; }
ul { margin: 6px 0; padding-left: 20px; }
.check-ok { color: #22543d; font-weight: 700; }
.check-no { color: #9b2c2c; font-weight: 700; }
.warnings li { color: #7b341e; }
.ok { color: #22543d; }
details { margin: 10px 0; border: 1px dashed #b8c2cc; border-radius: 6px; padding: 8px 12px; background: #fff; }
summary { cursor: pointer; font-weight: 700; color: #33475b; }
mark.term { padding: 0 2px; border-radius: 3px; }
mark.term-1 { background: #fff3a3; } mark.term-2 { background: #b8f2c5; } mark.term-3 { background: #b9e0ff; }
mark.term-4 { background: #ffd0b5; } mark.term-5 { background: #e3c8ff; } mark.term-6 { background: #ffc9de; }
mark.term-7 { background: #c8f0ee; } mark.term-8 { background: #dfe7a8; }
footer { font-size: 12px; color: #52606d; margin-top: 14px; }
.cards li { margin: 6px 0; }
.mat-note { margin: 2px 0 6px; font-size: 14px; color: #33475b; overflow-wrap: anywhere; }
.mat-note.use { font-size: 13px; color: #52606d; }
.mat-box { margin: 6px 0 12px; padding: 8px 12px; background: #f6f8fa; border: 1px solid #d9dee5; border-radius: 6px; font-size: 14px; overflow-wrap: anywhere; }
.mat-box .label { min-width: 5em; }
"""


def _esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


class BasisCardExporter:
    """실행 폴더의 근거 기록마다 근거 카드를 쓰고 목록 페이지를 만든다."""

    def export(self, run_dir: str | Path) -> list[Path]:
        """run_dir/jobs/*/*/generation_basis.json마다 카드를 쓴다. 쓴 파일 경로(목록 페이지 포함)를 돌려준다."""

        run_dir = Path(run_dir)
        cards: list[tuple[str, str, dict[str, Any], dict[str, Any]]] = []
        for basis_path in sorted(run_dir.glob("jobs/*/*/generation_basis.json")):
            mission_path = basis_path.with_name("mission_output.json")
            if not mission_path.exists():
                continue
            mission = json.loads(mission_path.read_text(encoding="utf-8"))
            basis = json.loads(basis_path.read_text(encoding="utf-8"))
            file_name = f"{basis_path.parent.parent.name}_{basis_path.parent.name}.html"
            cards.append((file_name, self.render_card(mission, basis), mission, basis))
        if not cards:
            return []
        out_dir = run_dir / "basis_cards"
        out_dir.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []
        for file_name, document, _mission, _basis in cards:
            path = out_dir / file_name
            path.write_text(document, encoding="utf-8")
            written.append(path)
        index_path = out_dir / "index.html"
        index_path.write_text(self._render_index(cards), encoding="utf-8")
        return [index_path] + written

    def render_card(self, mission: dict[str, Any], basis: dict[str, Any]) -> str:
        """미션과 근거 기록으로 완결된 HTML 문서를 만든다."""

        chain = _as_list(basis.get("chain"))
        terms = self._terms(chain)
        body = _as_dict(mission.get("mission"))
        title = body.get("title") or basis.get("mission_id") or "미션"
        job_name = _as_dict(mission.get("job_identity")).get("job_smcl_nm") or basis.get("job_cd") or ""
        difficulty = _as_dict(body.get("difficulty")).get("label") or basis.get("difficulty") or ""
        steps = "\n".join(self._render_step(step, terms) for step in chain)
        return (
            "<!doctype html>\n"
            '<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"<title>근거 카드 · {_esc(title)}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n"
            f'<header><h1>{_esc(title)}</h1><p class="meta">{_esc(job_name)} · {_esc(difficulty)} · {_esc(basis.get("mission_id"))}</p></header>\n'
            "<main>\n"
            f'<section id="mission">\n<h2>미션 (학습자가 보는 내용)</h2>\n{self._render_mission(mission, terms)}\n</section>\n'
            '<section id="basis">\n<h2>생성 근거</h2>\n'
            '<p class="legend">단계마다 종류를 표시한다. 데이터 = 코드가 조회한 원본, 연결 판단 = 하는 일 문장과 능력단위를 이은 판단, '
            "AI 판단 = 설계서와 미션을 쓴 모델의 판단, 규칙 = 난이도 규칙. 색이 칠해진 낱말은 원문에서 그대로 가져온 것이다.</p>\n"
            f"{self._render_process(basis)}\n{steps}\n{self._render_checks(basis)}\n{self._render_footer(basis)}\n</section>\n"
            "</main>\n</body>\n</html>\n"
        )

    # ── 낱말 강조 ─────────────────────────────────────────────

    @staticmethod
    def _terms(chain: list[Any]) -> list[str]:
        """설계서가 원문에서 가져오기로 한 낱말을 나온 순서대로, 중복 없이 모은다."""

        terms: list[str] = []
        for step in chain:
            for material in _as_list(_as_dict(step).get("materials")):
                for term in _as_list(_as_dict(material).get("borrowed_terms")):
                    word = _as_dict(term).get("term")
                    if isinstance(word, str) and word.strip() and word not in terms:
                        terms.append(word)
        return terms

    @staticmethod
    def _mark(text: Any, terms: list[str]) -> str:
        """글자를 이스케이프하면서 가져온 낱말을 <mark>로 감싼다. 낱말 안의 공백 차이는 무시한다."""

        text = "" if text is None else str(text)
        spans: list[tuple[int, int, int]] = []
        for number, term in enumerate(terms, start=1):
            compact = re.sub(r"\s+", "", term)
            if not compact:
                continue
            pattern = r"\s*".join(re.escape(char) for char in compact)
            for match in re.finditer(pattern, text):
                spans.append((match.start(), match.end(), number))
        spans.sort(key=lambda span: (span[0], -(span[1] - span[0])))
        parts: list[str] = []
        cursor = 0
        for start, end, number in spans:
            if start < cursor:
                continue  # 앞의 강조와 겹치면 건너뛴다
            color = (number - 1) % TERM_COLOR_COUNT + 1
            parts.append(html.escape(text[cursor:start]))
            parts.append(f'<mark class="term term-{color}">{html.escape(text[start:end])}</mark>')
            cursor = end
        parts.append(html.escape(text[cursor:]))
        return "".join(parts)

    # ── 미션 ───────────────────────────────────────────────────

    def _render_mission(self, mission: dict[str, Any], terms: list[str]) -> str:
        body = _as_dict(mission.get("mission"))
        scenario = _as_dict(body.get("scenario"))
        parts = [
            f'<p><span class="label">역할</span> {_esc(scenario.get("role"))}</p>',
            f'<p><span class="label">상황</span> {_esc(scenario.get("context"))}</p>',
            f'<p><span class="label">요청</span> {_esc(scenario.get("goal"))}</p>',
        ]
        # 앱이 학습자에게 보여 주는 유의 사항. 빠지면 계산 기준 같은 조건이 카드에서 사라진다.
        constraints = [item for item in _as_list(scenario.get("constraints")) if isinstance(item, str) and item.strip()]
        if constraints:
            parts.append("<h4>유의 사항</h4><ul>")
            parts.extend(f"<li>{_esc(item)}</li>" for item in constraints)
            parts.append("</ul>")
        parts.append("<h4>자료</h4>")
        for material in _as_list(body.get("materials")):
            parts.append(self._render_material(_as_dict(material), terms))
        parts.append("<h4>과제</h4><ol>")
        for task in _as_list(body.get("tasks")):
            parts.append(f"<li>{_esc(_as_dict(task).get('instruction'))}</li>")
        parts.append("</ol>")
        glossary = _as_list(scenario.get("glossary"))
        if glossary:
            parts.append("<h4>용어</h4><ul>")
            for entry in glossary:
                entry = _as_dict(entry)
                parts.append(f"<li><strong>{self._mark(entry.get('term'), terms)}</strong> – {_esc(entry.get('definition'))}</li>")
            parts.append("</ul>")
        evaluation = _as_dict(mission.get("evaluation"))
        parts.append("<details><summary>채점 기준과 기대 답 (펼쳐 보기)</summary>")
        parts.append("<h4>기대 답</h4><ul>")
        for insight in _as_list(evaluation.get("expected_insights")):
            parts.append(f"<li>{_esc(insight)}</li>")
        parts.append("</ul><h4>채점 기준</h4><ul>")
        for criterion in _as_list(evaluation.get("rubric")):
            criterion = _as_dict(criterion)
            parts.append(
                f"<li><strong>{_esc(criterion.get('criterion'))}</strong> ({_esc(criterion.get('points'))}점) – {_esc(criterion.get('description'))}</li>"
            )
        parts.append("</ul></details>")
        return "\n".join(parts)

    def _render_material(self, material: dict[str, Any], terms: list[str]) -> str:
        head = f"<p><strong>{_esc(material.get('title'))}</strong> <span class=\"by\">({_esc(material.get('type'))})</span></p>"
        # 자료 설명과 쓰임도 앱에서 학습자가 본다. 표에 못 담은 조건(예: 고객 요청 메모)이 설명에 들어가기도 한다.
        description, used_for = material.get("description"), material.get("used_for")
        if isinstance(description, str) and description.strip():
            head += f'<p class="mat-note">{self._mark(description, terms)}</p>'
        if isinstance(used_for, str) and used_for.strip():
            head += f'<p class="mat-note use">쓰임: {_esc(used_for)}</p>'
        data = _as_dict(material.get("data"))
        body = self._material_body(material.get("type"), data, terms)
        if body is None:
            # 형식에서 벗어난 자료는 내용을 그대로 보여 준다.
            body = f"<pre>{self._mark(json.dumps(data, ensure_ascii=False, indent=2), terms)}</pre>"
        return head + body

    def _grid(self, headers: list[Any], rows: list[list[Any]], terms: list[str]) -> str:
        head_cells = "".join(f"<th>{self._mark(header, terms)}</th>" for header in headers)
        body_rows = "".join("<tr>" + "".join(f"<td>{self._mark(cell, terms)}</td>" for cell in row) + "</tr>" for row in rows)
        return f"<table><thead><tr>{head_cells}</tr></thead><tbody>{body_rows}</tbody></table>"

    def _material_body(self, kind: Any, data: dict[str, Any], terms: list[str]) -> str | None:
        """자료 형태에 맞춰 학습자가 앱에서 보는 내용을 그린다. 형식에서 벗어나면 None을 돌려준다."""

        def dicts(key: str) -> list[dict[str, Any]] | None:
            items = data.get(key)
            if isinstance(items, list) and items and all(isinstance(item, dict) for item in items):
                return items
            return None

        if kind == "table":
            rows, columns = dicts("rows"), _as_list(data.get("columns"))
            if not rows or not columns:
                return None
            keys = [(_as_dict(c).get("key"), _as_dict(c).get("label")) if isinstance(c, dict) else (c, c) for c in columns]
            return self._grid(
                [label if label is not None else key for key, label in keys],
                [[row.get(key) for key, _label in keys] for row in rows],
                terms,
            )
        if kind == "email":
            thread = dicts("thread")
            if not thread:
                return None
            parts = []
            for message in thread:
                lines = "".join(
                    f'<p><span class="label">{label}</span> {self._mark(message.get(key), terms)}</p>'
                    for key, label in (("from", "보낸 사람"), ("to", "받는 사람"), ("subject", "제목"))
                    if message.get(key)
                )
                parts.append(f'<div class="mat-box">{lines}<p>{self._mark(message.get("body"), terms)}</p></div>')
            return "".join(parts)
        if kind == "memo":
            items = data.get("items")
            if not isinstance(items, list) or not items or not all(isinstance(item, str) for item in items):
                return None
            author = f'<p><span class="label">작성</span> {self._mark(data.get("author"), terms)}</p>' if data.get("author") else ""
            return f'<div class="mat-box">{author}<ul>{"".join(f"<li>{self._mark(item, terms)}</li>" for item in items)}</ul></div>'
        if kind == "checklist":
            items = dicts("items")
            if not items:
                return None
            # 앱은 상태를 아이콘과 이 낱말로 보여 주고, 중요도는 "high"일 때만 "중요"라고 표시한다.
            return self._grid(
                ["항목", "표시", "중요도"],
                [
                    [
                        item.get("label"),
                        CHECK_MARKS.get(item.get("status"), item.get("status")),
                        "중요" if item.get("importance") == "high" else item.get("importance"),
                    ]
                    for item in items
                ],
                terms,
            )
        if kind == "log":
            entries = dicts("entries")
            if not entries:
                return None
            return self._grid(
                ["시각", "누가", "무슨 일", "메모"],
                [[entry.get(key) for key in ("time", "actor", "event", "note")] for entry in entries],
                terms,
            )
        if kind == "schedule":
            items = dicts("items")
            if not items:
                return None
            return self._grid(["기간", "할 일", "조건"], [[item.get(key) for key in ("period", "task", "constraint")] for item in items], terms)
        if kind == "card":
            cards = dicts("cards")
            if not cards or not all(isinstance(card.get("attributes"), dict) for card in cards):
                return None
            keys: list[str] = []
            for card in cards:
                keys += [key for key in card["attributes"] if key not in keys]
            return self._grid(
                ["이름"] + [CARD_LABELS.get(key, key) for key in keys],
                [[card.get("title")] + [card["attributes"].get(key) for key in keys] for card in cards],
                terms,
            )
        if kind == "chart":
            x_axis, y_axis, series = data.get("x_axis"), _as_dict(data.get("y_axis")), dicts("series")
            if not isinstance(x_axis, dict) or not isinstance(x_axis.get("values"), list) or not series:
                return None
            if not all(isinstance(item.get("values"), list) for item in series):
                return None
            unit = f" ({_esc(y_axis.get('unit'))})" if y_axis.get("unit") else ""
            note = (
                f'<p class="mat-note use">차트 종류: {_esc(CHART_KINDS.get(data.get("chart_type"), data.get("chart_type")))}'
                f" · 세로축: {self._mark(y_axis.get('label'), terms)}{unit}</p>"
            )
            rows = [
                [x_value] + [item["values"][index] if index < len(item["values"]) else "" for item in series]
                for index, x_value in enumerate(x_axis["values"])
            ]
            return note + self._grid([x_axis.get("label") or "항목"] + [item.get("name") for item in series], rows, terms)
        return None

    # ── 근거 사슬 ───────────────────────────────────────────────

    def _render_step(self, step: Any, terms: list[str]) -> str:
        step = _as_dict(step)
        number = step.get("step") if isinstance(step.get("step"), int) else 0
        glyph = STEP_NUMBERS[number - 1] if 1 <= number <= len(STEP_NUMBERS) else str(number)
        kind = str(step.get("kind") or "")
        label = KIND_LABELS.get(kind, kind)
        parts = [
            f'<article class="step kind-{_esc(kind)}" data-step="{_esc(number)}">',
            f'<h3><span class="num">{glyph}</span>{_esc(step.get("title"))}<span class="tag">{_esc(label)}</span></h3>',
            f'<p class="by">정한 주체: {_esc(step.get("decided_by") or "기록 없음")}</p>',
        ]
        if number == 3:
            parts.append(
                f'<p><span class="label">연결</span> {_esc(step.get("match") or "기록 없음")} '
                f'<span class="by">(기준 {_esc(step.get("criteria") or "-")})</span></p>'
            )
            if step.get("phrase"):
                parts.append(f'<p><span class="label">구절</span> “{_esc(step.get("phrase"))}”</p>')
            parts.append(f'<p><span class="label">이유</span> {_esc(step.get("reason") or "연결 이유 기록 없음")}</p>')
        for source in _as_list(step.get("sources")):
            parts.append(self._render_piece(source, terms))
        if number == 3:
            # 2차 확인(수행준거를 보고 내린 판정)과 그 근거가 된 수행준거 원문. 없는 옛 기록에서는 아무것도 나오지 않는다.
            if step.get("verdict"):
                why = f' <span class="by">– {_esc(step.get("verdict_reason"))}</span>' if step.get("verdict_reason") else ""
                parts.append(f'<p><span class="label">판정</span> {_esc(step.get("verdict"))}{why}</p>')
            for ref in _as_list(step.get("criteria_refs")):
                ref = _as_dict(ref)
                text = ref.get("text") if ref.get("text") is not None else "(이 번호의 수행준거를 찾지 못함)"
                piece = {"id": ref.get("ref"), "text": text, "locator": {"능력단위요소": ref.get("element_name")}}
                parts.append(self._render_piece(piece, terms))
        link_table = _as_dict(step.get("link_table"))
        if link_table:
            parts.append(f'<p class="by">출처: {_esc(link_table.get("label"))} · {_esc(link_table.get("file"))}</p>')
        if number == 4:
            for item in _as_list(step.get("items")):
                item = _as_dict(item)
                piece = {"id": item.get("ref"), "text": item.get("text"), "locator": {"능력단위요소": item.get("element_name")}}
                parts.append(self._render_piece(piece, terms))
                parts.append(f'<p><span class="label">이유</span> {_esc(item.get("reason"))}</p>')
                if "in_link_basis" in item:
                    note = "연결 판단이 근거로 든 수행준거다." if item["in_link_basis"] else "연결 판단이 근거로 들지 않은 수행준거다."
                    parts.append(f'<p class="by">{note}</p>')
        if number == 5:
            parts.append(self._render_design(step, terms))
        if number == 6:
            parts.append(self._render_rubric_basis(step, terms))
        values = _as_dict(step.get("values"))
        if values:
            rows = "".join(f"<tr><th>{_esc(key)}</th><td>{_esc(json.dumps(value, ensure_ascii=False))}</td></tr>" for key, value in values.items())
            parts.append(f"<table><tbody>{rows}</tbody></table>")
        mix = _as_dict(step.get("material_mix"))
        if mix:
            # 자료 형태 배정(코드가 정함). 배정이 없는 기록에서는 아무것도 나오지 않는다.
            parts.append(
                f'<p><span class="label">자료 형태 배정</span> {_esc(", ".join(_as_list(mix.get("allowed_material_types"))))} '
                f'<span class="by">({_esc(mix.get("decided_by"))} · {_esc(mix.get("rule_version"))})</span></p>'
            )
            parts.append(f'<p><span class="label">이유</span> {_esc(mix.get("reason"))}</p>')
        parts.append("</article>")
        return "\n".join(parts)

    def _render_piece(self, piece: Any, terms: list[str]) -> str:
        piece = _as_dict(piece)
        locator = " · ".join(f"{key}={value}" for key, value in _as_dict(piece.get("locator")).items() if value not in (None, ""))
        cite = f"<cite>{_esc(locator)}</cite>" if locator else ""
        return (
            f'<blockquote data-piece="{_esc(piece.get("id"))}"><span class="pid">{_esc(piece.get("id"))}</span>'
            f"{self._mark(piece.get('text'), terms)}{cite}</blockquote>"
        )

    def _render_design(self, step: dict[str, Any], terms: list[str]) -> str:
        focus = _as_dict(step.get("focus"))
        coverage = {"full": "문장 전체", "partial": "문장의 일부"}.get(focus.get("coverage"), focus.get("coverage"))
        parts = [
            f'<p><span class="label">중심</span> “{_esc(focus.get("focus_phrase"))}” <span class="by">({_esc(coverage)})</span></p>',
        ]
        if focus.get("uncovered_note"):
            parts.append(f'<p><span class="label">제외</span> {_esc(focus.get("uncovered_note"))}</p>')
        parts.append(f'<p><span class="label">이유</span> {_esc(focus.get("reason"))}</p>')
        for material in _as_list(step.get("materials")):
            material = _as_dict(material)
            parts.append(
                f"<h4>자료 {_esc(material.get('slot'))} · {_esc(material.get('material_title'))} "
                f"<span class=\"by\">({_esc(material.get('type'))}, {_esc(material.get('role'))})</span></h4>"
            )
            if material.get("type_reason"):
                parts.append(f'<p><span class="label">형태</span> {_esc(material.get("type"))} <span class="by">– {_esc(material.get("type_reason"))}</span></p>')
            parts.append(f'<p><span class="label">계획</span> {_esc(material.get("content_plan"))}</p>')
            borrowed = _as_list(material.get("borrowed_terms"))
            if borrowed:
                parts.append("<ul>")
                for term in borrowed:
                    term = _as_dict(term)
                    parts.append(
                        f"<li>{self._mark(term.get('term'), terms)} ← {_esc(term.get('ref'))} · "
                        f"원문 {self._check(term.get('in_source'))} · 미션 {self._check(term.get('in_mission'))}</li>"
                    )
                parts.append("</ul>")
            for ref in _as_list(material.get("refs")):
                parts.append(self._render_piece(ref, terms))
        for task in _as_list(step.get("tasks")):
            task = _as_dict(task)
            parts.append(f"<h4>과제 {_esc(task.get('slot'))}</h4>")
            parts.append(f'<p><span class="label">방식</span> {_esc(task.get("action"))}</p>')
            parts.append(f'<p><span class="label">이유</span> {_esc(task.get("reason"))}</p>')
        glossary = _as_list(step.get("glossary"))
        if glossary:
            parts.append("<h4>풀이할 용어</h4><ul>")
            for term in glossary:
                term = _as_dict(term)
                parts.append(f"<li>{_esc(term.get('term'))} ← {_esc(term.get('ref'))} · 미션 용어 풀이 {self._check(term.get('in_mission'))}</li>")
            parts.append("</ul>")
        return "\n".join(parts)

    def _render_rubric_basis(self, step: dict[str, Any], terms: list[str]) -> str:
        """채점 기준이 드러나므로 접어 둔 영역에 넣는다."""

        parts = ["<details><summary>채점 기준별 근거 (펼쳐 보기)</summary>"]
        for item in _as_list(step.get("items")):
            item = _as_dict(item)
            parts.append(f"<h4>{_esc(item.get('criterion'))} ({_esc(item.get('points'))}점)</h4>")
            if item.get("evaluation_basis_index") is None:
                parts.append('<p class="check-no">설계서의 채점 근거와 짝이 없다.</p>')
                continue
            parts.append(f'<p><span class="label">확인</span> {_esc(item.get("what_to_check"))}</p>')
            parts.append(f'<p><span class="label">이유</span> {_esc(item.get("reason"))}</p>')
            for ref in _as_list(item.get("refs")) + _as_list(item.get("know_refs")):
                parts.append(self._render_piece(ref, terms))
        parts.append("</details>")
        return "\n".join(parts)

    @staticmethod
    def _check(value: Any) -> str:
        return '<span class="check-ok">✓</span>' if value else '<span class="check-no">✗</span>'

    def _render_checks(self, basis: dict[str, Any]) -> str:
        items = _as_list(_as_dict(basis.get("checks")).get("items"))
        if not items:
            return '<h4>검사 결과</h4><p class="ok">경고 없음</p>'
        rows = "".join(f"<li><strong>{_esc(_as_dict(i).get('code'))}</strong> {_esc(_as_dict(i).get('message'))}</li>" for i in items)
        return f'<h4>검사 결과 (경고 {len(items)}건)</h4><ul class="warnings">{rows}</ul>'

    @staticmethod
    def _render_process(basis: dict[str, Any]) -> str:
        """설계서를 다시 쓴 횟수와 미션을 수정한 횟수. 기록에 없으면(예전 기록) 아무것도 보이지 않는다."""

        process = basis.get("process")
        if not isinstance(process, dict):
            return ""
        return (
            f'<p class="by">설계서 다시 쓰기 {_esc(process.get("blueprint_attempt", 0))}회 · '
            f'미션 수정 {_esc(process.get("repair_count", 0))}회</p>'
        )

    def _render_footer(self, basis: dict[str, Any]) -> str:
        models = _as_dict(basis.get("models"))
        lines = []
        for name, label in (("blueprint", "설계"), ("writer", "작성")):
            info = _as_dict(models.get(name))
            fallback = " (다른 모델이 이어받음)" if info.get("fallback_used") else ""
            if info.get("provider") == "mock":
                lines.append(f"{label} mock (API 호출 없음)")
                continue
            output = {"strict": " · JSON 고정 출력", "prompted": " · 형식을 프롬프트로 지정(코드가 검증)"}.get(info.get("structured_output"), "")
            lines.append(f"{label} 모델 {_esc(info.get('served_model'))}{fallback} · 추론 강도 {_esc(info.get('reasoning_effort'))}{output}")
        versions = " · ".join(f"{_esc(key)}={_esc(value)}" for key, value in _as_dict(basis.get("versions")).items())
        return f"<footer><p>{' / '.join(lines)}</p><p>{versions}</p><p>만든 시각 {_esc(basis.get('generated_at'))}</p></footer>"

    # ── 목록 페이지 ─────────────────────────────────────────────

    def _render_index(self, cards: list[tuple[str, str, dict[str, Any], dict[str, Any]]]) -> str:
        rows = []
        for file_name, _document, mission, basis in cards:
            body = _as_dict(mission.get("mission"))
            job_name = _as_dict(mission.get("job_identity")).get("job_smcl_nm") or basis.get("job_cd")
            warning_count = _as_dict(basis.get("checks")).get("warning_count", 0)
            rows.append(
                f'<li><a href="{_esc(file_name)}">{_esc(body.get("title") or basis.get("mission_id"))}</a> '
                f'<span class="by">{_esc(job_name)} · {_esc(basis.get("difficulty"))} · 경고 {_esc(warning_count)}건</span></li>'
            )
        return (
            "<!doctype html>\n"
            '<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"<title>근거 카드 목록</title>\n<style>{STYLE}</style>\n</head>\n<body>\n"
            f'<header><h1>근거 카드 목록</h1><p class="meta">미션 {len(cards)}개</p></header>\n'
            f'<main><section><ul class="cards">{"".join(rows)}</ul></section></main>\n</body>\n</html>\n'
        )
