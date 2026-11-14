/* 생성 기록: 지금까지 만든 미션의 목록(시안의 화면 5).
   줄을 누르면 그 실행으로 가고, 줄 끝의 "삭제"로 생성 결과를 지운다.
   도는 중인 줄이 있으면 5초마다 목록을 다시 받는다. 화면에 넣는 값은 모두 esc()를 거친다. */
import { esc } from "../common/site.js";
import { adminApi } from "./api.js";
import { DIFFICULTY_LABELS } from "./labels.js";
import {
  icon,
  verdictBadge,
  statusBadge,
  formatWhen,
  confirmDeleteRun,
  toast,
  errorMessage,
  errorLine,
  loadingLine,
  emptyLine
} from "./shell.js";

const POLL_MS = 5000;   // 도는 중인 줄이 있을 때 목록을 다시 받는 간격
const NO_VERDICT_STATUSES = ["failed", "interrupted", "running"];   // 미션이 없으면 검수 칸을 "—"로 두는 상태

function own(table, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// 검수 칸. 미션이 아직 없거나 만들지 못한 줄은 "검수 안 함" 대신 "—"
function verdictCell(run) {
  const hasMission = Boolean(run.missionId || run.missionTitle);
  if (!run.reviewVerdict && !hasMission && NO_VERDICT_STATUSES.includes(run.status)) {
    return `<span class="muted">—</span>`;
  }
  return verdictBadge(run.reviewVerdict);
}

function rowHtml(run, readOnly) {
  const selection = run.selection || {};
  const difficulty = own(DIFFICULTY_LABELS, selection.difficulty) || selection.difficulty || "—";
  const title = run.missionTitle
    ? `<td class="ttl">${esc(run.missionTitle)}</td>`
    : `<td class="muted">—</td>`;
  // 도는 중인 줄에는 삭제가 없다. 조회 전용이면 눌리지 않는다
  const del = run.status === "running"
    ? ""
    : `<button type="button" class="link danger" data-testid="delete-run" data-run-id="${esc(run.runId)}"${readOnly ? " disabled" : ""}>삭제</button>`;
  return `<tr class="rowlink" data-testid="history-row" data-run-id="${esc(run.runId)}" tabindex="0">`
    + `<td class="when">${esc(formatWhen(run.createdAt))}</td>`
    + `<td>${esc(selection.jobName || "—")}</td>`
    + `<td>${esc(difficulty)}</td>`
    + title
    + `<td>${verdictCell(run)}</td>`
    + `<td>${statusBadge(run.status)}</td>`
    + `<td style="text-align:right">${del}</td>`
    + `</tr>`;
}

function tableHtml(runs, readOnly) {
  return `<div class="card dtwrap">
    <table class="dt hist">
      <thead><tr><th>만든 때</th><th>직업</th><th>난이도</th><th>미션</th><th>검수</th><th>상태</th><th></th></tr></thead>
      <tbody>${runs.map((run) => rowHtml(run, readOnly)).join("")}</tbody>
    </table>
  </div>`;
}

function emptyHtml() {
  return `<div class="card">
    ${emptyLine("아직 만든 미션이 없습니다.")}
    <div style="text-align:center;padding:0 16px 18px"><button type="button" class="btn pri" data-act="new">${icon("plus")}새 미션 만들기</button></div>
  </div>`;
}

export function mount(view, ctx, params) {
  ctx.setCrumb("생성 기록", "");
  view.innerHTML = `
    <div class="pagehead">
      <div><h1 class="h1">생성 기록</h1><p class="sub">지금까지 만든 미션입니다. 줄을 누르면 미리보기와 근거를 다시 볼 수 있고, 여기서 바로 삭제할 수도 있습니다.</p></div>
      <div class="sp"></div>
      <button type="button" class="btn pri" data-act="new">${icon("plus")}새 미션</button>
    </div>
    <div class="hist-body">${loadingLine()}</div>`;

  const body = view.querySelector(".hist-body");
  view.querySelector('.pagehead [data-act="new"]').addEventListener("click", () => ctx.navigate("#/new"));

  let alive = true;
  let timer = null;
  let seq = 0;          // 겹친 요청 중 마지막 것만 그린다
  let shown = null;     // 마지막으로 그린 목록(다시 받기가 실패해도 표를 지우지 않으려고)

  const live = () => alive && view.isConnected;

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(runs) {
    stopTimer();
    if (live() && runs.some((run) => run.status === "running")) timer = setTimeout(load, POLL_MS);
  }

  async function onDelete(run, button) {
    if (ctx.readOnly || button.disabled) return;
    if (!(await confirmDeleteRun(run))) return;
    button.disabled = true;
    try {
      await adminApi.deleteRun(run.runId);
    } catch (err) {
      toast(errorMessage(err));
      if (live()) button.disabled = Boolean(ctx.readOnly);
      return;
    }
    if (live()) load();
  }

  function render(runs) {
    if (!runs.length) {
      body.innerHTML = emptyHtml();
      body.querySelector('[data-act="new"]').addEventListener("click", () => ctx.navigate("#/new"));
      return;
    }
    body.innerHTML = tableHtml(runs, ctx.readOnly);
    const byId = new Map(runs.map((run) => [String(run.runId), run]));
    body.querySelectorAll("tr.rowlink").forEach((row) => {
      const go = () => ctx.navigate(`#/runs/${encodeURIComponent(row.dataset.runId)}`);
      row.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;   // 삭제 칸(눌리지 않는 버튼 포함)은 줄 누르기로 치지 않는다
        go();
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target === row) go();
      });
    });
    body.querySelectorAll('[data-testid="delete-run"]').forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const run = byId.get(button.dataset.runId);
        if (run) onDelete(run, button);
      });
    });
  }

  async function load() {
    stopTimer();
    const mine = ++seq;
    let runs;
    try {
      const data = await adminApi.runs();
      runs = Array.isArray(data?.runs) ? data.runs : [];
    } catch (err) {
      if (!live() || mine !== seq) return;
      // 처음 받기가 실패하면 오류 한 줄. 다시 받기가 실패하면 표를 두고 다음 차례에 또 받는다
      if (shown) schedule(shown);
      else body.innerHTML = errorLine(errorMessage(err));
      return;
    }
    if (!live() || mine !== seq) return;
    shown = runs;
    render(runs);
    schedule(runs);
  }

  load();

  return () => {
    alive = false;
    stopTimer();
  };
}
