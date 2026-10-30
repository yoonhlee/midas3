import { api, esc, formatWon, getSession, loginUrl, qs, renderFooter, renderHeader, toast } from "./common/site.js";
import { initCompareTray, isInCompare, readCompare, toggleCompare, COMPARE_MAX } from "./common/compareTray.js";
import { pushRecent } from "./common/recent.js";
import { jobImage } from "./common/jobImages.js";
import { mountPostingsSection, renderPostingsSectionShell } from "./components/postingsSection.js";

const $ = (id) => document.getElementById(id);
const main = $("main");

const PROSPECT_COLORS = { "증가": "#5ec98e", "다소 증가": "#9ad9b5", "유지": "#8a8f98", "다소 감소": "#e8a47a", "감소": "#eb5757" };
const TRAIT_TABS = [
  { key: "abilities", label: "업무수행능력", limit: 10 },
  { key: "knowledge", label: "지식", limit: 8 },
  { key: "personality", label: "성격", limit: 8 },
  { key: "interests", label: "흥미", limit: 6 },
  { key: "values", label: "가치관", limit: 8 }
];

let job = null;
let descriptions = {};
let traitTab = "abilities";
let traitOrder = "within";
let interest = null;

function scoreRows(key, limit) {
  const rows = (job[key] || []).slice();
  if (traitOrder === "between") rows.sort((a, b) => (b[2] ?? -1) - (a[2] ?? -1));
  return rows.slice(0, limit).map(([name, within, between]) => {
    const desc = descriptions[key]?.[name];
    return `<div class="score-row">
      <div><div>${esc(name)}</div>${desc ? `<div class="small muted">${esc(desc)}</div>` : ""}</div>
      <div class="bar" title="직업 내 중요도 ${within ?? "-"} / 5"><i style="width:${Math.max(0, Math.min(100, ((within ?? 0) / 5) * 100))}%"></i></div>
      <div class="between">${between === null || between === undefined ? "-" : `다른 직업 대비 <strong>${between}</strong>`}</div>
    </div>`;
  }).join("") || `<p class="muted small">이 항목은 자료가 없어.</p>`;
}

function renderTraits() {
  const tab = TRAIT_TABS.find((t) => t.key === traitTab);
  $("traits").innerHTML = `
    <div class="tabs" role="tablist" aria-label="역량 종류">${TRAIT_TABS.map((t) => `<button class="btn btn-sm" role="tab" aria-selected="${t.key === traitTab}" data-tab="${t.key}"${t.key === traitTab ? " style=\"border-color:var(--a);color:var(--t1)\"" : ""}>${t.label}</button>`).join("")}</div>
    <div class="seg" role="group" aria-label="정렬 기준">
      <button type="button" data-order="within" aria-pressed="${traitOrder === "within"}">이 직업에서 중요한 순</button>
      <button type="button" data-order="between" aria-pressed="${traitOrder === "between"}">다른 직업보다 두드러진 순</button>
    </div>
    <p class="small muted" style="margin-bottom:6px">막대는 이 직업 안에서의 중요도(5점 만점), 오른쪽 숫자는 다른 직업과 비교한 수준(0~100, 높을수록 이 직업에서 두드러져).</p>
    ${scoreRows(tab.key, tab.limit)}`;
}

function prospectHtml() {
  const dist = job.prospect.distribution.filter((d) => d.ratio !== null);
  if (!dist.length) return `<p class="muted">전망 자료가 없어.</p>`;
  return `<div class="stack" role="img" aria-label="${esc(dist.map((d) => `${d.label} ${d.ratio}%`).join(", "))}">
      ${dist.map((d) => `<span style="width:${d.ratio}%;background:${PROSPECT_COLORS[d.label] || "#62666d"}"></span>`).join("")}
    </div>
    <div class="legend">${dist.map((d) => `<span><i style="background:${PROSPECT_COLORS[d.label] || "#62666d"}"></i>${esc(d.label)} ${d.ratio}%</span>`).join("")}</div>
    <p class="small muted" style="margin-top:6px">재직자가 예상한 향후 5년 일자리 변화(${job.prospect.year ?? "-"}년 조사)</p>
    ${job.prospect.text ? `<details style="margin-top:8px"><summary>전망 설명 보기</summary><p class="small" style="color:var(--t2);margin-top:6px">${esc(job.prospect.text)}</p></details>` : ""}`;
}

function educationHtml() {
  const e = job.education || {};
  const items = [["고졸 이하", e.hs_or_less], ["전문대졸", e.college], ["대졸", e.university], ["석사", e.master], ["박사", e.doctor]].filter(([, v]) => v);
  return items.length ? `<p class="small muted">재직자 학력: ${items.map(([k, v]) => `${k} ${v}%`).join(" · ")}</p>` : "";
}

function similarHtml() {
  if (!job.similar?.length) return `<p class="muted">비슷한 직무 자료가 없어.</p>`;
  return `<div class="grid grid-3">${job.similar.map((s) => `<article class="card sim-card">
      <a href="/job.html?code=${esc(s.code)}" style="font-weight:600;color:var(--t1);text-decoration:none">${esc(s.name)}</a>
      ${s.experienceable ? ` <span class="chip chip-ok">체험 가능</span>` : ""}
      <p class="why" style="margin-top:6px">공통점: ${s.common.map(esc).join(", ")}</p>
      <p class="why">차이: ${s.diff.map((d) => `${esc(d.name)} (이 직무 ${d.mine} · 저 직무 ${d.theirs})`).join(", ")}</p>
    </article>`).join("")}</div>
    <p class="small muted" style="margin-top:6px">KNOW 업무활동 41개의 중요도가 얼마나 비슷한지로 골랐어. 숫자는 5점 만점 중요도야.</p>`;
}

function unavailableHtml() {
  // 체험할 수 없는 직무 안내(U05-1): 비슷한 직무 중 체험 가능한 것, 없으면 체험 가능한 직무 목록으로
  const alt = (job.similar || []).filter((s) => s.experienceable);
  return `<div class="notice notice-warn" id="no-experience">
    아직 이 직무는 체험 미션이 없어. ${alt.length
      ? `대신 비슷한 일을 하는 ${alt.map((s) => `<a href="/job.html?code=${esc(s.code)}">${esc(s.name)}</a>`).join(", ")}을(를) 체험해볼 수 있어.`
      : `<a href="/jobs.html?exp=1">체험 가능한 직무 보기</a>에서 다른 직무를 골라봐.`}
  </div>`;
}

async function renderInterest() {
  const host = $("interest");
  const session = await getSession();
  if (!session.authenticated) {
    host.innerHTML = `<a class="btn" href="${esc(loginUrl())}">로그인하고 관심 직무 저장</a>`;
    return;
  }
  host.innerHTML = interest
    ? `<button class="btn" type="button" data-action="unsave" aria-pressed="true">관심 직무에서 빼기</button>
       <div class="memo-row"><label class="sr-only" for="memo">관심 메모</label><input class="input" id="memo" maxlength="100" placeholder="왜 관심이 생겼는지 한 줄 메모 (100자)" value="${esc(interest.memo || "")}"><button class="btn" type="button" data-action="memo">메모 저장</button></div>`
    : `<button class="btn" type="button" data-action="save" aria-pressed="false">관심 직무 저장</button>`;
}

function renderCompareButton() {
  const inCompare = isInCompare(job.code);
  $("compare-btn").textContent = inCompare ? "비교에서 빼기" : "비교 담기";
  $("compare-btn").setAttribute("aria-pressed", String(inCompare));
}

function render(meta) {
  document.title = `${job.name} — JOBSIM`;
  main.innerHTML = `
    <div class="hero">
      ${jobImage(job, { height: 96, label: true })}
      <div>
        <div class="eyebrow">${esc(job.lrcl)} · ${esc(job.mdcl)}</div>
        <h1 class="page-h">${esc(job.name)}</h1>
        <p style="color:var(--t2)">${esc(job.summary)}</p>
      </div>
    </div>
    <div class="actions">
      ${job.experienceable ? `<a class="btn btn-p" href="/index.html?job=${esc(job.code)}#simulation">이 직무 체험하기</a>` : ""}
      <button class="btn" type="button" id="compare-btn"></button>
      <span id="interest"></span>
    </div>
    ${job.experienceable ? "" : unavailableHtml()}

    <h2 class="sec-h">하는 일</h2>
    <ul class="duties">${job.duties.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>

    <h2 class="sec-h">필요한 역량</h2>
    <div id="traits"></div>

    <h2 class="sec-h">근무 환경</h2>
    <div>${(job.environment || []).slice(0, 6).map(([name, within, between]) => `<div class="score-row"><div>${esc(name)}</div><div class="bar"><i style="width:${((within ?? 0) / 5) * 100}%"></i></div><div class="between">${between ?? "-"}</div></div>`).join("") || `<p class="muted">자료가 없어.</p>`}</div>

    <h2 class="sec-h">임금·만족도·전망</h2>
    <div class="grid grid-3">
      <div class="card"><div class="small muted">연 임금(${job.salary.year ?? "-"}년 조사)</div>
        <div style="font-size:20px;font-weight:600">${formatWon(job.salary.p50)}</div>
        <div class="small muted">하위 25% ${formatWon(job.salary.p25)} · 상위 25% ${formatWon(job.salary.p75)}</div></div>
      <div class="card"><div class="small muted">직업 만족도</div><div style="font-size:20px;font-weight:600">${job.satisfaction ?? "-"}${job.satisfaction !== null ? "%" : ""}</div><div class="small muted">재직자 응답 기준</div></div>
      <div class="card"><div class="small muted">일자리 전망</div>${prospectHtml()}</div>
    </div>

    <h2 class="sec-h">어떻게 준비해?</h2>
    ${job.way ? `<p style="color:var(--t2);font-size:14px">${esc(job.way)}</p>` : ""}
    <div class="chips" style="margin-top:10px">${job.majors.map((m) => `<span class="chip">${esc(m)}</span>`).join("")}${job.certs.map((c) => `<span class="chip chip-a">${esc(c)}</span>`).join("")}</div>
    ${educationHtml()}

    <h2 class="sec-h">비슷한 일을 하는 직무</h2>
    <div id="similar">${similarHtml()}</div>

    <div id="postings-host"></div>

    <p class="source">출처: ${esc(meta.source)} · 임금 ${job.salary.year ?? "-"}년 · 전망 ${job.prospect.year ?? "-"}년 조사 · 역량·환경은 KNOW 재직자 조사 기준.
      ${job.keco ? `고용직업분류 ${esc(job.keco.code)} ${esc(job.keco.name)}.` : ""} 직업코드 ${esc(job.code)}</p>`;
  renderTraits();
  renderCompareButton();
  renderInterest();

  // 관련 채용 공고(U23): 공고 연결이 있는 직무만 보여준다.
  if (job.postings_status && job.postings_status !== "unmapped") {
    $("postings-host").innerHTML = renderPostingsSectionShell();
    mountPostingsSection($("postings-section"), { jobCode: job.code });
  }
}

async function loadInterest() {
  const session = await getSession();
  if (!session.authenticated) return;
  try {
    const data = await api("GET", "/api/me/interests");
    interest = data.interests.find((row) => row.job_code === job.code) || null;
  } catch (_) {
    interest = null;
  }
}

async function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest("#compare-btn")) {
    const result = toggleCompare(job);
    if (result === "full") toast(`비교는 ${COMPARE_MAX}개까지 담을 수 있어. 하나를 빼고 다시 담아줘.`);
    renderCompareButton();
    return;
  }
  const tab = target.closest("[data-tab]");
  if (tab) { traitTab = tab.dataset.tab; renderTraits(); return; }
  const order = target.closest("[data-order]");
  if (order) { traitOrder = order.dataset.order; renderTraits(); return; }
  const action = target.closest("[data-action]")?.dataset.action;
  try {
    if (action === "save") {
      interest = (await api("PUT", `/api/me/interests/${job.code}`, {})).interest;
      toast("관심 직무에 저장했어.");
      renderInterest();
    } else if (action === "unsave") {
      await api("DELETE", `/api/me/interests/${job.code}`);
      interest = null;
      toast("관심 직무에서 뺐어.");
      renderInterest();
    } else if (action === "memo") {
      interest = (await api("PUT", `/api/me/interests/${job.code}`, { memo: $("memo").value })).interest;
      toast("메모를 저장했어.");
    }
  } catch (error) {
    toast(error.message || "저장하지 못했어.");
  }
}

async function start() {
  renderHeader("jobs", { compareCount: readCompare().length });
  renderFooter();
  initCompareTray();
  const code = qs("code") || "";
  if (!/^K\d{9}$/.test(code)) {
    main.innerHTML = `<div class="empty">직무를 찾을 수 없어. <div class="btn-row"><a class="btn" href="/jobs.html">직무 탐색으로</a></div></div>`;
    return;
  }
  try {
    const res = await fetch(`/api/jobs/${code}`);
    if (res.status === 404) {
      main.innerHTML = `<div class="empty">그 직무는 없어. <div class="btn-row"><a class="btn" href="/jobs.html">직무 탐색으로</a></div></div>`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    job = data.job;
    descriptions = data.descriptions || {};
    pushRecent(job);
    await loadInterest();
    render(data.meta);
  } catch (error) {
    main.innerHTML = `<div class="notice notice-err">직무 정보를 불러오지 못했어. 잠시 후 다시 시도해줘.</div>`;
    return;
  }
  main.addEventListener("click", onClick);
  window.addEventListener("jobsim:compare-changed", renderCompareButton);
}

start();
