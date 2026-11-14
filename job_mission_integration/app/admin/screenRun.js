/* 실행 하나(#/runs/<실행 번호>). 실행의 상태에 따라 보이는 것이 바뀐다.
   도는 중: 단계 여섯과 진행 막대(1.5초마다 다시 받는다). 실패 · 중단: 멈춘 단계와 이유.
   끝남(검토 대기 · 추가됨): 미리보기와 근거, 검수 탭.
   화면에 넣는 값은 모두 esc()를 거친다(renderMaterial은 스스로 거른다). */
import { esc } from "../common/site.js";
import { renderMaterial } from "../components/missionScreens.js";
import { adminApi } from "./api.js";
import { basisFor } from "./basis.js";
import {
  DIFFICULTY_LABELS,
  MATERIAL_TYPE_LABELS,
  REWRITTEN_LABEL,
  STAGE_LABELS,
  STAGE_STATE_LABELS,
  STATUS_LABELS,
  errorText,
  pieceName,
  verdictView
} from "./labels.js";
import { confirmDeleteRun, emptyLine, errorLine, errorMessage, icon, loadingLine, statusBadge, toast, verdictBadge } from "./shell.js";

const POLL_MS = 1500;
const STARTING_LIMIT_MS = 10000;   // 막 시작한 실행이 이만큼 지나도 404면 찾을 수 없다고 본다
const POLL_ERROR_AFTER = 3;        // 다시 받기가 이만큼 잇달아 실패하면 알린다
const POLL_ERROR_TEXT = "서버에 연결하지 못했습니다. 다시 확인하는 중입니다.";
const STAGE_COUNT =Object.keys(STAGE_LABELS).length;
const STAGE_CLASS = { done: "done", active: "cur", pending: "wait", skipped: "skip", failed: "fail" };
const SEVERITY_LABELS = { error: "문제", warning: "주의", note: "참고" };
const READONLY_TEXT = "관리자 암호를 넣으면 보입니다";
const INTERRUPTED_TEXT = "서버가 꺼져서 멈췄습니다. 다시 만들려면 새 미션 만들기에서 시작해 주세요.";
const RUNNING_NOTE = "이 창을 닫아도 생성은 계속됩니다.";
const NO_BASIS_TEXT = "이 부분의 근거 기록이 없습니다.";

// 근거 칸의 "왜" 이름표와 제목
const WHY_LABELS = { task: "왜 이 과제인가", material: "이 자료의 역할", rubric: "왜 이것을 채점하나" };
const PATH_WHY_LABELS = { sentence: "관리자가 고른 문장", unit: "왜 이 능력단위인가", criteria: "이 미션에 쓴 수행준거", mission: "미션" };
const PATH_TITLES = { sentence: "하는 일 문장", unit: "능력단위", criteria: "수행준거", mission: "미션" };

const list = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasText = (value) => typeof value === "string" && value.trim() !== "";
const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function own(table, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function chainStep(basis, number) {
  return list(basis?.chain).find((step) => isObject(step) && step.step === number) ?? null;
}

// 글이 아닌 값(객체 등)도 읽을 수 있게 글자로 바꾼다
function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

// 접는 칸의 화살표(.chev는 admin.css가 inline-flex로 둔다)
function chev() {
  return `<span class="chev" style="color:var(--tx3)">${icon("chevronRight")}</span>`;
}

// 수나 글자로 온 수("15")를 수로. 빈 글자와 그 밖은 NaN
function toNumber(value) {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
}

// 채점 기준 번호: 정수나 숫자만 든 글자를 받는다(basis.js와 같은 규칙). 그 밖은 null
function toIndex(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

function selectionLine(run) {
  const sel = run.selection ?? {};
  return [sel.jobName, own(DIFFICULTY_LABELS, sel.difficulty)].filter(hasText);
}

/* ───── 단계와 진행 막대 ───── */

function stageRows(stages) {
  return list(stages)
    .map((stage, index) => {
      const item = isObject(stage) ? stage : {};
      const id = String(item.id ?? "");
      const state = String(item.state ?? "");
      const cls = own(STAGE_CLASS, state) ?? "wait";
      const words = [own(STAGE_STATE_LABELS, state) ?? state, item.rewritten ? REWRITTEN_LABEL : ""].filter(Boolean).join(" · ");
      return `<div class="vstep ${cls}" data-testid="stage" data-stage="${esc(id)}" data-state="${esc(state)}">
        <span class="n">${state === "done" ? "✓" : index + 1}</span><span class="t">${esc(own(STAGE_LABELS, id) ?? id)}</span><span class="r">${esc(words)}</span>
      </div>`;
    })
    .join("");
}

function progressBar(stages) {
  const done = list(stages).filter((stage) => stage?.state === "done").length;
  const percent = STAGE_COUNT ? Math.min(100, Math.round((done / STAGE_COUNT) * 100)) : 0;
  return `<div class="pbar"><i style="width:${percent}%"></i></div>`;
}

function runningProgress(run) {
  const active = list(run.stages).find((stage) => stage?.state === "active");
  const now = active ? `${own(STAGE_LABELS, active.id) ?? active.id} 중` : STATUS_LABELS.running;
  return `<div class="now"><span class="spin"></span>${esc(now)}</div>${progressBar(run.stages)}${stageRows(run.stages)}`;
}

function settingsCard(run) {
  const sel = run.selection ?? {};
  return `<div class="card">
    <div class="chead"><span class="t">생성 설정</span></div>
    <div class="cbody">
      <div class="field"><div class="flbl">직업</div><div class="fval">${esc(sel.jobName || "—")}</div></div>
      <div class="field"><div class="flbl">능력단위</div><div>${esc(sel.unitName || "—")}</div></div>
      <div class="field"><div class="flbl">난이도</div><div>${esc(own(DIFFICULTY_LABELS, sel.difficulty) ?? "—")}</div></div>
    </div>
  </div>`;
}

function logText(run) {
  return list(run.logs)
    .map((line) => textOf(line?.message))
    .join("\n");
}

function logsCard(run) {
  return `<div class="card" style="margin-top:14px">
    <details><summary class="acc"><span class="t">상세 로그</span>${chev()}</summary>
      <div class="cbody"><pre class="logbox">${esc(logText(run))}</pre></div>
    </details>
  </div>`;
}

/* ───── 도는 중 · 실패 · 중단 ───── */

function runningView(run) {
  const sub = [...selectionLine(run), RUNNING_NOTE].join(" · ");
  return `<div data-view="running">
    <div class="pagehead"><div><h1 class="h1">미션을 만들고 있습니다</h1><p class="sub">${esc(sub)}</p></div></div>
    <div class="g2">
      <div class="card prog"><div data-role="poll-error"></div><div data-role="progress">${runningProgress(run)}</div></div>
      ${settingsCard(run)}
    </div>
    ${logsCard(run)}
  </div>`;
}

function stoppedView(run, ctx) {
  const reason = run.status === "interrupted" ? INTERRUPTED_TEXT : errorText(run.error?.code, { failedRun: true });
  return `<div data-view="stopped">
    <div class="pagehead">
      <div><h1 class="h1">미션을 만들지 못했습니다</h1><p class="sub">${esc(selectionLine(run).join(" · "))}</p></div>
      <div class="sp"></div>
      <button class="btn ghost" type="button" data-act="delete" data-testid="delete-run"${ctx.readOnly ? " disabled" : ""}>삭제</button>
      <a class="btn" href="#/new">새 미션 만들기로</a>
    </div>
    <div class="g2">
      <div class="card prog">
        <div class="now">${statusBadge(run.status)}</div>
        ${errorLine(reason)}
        ${progressBar(run.stages)}${stageRows(run.stages)}
      </div>
      ${settingsCard(run)}
    </div>
    ${logsCard(run)}
  </div>`;
}

/* ───── 결과: 머리, 길, 미리보기, 근거 칸 ───── */

const partKey = (part) => (part ? `${part.kind}:${part.id ?? part.index ?? part.node}` : "");

// 누를 수 있는 칸의 표식(data-part-kind, data-part-ref)과 켜짐
function partAttrs(part, selectedKey) {
  const ref = part.id ?? part.index ?? part.node;
  return `role="button" tabindex="0" data-part-kind="${esc(part.kind)}" data-part-ref="${esc(ref)}" aria-pressed="${partKey(part) === selectedKey ? "true" : "false"}"`;
}

function resultHeader(run, ctx) {
  const sel = run.selection ?? {};
  const minutes = toNumber(run.mission?.mission?.difficulty?.estimated_time_minutes);
  const difficulty = own(DIFFICULTY_LABELS, sel.difficulty);
  const badges = [
    hasText(sel.jobName) ? `<span class="badge">${esc(sel.jobName)}</span>` : "",
    difficulty ? `<span class="badge">${esc(difficulty)}</span>` : "",
    Number.isFinite(minutes) ? `<span class="badge">${esc(minutes)}분</span>` : "",
    verdictBadge(run.reviewVerdict, run.reviewRecord?.warning_count)
  ].join("");
  const added = run.status === "added";
  const addDisabled = ctx.readOnly || !run.catalog?.canAdd;
  const addPart = added
    ? `<button class="btn" type="button" data-testid="add-catalog" disabled>${icon("check")}추가됨</button><a class="btn" href="#/catalog">카탈로그에서 보기</a>`
    : `<button class="btn pri" type="button" data-act="add" data-testid="add-catalog"${addDisabled ? " disabled" : ""}>${icon("check")}카탈로그에 추가</button>`;
  const hint = !added && run.reviewVerdict === "fail" ? `<div class="hint">검수 판정이 '문제'라 추가할 수 없습니다</div>` : "";
  const title = run.missionTitle || run.mission?.mission?.title || own(STATUS_LABELS, run.status) || "";
  return `<div class="rhead">
    <div style="min-width:0">
      <h1 class="h1" data-testid="run-title">${esc(title)}</h1>
      <div class="meta">${badges}</div>
      ${hint}
    </div>
    <div class="sp"></div>
    <button class="btn ghost" type="button" data-act="delete" data-testid="delete-run"${ctx.readOnly ? " disabled" : ""}>삭제</button>
    ${addPart}
  </div>`;
}

// "이 미션이 온 길" 네 칸: 문장 → 능력단위 → 수행준거 → 미션
function pathRow(run, selectedKey) {
  const sel = run.selection ?? {};
  const criteria = list(chainStep(run.basis, 4)?.items)
    .map((item) => pieceName(item?.ref))
    .filter(hasText)
    .join(", ");
  const segs = [
    ["sentence", "하는 일 문장", sel.execJobText],
    ["unit", hasText(sel.linkKind) ? `능력단위 · ${sel.linkKind}` : "능력단위", sel.unitName],
    ["criteria", "수행준거", criteria],
    ["mission", "미션", run.missionTitle]
  ];
  return `<div class="path">${segs
    .map(([node, label, text]) => {
      const part = { kind: "path", node };
      const on = partKey(part) === selectedKey ? " on" : "";
      return `<div class="pseg${on}" ${partAttrs(part, selectedKey)} title="${esc(text || "")}"><small>${esc(label)}</small><div>${esc(text || "—")}</div></div>`;
    })
    .join("")}</div>`;
}

function pick(part, inner, selectedKey) {
  const on = partKey(part) === selectedKey ? " on" : "";
  return `<div class="pick${on}" data-testid="preview-part" ${partAttrs(part, selectedKey)}><span class="why">근거 보기</span>${inner}</div>`;
}

function materialHtml(material) {
  try {
    return renderMaterial(material, esc);
  } catch (_) {
    return `<div class="muted">${esc(material.title || material.material_id || "")}</div>`;
  }
}

function scenarioSection(scenario) {
  const sc = isObject(scenario) ? scenario : {};
  const rows = [
    ["역할", sc.role],
    ["배경", sc.context],
    ["이번 업무의 목표", sc.goal]
  ]
    .filter(([, value]) => hasText(value))
    .map(([label, value]) => `<div class="field"><div class="flbl">${esc(label)}</div><div>${esc(value)}</div></div>`);
  const constraints = list(sc.constraints).filter(hasText);
  if (constraints.length) {
    rows.push(`<div class="field"><div class="flbl">유의 사항</div><ul style="margin:0;padding-left:18px">${constraints.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>`);
  }
  return rows.length ? `<div class="sec">상황</div><div class="scn">${rows.join("")}</div>` : "";
}

// 채점 기준. 조회 전용이면 서버가 기준을 빼고 주므로 글 대신 안내를 두고, 근거 기록 6단계의 항목만 누를 수 있게 둔다
function rubricSection(run, ctx, selectedKey) {
  if (ctx.readOnly) {
    const indexes = list(chainStep(run.basis, 6)?.items)
      .map((item) => toIndex(item?.rubric_index))
      .filter((index) => index !== null);
    const picks = indexes.map((index) => pick({ kind: "rubric", index }, `<div class="k">채점 기준 ${index + 1}</div>`, selectedKey)).join("");
    return `<div class="sec">채점 기준</div><div class="hint">${esc(READONLY_TEXT)}</div>${picks}`;
  }
  const rubric = list(run.mission?.evaluation?.rubric);
  if (!rubric.length) return "";
  const picks = rubric
    .map((item, index) => {
      const row = isObject(item) ? item : {};
      const pointValue = toNumber(row.points);
      const points = Number.isFinite(pointValue) ? `${pointValue}점` : "";
      const description = hasText(row.description) ? `<div class="muted s12" style="margin-top:4px">${esc(row.description)}</div>` : "";
      return pick({ kind: "rubric", index }, `<div class="rub"><span class="p">${esc(points)}</span>${esc(row.criterion || "")}</div>${description}`, selectedKey);
    })
    .join("");
  return `<div class="sec">채점 기준</div>${picks}`;
}

function previewCard(run, ctx, selectedKey) {
  const mission = run.mission?.mission;
  if (!isObject(mission)) return `<div class="card">${emptyLine("미션 내용을 불러오지 못했습니다.")}</div>`;
  const tasks = list(mission.tasks).filter(isObject);
  const materials = list(mission.materials).filter(isObject);
  const taskPart = tasks.length
    ? `<div class="sec">과제</div>${tasks.map((task, index) => pick({ kind: "task", id: task.task_id }, `<div class="k">과제 ${index + 1}</div>${esc(task.instruction || "")}`, selectedKey)).join("")}`
    : "";
  const materialPart = materials.length
    ? `<div class="sec">자료</div>${materials
        .map((material, index) => {
          const type = own(MATERIAL_TYPE_LABELS, material.type);
          const label = type ? `자료 ${index + 1} · ${type}` : `자료 ${index + 1}`;
          return pick({ kind: "material", id: material.material_id }, `<div class="k">${esc(label)}</div><div class="preview">${materialHtml(material)}</div>`, selectedKey);
        })
        .join("")}`
    : "";
  return `<div class="card"><div class="cbody">
    ${scenarioSection(mission.scenario)}${taskPart}${materialPart}${rubricSection(run, ctx, selectedKey)}
  </div></div>`;
}

// 근거 칸 머리에 보일 이름
function partTitle(run, part) {
  if (!part) return "—";
  const mission = run.mission?.mission;
  if (part.kind === "task") {
    const index = list(mission?.tasks).findIndex((task) => task?.task_id === part.id);
    return index >= 0 ? `과제 ${index + 1}` : "과제";
  }
  if (part.kind === "material") {
    const materials = list(mission?.materials);
    const index = materials.findIndex((material) => material?.material_id === part.id);
    if (index < 0) return "자료";
    return hasText(materials[index].title) ? `자료 ${index + 1} · ${materials[index].title}` : `자료 ${index + 1}`;
  }
  if (part.kind === "rubric") {
    const fromMission = list(run.mission?.evaluation?.rubric)[part.index]?.criterion;
    const fromBasis = list(chainStep(run.basis, 6)?.items).find((item) => toIndex(item?.rubric_index) === part.index)?.criterion;
    const name = hasText(fromMission) ? fromMission : hasText(fromBasis) ? fromBasis : "";
    return name ? `채점 기준 · ${name}` : `채점 기준 ${part.index + 1}`;
  }
  return own(PATH_TITLES, part.node) ?? "—";
}

function linkBadge(linkKind) {
  if (!hasText(linkKind)) return "";
  const cls = linkKind === "직접" ? "badge ok" : "badge warn";
  return `<span class="${cls}" style="height:18px;margin-left:4px">${esc(linkKind)}</span>`;
}

function basisBody(run, part, found) {
  const isPath = part.kind === "path";
  const whyLabel = esc((isPath ? own(PATH_WHY_LABELS, part.node) : own(WHY_LABELS, part.kind)) ?? "");
  const badge = isPath && part.node === "unit" ? linkBadge(run.selection?.linkKind) : "";
  let html = "";
  if (found.why.length) {
    html += `<div class="ilbl">${whyLabel}${badge}</div>${found.why.map((text) => `<div style="margin-top:4px">${esc(text)}</div>`).join("")}`;
  }
  if (found.sources.length) {
    // 길의 칸은 "왜"가 없으면 원문 위에 그 칸의 이름표를 쓴다(예: 관리자가 고른 문장)
    const sourceLabel = !found.why.length && isPath ? `${whyLabel}${badge}` : "근거가 된 원문";
    html += `<div class="ilbl">${sourceLabel}</div>${found.sources
      .map((source) => `<div class="q">${hasText(source.name) ? `<small>${esc(source.name)}</small>` : ""}${esc(source.text)}</div>`)
      .join("")}`;
  }
  if (found.details.length) {
    // 보일 것이 자세히 보기뿐이면(미션 칸 등) 펼쳐 둔다
    const open = !found.why.length && !found.sources.length ? " open" : "";
    html += `<details style="margin-top:14px"${open}>
      <summary><span class="link">자세히 보기${chev()}</span></summary>
      <div style="margin-top:10px">${found.details.map((row) => `<div class="ilbl">${esc(row.label)}</div><div>${esc(row.value)}</div>`).join("")}</div>
    </details>`;
  }
  return html;
}

function basisPanel(run, part) {
  const found = part ? basisFor(run.basis, part) : null;
  const body = found ? basisBody(run, part, found) : `<div class="muted">${esc(NO_BASIS_TEXT)}</div>`;
  return `<div class="ih"><small>근거</small><b>${esc(partTitle(run, part))}</b></div><div class="cbody">${body}</div>`;
}

/* ───── 결과: 검수 탭 ───── */

function verdictBox(run, ctx, record) {
  const verdict = run.reviewVerdict ?? null;
  const view = verdictView(verdict, record?.warning_count);
  const look =
    verdict === "pass"
      ? ["verdict", icon("check", { size: 20, style: "stroke-width:2" })]
      : verdict === "fail"
        ? ["verdict danger", "!"]
        : verdict === "review_failed"
          ? ["verdict warn", "!"]
          : ["verdict plain", "–"];
  const summary = hasText(record?.judgement?.summary) ? `<div style="color:var(--tx2);margin-top:2px">${esc(record.judgement.summary)}</div>` : "";
  const button = run.catalog?.canReview
    ? `<div class="sp"></div><button class="btn" type="button" data-act="review"${ctx.readOnly ? " disabled" : ""}>${verdict === "review_failed" ? "검수 다시 돌리기" : "검수 돌리기"}</button>`
    : "";
  return `<div class="${look[0]}"><div class="v">${look[1]}</div><div style="min-width:0"><b>${esc(view.text)}</b>${summary}</div>${button}</div>`;
}

function reviewTiles(record) {
  const judgement = isObject(record.judgement) ? record.judgement : {};
  const solver = isObject(record.solver_result) ? record.solver_result : {};
  const solvable = solver.solvable === "yes";
  const same = judgement.agreement === "same";
  const issues = `문제 ${count(record.error_count)} · 주의 ${count(record.warning_count)} · 참고 ${count(record.note_count)}`;
  return `<div class="tiles">
    <div class="card tile"><small>풀 수 있는가</small><b${solvable ? ' style="color:var(--ok)"' : ""}>${solvable ? "풀 수 있다" : "풀기 어렵다"}</b></div>
    <div class="card tile"><small>푼 답과 기대 답</small><b${same ? ' style="color:var(--ok)"' : ""}>${same ? "같다" : "다르다"}</b></div>
    <div class="card tile"><small>지적</small><b>${esc(issues)}</b></div>
  </div>`;
}

function taskLabel(run, taskId) {
  const index = list(run.mission?.mission?.tasks).findIndex((task) => task?.task_id === taskId);
  return index >= 0 ? `과제 ${index + 1}` : textOf(taskId);
}

function reviewLists(run, ctx, record) {
  const issues = list(record.judgement?.issues).filter(isObject);
  const issueBody = issues.length
    ? issues
        .map((issue) => {
          const head = [own(SEVERITY_LABELS, issue.severity) ?? textOf(issue.severity), textOf(issue.where)].filter(Boolean).join(" · ");
          return `<div class="q">${head ? `<small>${esc(head)}</small>` : ""}${esc(textOf(issue.detail))}</div>`;
        })
        .join("")
    : `<div class="muted">지적이 없습니다.</div>`;
  const issuePart = `<details><summary class="acc"><span class="t">지적 목록</span><span class="muted s12">${issues.length}건</span>${chev()}</summary>
    <div class="cbody">${issueBody}</div></details>`;

  // 조회 전용이면 서버가 풀어 본 답을 빼고 준다
  if (ctx.readOnly) {
    return `${issuePart}<div class="acc" style="cursor:default"><span class="t">풀어 본 답</span><span class="muted s12">${esc(READONLY_TEXT)}</span></div>`;
  }
  const answers = list(record.solver_result?.answers).filter(isObject);
  const answerBody = answers.length
    ? answers
        .map((answer) => {
          const basis = hasText(textOf(answer.basis)) ? `<div class="muted s12" style="margin-top:4px">근거: ${esc(textOf(answer.basis))}</div>` : "";
          return `<div class="q"><small>${esc(taskLabel(run, answer.task_id))}</small>${esc(textOf(answer.answer))}${basis}</div>`;
        })
        .join("")
    : `<div class="muted">풀어 본 답이 없습니다.</div>`;
  const answerPart = `<details><summary class="acc"><span class="t">풀어 본 답</span><span class="muted s12">${answers.length ? `과제 ${answers.length}개` : "0개"}</span>${chev()}</summary>
    <div class="cbody">${answerBody}</div></details>`;
  return issuePart + answerPart;
}

// 검수 실패면 앞선 검수의 기록이 남아 있어도 그리지 않는다. 판정이 통과 · 의심 · 문제일 때만 기록을 그린다
function reviewPane(run, ctx) {
  const verdict = run.reviewVerdict ?? null;
  const record = ["pass", "doubt", "fail"].includes(verdict) && isObject(run.reviewRecord) ? run.reviewRecord : null;
  const box = verdictBox(run, ctx, record);
  if (!record) return box;
  return `${box}${reviewTiles(record)}<div class="card" style="margin-top:12px">${reviewLists(run, ctx, record)}</div>`;
}

function resultView(run, ctx, state) {
  const key = partKey(state.part);
  const onPreview = state.tab !== "review";
  const tab = (name, label, on) =>
    `<div class="tab${on ? " on" : ""}" role="tab" tabindex="0" aria-selected="${on ? "true" : "false"}" data-act="tab" data-tab="${name}">${label}</div>`;
  return `<div data-view="result">
    ${resultHeader(run, ctx)}
    ${pathRow(run, key)}
    <div class="tabs" role="tablist">
      ${tab("preview", "미리보기와 근거", onPreview)}
      ${tab("review", `검수 ${verdictBadge(run.reviewVerdict, run.reviewRecord?.warning_count)}`, !onPreview)}
    </div>
    <div data-pane="preview"${onPreview ? "" : " hidden"}>
      <div class="split">
        ${previewCard(run, ctx, key)}
        <div class="card insp sticky" data-testid="basis-panel">${basisPanel(run, state.part)}</div>
      </div>
    </div>
    <div data-pane="review"${onPreview ? " hidden" : ""}>${reviewPane(run, ctx)}</div>
  </div>`;
}

/* ───── 화면 ───── */

export function mount(view, ctx, params) {
  const runId = params?.runId ?? "";
  const state = {
    run: null,
    tab: "preview",
    part: null,          // 미리보기에서 고른 부분(basisFor에 넘기는 모양)
    timer: null,
    stopped: false,
    busy: false,         // 추가 · 삭제 · 검수 요청이 도는 중
    startingSince: 0,    // 막 시작한 실행이라 404를 기다리기 시작한 때
    sawRunning: false,   // 도는 모습을 보였으면 끝났을 때 사이드바 건수를 다시 받는다
    failures: 0          // 다시 받기가 잇달아 실패한 횟수(404 말고)
  };
  const alive = () => !state.stopped && view.isConnected;

  function schedule() {
    clearTimeout(state.timer);
    state.timer = alive() ? setTimeout(poll, POLL_MS) : null;
  }

  function stopPolling() {
    clearTimeout(state.timer);
    state.timer = null;
  }

  function renderNotFound() {
    stopPolling();
    ctx.setCrumb("생성 기록", "");
    view.innerHTML = `<div class="card"><div class="empty-line">이 실행을 찾을 수 없습니다.
      <div style="margin-top:8px"><a class="link" href="#/runs">생성 기록으로</a></div></div></div>`;
  }

  function renderStarting() {
    ctx.setCrumb("새 미션 만들기", "생성 중");
    state.sawRunning = true;
    view.innerHTML = `<div class="pagehead"><div><h1 class="h1">미션을 만들고 있습니다</h1><p class="sub">${esc(RUNNING_NOTE)}</p></div></div>
      <div class="card prog">${loadingLine("시작하는 중입니다")}</div>`;
  }

  // 도는 중: 처음엔 통째로 그리고, 그 뒤로는 단계 카드와 로그만 바꾼다(펼친 로그가 접히지 않게)
  function renderRunning() {
    const run = state.run;
    ctx.setCrumb("새 미션 만들기", "생성 중");
    state.sawRunning = true;
    const box = view.querySelector('[data-view="running"]');
    if (!box) {
      view.innerHTML = runningView(run);
      return;
    }
    const progress = box.querySelector('[data-role="progress"]');
    if (progress) progress.innerHTML = runningProgress(run);
    showPollError(false);
    const pre = box.querySelector(".logbox");
    if (pre) {
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      pre.textContent = logText(run);
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    }
  }

  function renderResult() {
    const run = state.run;
    if (!state.part) {
      const first = list(run.mission?.mission?.tasks).find(isObject);
      state.part = first ? { kind: "task", id: first.task_id } : null;
    }
    view.innerHTML = resultView(run, ctx, state);
  }

  function show(run) {
    if (!isObject(run)) {
      renderNotFound();
      return;
    }
    state.run = run;
    if (run.status === "running") {
      renderRunning();
      schedule();
      return;
    }
    stopPolling();
    if (state.sawRunning) {
      state.sawRunning = false;
      ctx.refreshUsage();
    }
    ctx.setCrumb("생성 기록", run.missionTitle || own(STATUS_LABELS, run.status) || "");
    if (run.status === "failed" || run.status === "interrupted") view.innerHTML = stoppedView(run, ctx);
    else renderResult();
  }

  // 도는 중 카드의 단계 목록 위에 "다시 확인하는 중" 한 줄을 보이거나 지운다
  function showPollError(on) {
    const slot = view.querySelector('[data-role="poll-error"]');
    if (slot) slot.innerHTML = on ? errorLine(POLL_ERROR_TEXT) : "";
  }

  async function poll() {
    state.timer = null;
    if (!alive()) return;
    let body;
    try {
      body = await adminApi.run(runId);
    } catch (err) {
      if (!alive()) return;
      const inStartWindow = !state.run && state.startingSince && Date.now() - state.startingSince < STARTING_LIMIT_MS;
      if (err?.status === 404) {
        if (inStartWindow) schedule();
        else renderNotFound();
        return;
      }
      if (!state.run) {
        // 막 시작한 실행: 같은 10초 안에서는 계속 다시 받는다
        if (inStartWindow) schedule();
        else view.innerHTML = errorLine(errorMessage(err));
        return;
      }
      // 도는 중에 못 닿으면 계속 다시 받고, 세 번 잇달아 실패하면 한 줄로 알린다
      state.failures += 1;
      if (state.failures >= POLL_ERROR_AFTER) showPollError(true);
      schedule();
      return;
    }
    state.failures = 0;
    if (!alive()) return;
    show(body?.run);
  }

  // 처음 받기. 404여도 지금 도는 실행의 번호면 서버가 시작 전 확인을 하는 중이다
  async function load() {
    view.innerHTML = loadingLine();
    let body;
    try {
      body = await adminApi.run(runId);
    } catch (err) {
      if (!alive()) return;
      if (err?.status !== 404) {
        view.innerHTML = errorLine(errorMessage(err));
        return;
      }
      let status = null;
      try {
        status = await adminApi.status();
      } catch (_) {
        status = null;
      }
      if (!alive()) return;
      if (status && runId && status.activeRunId === runId) {
        state.startingSince = Date.now();
        renderStarting();
        schedule();
      } else {
        renderNotFound();
      }
      return;
    }
    if (!alive()) return;
    show(body?.run);
  }

  async function refetch() {
    try {
      const body = await adminApi.run(runId);
      if (alive()) show(body?.run);
    } catch (err) {
      if (!alive()) return;
      if (err?.status === 404) renderNotFound();
      else toast(errorMessage(err));
    }
  }

  function selectTab(name) {
    state.tab = name === "review" ? "review" : "preview";
    view.querySelectorAll('.tab[data-act="tab"]').forEach((node) => {
      const on = node.dataset.tab === state.tab;
      node.classList.toggle("on", on);
      node.setAttribute("aria-selected", on ? "true" : "false");
    });
    view.querySelectorAll("[data-pane]").forEach((node) => {
      node.hidden = node.dataset.pane !== state.tab;
    });
  }

  function partOf(node) {
    const kind = node.dataset.partKind;
    const ref = node.dataset.partRef ?? "";
    if (kind === "rubric") return { kind, index: Number(ref) };
    if (kind === "path") return { kind, node: ref };
    return { kind, id: ref };
  }

  // 고른 부분만 바꾼다(미리보기를 다시 그리지 않아 스크롤이 그대로다)
  function selectPart(part) {
    if (!state.run) return;
    state.part = part;
    const key = partKey(part);
    view.querySelectorAll("[data-part-kind]").forEach((node) => {
      const on = partKey(partOf(node)) === key;
      node.classList.toggle("on", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const panel = view.querySelector('[data-testid="basis-panel"]');
    if (panel) panel.innerHTML = basisPanel(state.run, part);
  }

  async function onDelete(button) {
    const run = state.run;
    if (state.busy || ctx.readOnly || !run) return;
    if (!(await confirmDeleteRun(run))) return;
    if (!alive()) return;
    state.busy = true;
    button.disabled = true;
    try {
      await adminApi.deleteRun(run.runId);
    } catch (err) {
      state.busy = false;
      if (!alive()) return;
      button.disabled = false;
      toast(errorMessage(err));
      return;
    }
    state.busy = false;
    if (alive()) ctx.navigate("#/runs");
  }

  async function onAdd(button) {
    const run = state.run;
    if (state.busy || ctx.readOnly || !run?.catalog?.canAdd) return;
    state.busy = true;
    button.disabled = true;
    try {
      await adminApi.addToCatalog(run.runId);
    } catch (err) {
      state.busy = false;
      if (!alive()) return;
      button.disabled = false;
      toast(errorMessage(err));
      return;
    }
    state.busy = false;
    if (!alive()) return;
    toast("카탈로그에 추가했습니다.");
    await refetch();
  }

  // 검수 돌리기: 서버가 실행을 다시 "생성 중"으로 돌리므로 도는 중 화면으로 바꾸고 다시 받기 시작한다
  async function onReview(button) {
    const run = state.run;
    if (state.busy || ctx.readOnly || !run?.catalog?.canReview) return;
    state.busy = true;
    button.disabled = true;
    let body;
    try {
      body = await adminApi.rerunReview(run.runId);
    } catch (err) {
      state.busy = false;
      if (!alive()) return;
      button.disabled = false;
      toast(errorMessage(err));
      return;
    }
    state.busy = false;
    if (!alive()) return;
    if (isObject(body?.run)) show(body.run);
    else await refetch();
  }

  view.addEventListener("click", (event) => {
    const node = event.target.closest?.("[data-act], [data-part-kind]");
    if (!node || !view.contains(node)) return;
    if (node.dataset.partKind) {
      selectPart(partOf(node));
      return;
    }
    const act = node.dataset.act;
    if (act === "tab") selectTab(node.dataset.tab);
    else if (act === "delete") onDelete(node);
    else if (act === "add") onAdd(node);
    else if (act === "review") onReview(node);
  });

  // 버튼이 아닌 칸(탭, 미리보기의 부분, 길의 칸)도 Enter · 스페이스로 누를 수 있게 한다
  view.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const node = event.target;
    if (!node?.matches?.('[role="button"], [role="tab"]') || node.tagName === "BUTTON" || node.tagName === "A") return;
    event.preventDefault();
    node.click();
  });

  load();

  return () => {
    state.stopped = true;
    stopPolling();
  };
}
