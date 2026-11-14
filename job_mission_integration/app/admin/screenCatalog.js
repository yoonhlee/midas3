/* 미션 카탈로그: 서비스에 올라가 있는 미션.
   위의 세 칸(직업 · 미션 · 관리자 페이지에서 추가), 직업별 표(누르면 그 직업의 미션이 펼쳐진다),
   미션 줄의 "열기"(사용자 화면에서 그 미션을 연다)와 "삭제"(관리자 페이지에서 추가한 미션에만).
   화면에 넣는 값은 모두 esc()를 거친다. 수와 키는 응답에서만 가져온다. */
import { esc } from "../common/site.js";
import { adminApi } from "./api.js";
import { DIFFICULTY_LABELS } from "./labels.js";
import { confirmDialog, emptyLine, errorLine, errorMessage, icon, loadingLine, toast } from "./shell.js";

const DIFFICULTIES = ["easy", "normal", "hard"];

const CHEVRON_STYLE = "vertical-align:-1px;margin-right:6px;color:var(--tx3)";

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function difficultyLabel(difficulty) {
  return typeof difficulty === "string" && Object.prototype.hasOwnProperty.call(DIFFICULTY_LABELS, difficulty)
    ? DIFFICULTY_LABELS[difficulty]
    : difficulty || "–";
}

function chevron(open) {
  return icon(open ? "chevronDown" : "chevronRight", { size: 13, style: CHEVRON_STYLE });
}

function missionsOf(job) {
  return Array.isArray(job?.missions) ? job.missions : [];
}

// 관리자 페이지에서 추가한 미션이 있는 직업은 처음부터 펼쳐 둔다
function startsOpen(job) {
  return missionsOf(job).some((mission) => mission?.addedByAdmin === true);
}

function tilesHtml(total) {
  const tile = (label, value) => `<div class="card tile"><small>${esc(label)}</small><b>${esc(count(value))}</b></div>`;
  return `<div class="tiles" style="margin:0 0 14px">
    ${tile("직업", total?.jobs)}
    ${tile("미션", total?.missions)}
    ${tile("관리자 페이지에서 추가", total?.addedByAdmin)}
  </div>`;
}

function missionRowHtml(jobCode, mission, open, readOnly) {
  const key = String(mission?.key ?? "");
  const runId = mission?.runId;
  const added = mission?.addedByAdmin === true;
  const openHref = `/index.html?mission=${encodeURIComponent(key)}`;
  const runLink = runId
    ? `<a class="link" style="margin-left:10px" href="${esc(`#/runs/${encodeURIComponent(String(runId))}`)}">생성 기록 보기</a>`
    : "";
  const addedBadge = added ? `<span class="badge ac" style="margin-left:8px">관리자 추가</span>` : "";
  const del = added
    ? `<button type="button" class="link danger" style="margin-left:12px" data-testid="catalog-delete" data-key="${esc(key)}"${readOnly ? " disabled" : ""}>삭제</button>`
    : "";
  return `<tr class="sub" data-testid="catalog-mission" data-job="${esc(jobCode)}"${open ? "" : " hidden"}>
    <td colspan="4"><span class="badge" style="margin-right:8px">${esc(difficultyLabel(mission?.difficulty))}</span>${esc(mission?.title ?? "")}${addedBadge}${runLink}</td>
    <td class="num" style="white-space:nowrap"><a class="link" target="_blank" rel="noopener" href="${esc(openHref)}">열기 ${icon("open", { size: 12 })}</a>${del}</td>
  </tr>`;
}

function jobRowsHtml(job, open, readOnly) {
  const jobCode = String(job?.jobCode ?? "");
  const counts = job?.counts || {};
  const sum = DIFFICULTIES.reduce((acc, d) => acc + count(counts[d]), 0);
  const newBadge = job?.addedByAdminOnly === true ? ` <span class="badge ac" style="margin-left:6px">새 직업</span>` : "";
  const head = `<tr class="rowlink" tabindex="0" aria-expanded="${open ? "true" : "false"}" data-job="${esc(jobCode)}">
    <td class="ttl"><span class="chev-slot">${chevron(open)}</span>${esc(job?.jobName ?? jobCode)}${newBadge}</td>
    ${DIFFICULTIES.map((d) => `<td class="num">${esc(count(counts[d]))}</td>`).join("")}
    <td class="num">${esc(sum)}</td>
  </tr>`;
  return head + missionsOf(job).map((mission) => missionRowHtml(jobCode, mission, open, readOnly)).join("");
}

export function mount(view, ctx, params) {
  ctx.setCrumb("미션 카탈로그", "");
  view.innerHTML = `<div class="pagehead"><div><h1 class="h1">미션 카탈로그</h1><p class="sub">서비스에 올라가 있는 미션입니다.</p></div></div>
    <div data-role="body">${loadingLine()}</div>`;
  const body = view.querySelector('[data-role="body"]');

  // 펼친 직업은 목록을 다시 받아도(삭제 뒤) 그대로 둔다. 처음 보는 직업만 기본 규칙(관리자 추가 미션이 있으면 펼침)을 따른다
  const expanded = new Set();
  const seen = new Set();
  let loadSeq = 0;
  let loadedOnce = false;

  function render(data) {
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    for (const job of jobs) {
      const code = String(job?.jobCode ?? "");
      if (seen.has(code)) continue;
      seen.add(code);
      if (startsOpen(job)) expanded.add(code);
    }
    const table = jobs.length
      ? `<div class="card dtwrap">
          <table class="dt">
            <thead><tr><th>직업</th><th class="num">쉬움</th><th class="num">보통</th><th class="num">어려움</th><th class="num">합계</th></tr></thead>
            <tbody>${jobs.map((job) => jobRowsHtml(job, expanded.has(String(job?.jobCode ?? "")), ctx.readOnly)).join("")}</tbody>
          </table>
        </div>`
      : `<div class="card">${emptyLine("서비스에 올라가 있는 미션이 없습니다.")}</div>`;
    body.innerHTML = `${tilesHtml(data?.total)}${table}
      <div class="hint" style="margin-top:10px">"열기"는 사용자 화면에서 그 미션을 바로 엽니다. 삭제는 관리자 페이지에서 추가한 미션에만 있습니다.</div>`;
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const data = await adminApi.catalog();
      if (!view.isConnected || seq !== loadSeq) return;
      render(data);
      loadedOnce = true;
    } catch (err) {
      if (!view.isConnected || seq !== loadSeq) return;
      // 처음 불러오기에 실패하면 그 자리에 오류를, 다시 받기(삭제 뒤)에 실패하면 지금 표를 두고 알림만 띄운다
      if (loadedOnce) toast(errorMessage(err));
      else body.innerHTML = errorLine(errorMessage(err));
    }
  }

  function toggle(row) {
    const code = row.dataset.job ?? "";
    const open = !expanded.has(code);
    if (open) expanded.add(code);
    else expanded.delete(code);
    row.setAttribute("aria-expanded", open ? "true" : "false");
    const slot = row.querySelector(".chev-slot");
    if (slot) slot.innerHTML = chevron(open);
    for (const sub of body.querySelectorAll("tr.sub")) {
      if (sub.dataset.job === code) sub.hidden = !open;
    }
  }

  async function removeMission(button) {
    if (ctx.readOnly || button.disabled) return;
    const key = button.dataset.key ?? "";
    const ok = await confirmDialog({
      title: "서비스에서 빼기",
      body: "이 미션을 서비스에서 뺄까요? 생성 기록에는 남아서 다시 추가할 수 있습니다.",
      okLabel: "삭제",
      danger: true
    });
    if (!ok || !view.isConnected) return;
    button.disabled = true;
    try {
      await adminApi.removeFromCatalog(key);
      if (!view.isConnected) return;
      toast("서비스에서 뺐습니다.");
      await load();
    } catch (err) {
      if (!view.isConnected) return;
      button.disabled = false;
      toast(errorMessage(err));
    }
  }

  const onClick = (event) => {
    const del = event.target.closest('[data-testid="catalog-delete"]');
    if (del && body.contains(del)) {
      removeMission(del);
      return;
    }
    const row = event.target.closest("tr.rowlink");
    if (row && body.contains(row)) toggle(row);
  };
  const onKey = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr.rowlink");
    if (!row || row !== event.target || !body.contains(row)) return;
    event.preventDefault();
    toggle(row);
  };
  body.addEventListener("click", onClick);
  body.addEventListener("keydown", onKey);

  load();

  return () => {
    loadSeq += 1;
    body.removeEventListener("click", onClick);
    body.removeEventListener("keydown", onKey);
  };
}
