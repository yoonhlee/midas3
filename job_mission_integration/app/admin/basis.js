/* 미리보기의 한 부분 → 근거 기록(generation_basis.json의 chain)에서 보여 줄 것. 순수 함수다(DOM을 쓰지 않는다).
   기록의 글은 줄이거나 다듬지 않고 그대로 담는다. 바꾸는 것은 조각 번호(renamePieces) 하나뿐이다.
   옛 실행이나 빈 칸처럼 그 부분의 근거가 기록에 없으면 null을 돌려준다(화면은 "이 부분의 근거 기록이 없습니다"를 보인다). */
import { KIND_LABELS, pieceName, renamePieces } from "./labels.js";

const MADE_UP_NOTE = "자료 안의 회사 이름, 날짜, 숫자는 지어낸 값입니다.";

const list = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasText = (value) => typeof value === "string" && value.trim() !== "";

function stepOf(chain, number) {
  return chain.find((step) => isObject(step) && step.step === number) ?? null;
}

// 빈 글은 빼고, 남은 글은 조각 번호만 바꾼다
function texts(values) {
  return values.filter(hasText).map(renamePieces);
}

// 조각 목록 → 근거가 된 원문. 글이 없는 조각은 뺀다. 3 · 4단계는 번호가 id가 아니라 ref에 있다
function sourcesOf(refs, idKey = "id") {
  return list(refs)
    .filter((ref) => isObject(ref) && hasText(ref.text))
    .map((ref) => ({ name: String(pieceName(ref[idKey]) ?? ""), text: ref.text }));
}

// 정한 주체: 단계의 kind 말과 decided_by. decided_by가 이미 kind 말로 시작하면 겹쳐 쓰지 않는다
function decidedByOf(step) {
  const kind = step?.kind;
  const kindLabel = typeof kind === "string" && Object.prototype.hasOwnProperty.call(KIND_LABELS, kind) ? KIND_LABELS[kind] : hasText(kind) ? kind : "";
  const by = hasText(step?.decided_by) ? step.decided_by : "";
  if (!kindLabel || !by) return kindLabel || by;
  return by === kindLabel || by.startsWith(`${kindLabel} `) ? by : `${kindLabel} · ${by}`;
}

// 보여 줄 것이 하나도 없으면(빈 칸) null. notes는 늘 붙는 안내라 있고 없음을 따지지 않는다
function view(step, why, sources, details, notes = []) {
  if (!why.length && !sources.length && !details.length) return null;
  const decidedBy = decidedByOf(step);
  const all = [...details, ...notes];
  if (decidedBy) all.push({ label: "정한 주체", value: decidedBy });
  return { why, sources, details: all, decidedBy };
}

function toIndex(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

function termText(term) {
  if (term.in_mission === true) return `${term.term}(미션에 들어감)`;
  if (term.in_mission === false) return `${term.term}(미션에 안 들어감)`;
  return term.term;
}

// 자료(5단계 materials[]): 역할과 형태를 고른 이유, 가져온 낱말
function materialBasis(step, id) {
  if (!hasText(id)) return null;
  const material = list(step?.materials).find((item) => isObject(item) && item.material_id === id);
  if (!material) return null;
  const terms = list(material.borrowed_terms).filter((term) => isObject(term) && hasText(term.term)).map(termText);
  const details = terms.length ? [{ label: "가져온 낱말", value: terms.join(" · ") }] : [];
  return view(step, texts([material.role, material.type_reason]), sourcesOf(material.refs), details, [{ label: "참고", value: MADE_UP_NOTE }]);
}

// 과제(5단계 tasks[])
function taskBasis(step, id) {
  if (!hasText(id)) return null;
  const task = list(step?.tasks).find((item) => isObject(item) && item.task_id === id);
  if (!task) return null;
  return view(step, texts([task.reason]), sourcesOf(task.refs), []);
}

// 채점 기준(6단계 items[]). 평가 지침(refs)과 KNOW 항목(know_refs)을 함께 근거로 든다
function rubricBasis(step, index) {
  const wanted = toIndex(index);
  if (wanted === null) return null;
  const item = list(step?.items).find((it) => isObject(it) && toIndex(it.rubric_index) === wanted);
  if (!item) return null;
  return view(step, texts([item.reason, item.what_to_check]), [...sourcesOf(item.refs), ...sourcesOf(item.know_refs)], []);
}

function countText(name, range) {
  const [low, high] = list(range);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return "";
  return low === high ? `${name} ${low}개` : `${name} ${low}~${high}개`;
}

// "이 미션이 온 길" 네 칸: 문장(1단계) → 능력단위(3단계) → 수행준거(4단계) → 미션(7단계 난이도 규칙 + 5단계 focus)
function pathBasis(chain, node) {
  if (node === "sentence") {
    const step = stepOf(chain, 1);
    return step ? view(step, [], sourcesOf(list(step.sources).slice(0, 1)), []) : null;
  }
  if (node === "unit") {
    const step = stepOf(chain, 3);
    if (!step) return null;
    const details = hasText(step.match) ? [{ label: "연결", value: step.match }] : [];
    return view(step, texts([step.reason, step.verdict_reason]), sourcesOf(step.criteria_refs, "ref"), details);
  }
  if (node === "criteria") {
    const step = stepOf(chain, 4);
    if (!step) return null;
    const items = list(step.items).filter(isObject);
    const why = items
      .filter((item) => hasText(item.reason))
      .map((item) => {
        const name = String(pieceName(item.ref) ?? "");
        return name ? `${name}: ${renamePieces(item.reason)}` : renamePieces(item.reason);
      });
    return view(step, why, sourcesOf(items, "ref"), []);
  }
  if (node === "mission") {
    const rule = stepOf(chain, 7);
    const focusStep = stepOf(chain, 5);
    if (!rule && !focusStep) return null;
    const values = isObject(rule?.values) ? rule.values : {};
    const counts = [countText("자료", values.material_count_range), countText("과제", values.task_count_range)].filter(Boolean);
    const details = counts.length ? [{ label: "난이도 규칙", value: counts.join(" · ") }] : [];
    const note = isObject(focusStep?.focus) ? focusStep.focus.uncovered_note : null;
    if (hasText(note)) details.push({ label: "다루지 않는 부분", value: renamePieces(note) });
    return view(rule ?? focusStep, [], [], details);
  }
  return null;
}

// part: { kind: "material", id } | { kind: "task", id } | { kind: "rubric", index } | { kind: "path", node: "sentence" | "unit" | "criteria" | "mission" }
// → { why: string[], sources: { name, text }[], details: { label, value }[], decidedBy: string } 또는 null
export function basisFor(basis, part) {
  const chain = isObject(basis) ? list(basis.chain) : [];
  if (!chain.length || !isObject(part)) return null;
  if (part.kind === "material") return materialBasis(stepOf(chain, 5), part.id);
  if (part.kind === "task") return taskBasis(stepOf(chain, 5), part.id);
  if (part.kind === "rubric") return rubricBasis(stepOf(chain, 6), part.index);
  if (part.kind === "path") return pathBasis(chain, part.node);
  return null;
}
