import { esc, formatWon, renderFooter, renderHeader, toast } from "./common/site.js";
import { filterJobs, suggestWhenEmpty } from "./common/jobSearch.js";
import { initCompareTray, isInCompare, readCompare, toggleCompare, COMPARE_MAX } from "./common/compareTray.js";
import { clearRecent, readRecent } from "./common/recent.js";
import { jobImage } from "./common/jobImages.js";

const PAGE = 30;
const STATE_KEY = "jobsim:explore-state:v1";
let allJobs = [];
let shown = PAGE;

const $ = (id) => document.getElementById(id);

// 탐색 상태 유지(U04-1): 검색어·필터는 주소에, 펼친 개수·스크롤은 세션 저장소에 둔다.
function readState() {
  const params = new URLSearchParams(location.search);
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || "{}");
  } catch (_) {
    saved = {};
  }
  const sameQuery = saved.query === location.search;
  return {
    q: params.get("q") || "",
    field: params.get("field") || "",
    exp: params.get("exp") === "1",
    shown: sameQuery && saved.shown ? saved.shown : PAGE,
    scrollY: sameQuery ? saved.scrollY || 0 : 0
  };
}

function writeState() {
  const params = new URLSearchParams();
  if ($("q").value.trim()) params.set("q", $("q").value.trim());
  if ($("field").value) params.set("field", $("field").value);
  if ($("exp").checked) params.set("exp", "1");
  const query = params.toString() ? `?${params}` : "";
  history.replaceState(null, "", `${location.pathname}${query}`);
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ query, shown, scrollY: window.scrollY }));
  } catch (_) {
    // 저장소를 못 쓰면 상태 유지만 빠진다.
  }
}

function compareButton(job) {
  const inCompare = isInCompare(job.code);
  return `<button class="btn btn-sm" type="button" data-compare="${esc(job.code)}" aria-pressed="${inCompare}">${inCompare ? "비교에서 빼기" : "비교 담기"}</button>`;
}

function card(job) {
  return `<article class="card job-card">
    <div class="top">
      ${jobImage(job, { height: 52 })}
      <div>
        <a class="name" href="/job.html?code=${esc(job.code)}">${esc(job.name)}</a>
        <div class="mdcl">${esc(job.lrcl)} · ${esc(job.mdcl)}</div>
      </div>
    </div>
    <div class="sum">${esc(job.summary)}</div>
    <div class="foot">
      <div class="chips">
        ${job.experienceable ? `<span class="chip chip-ok">체험 가능</span>` : ""}
        ${job.salary_p50 ? `<span class="chip">중위 임금 ${formatWon(job.salary_p50)}</span>` : ""}
      </div>
      ${compareButton(job)}
    </div>
  </article>`;
}

function renderEmpty(filters) {
  const s = suggestWhenEmpty(allJobs, filters);
  const parts = [];
  if (s.withoutField) parts.push(`<button class="btn btn-sm" type="button" data-action="clear-field">분야를 ‘전체’로 바꾸면 ${s.withoutField}개</button>`);
  if (s.withoutExperienceable) parts.push(`<button class="btn btn-sm" type="button" data-action="clear-exp">체험 가능만 끄면 ${s.withoutExperienceable}개</button>`);
  return `<div class="empty" style="grid-column:1/-1">
    <p><strong>‘${esc(filters.q || "")}’에 맞는 직무가 없어.</strong></p>
    ${parts.length ? `<div class="btn-row">${parts.join("")}</div>` : ""}
    ${s.similarNames.length ? `<p style="margin-top:12px">혹시 이 직무를 찾았어? ${s.similarNames.map((j) => `<a href="/job.html?code=${esc(j.code)}">${esc(j.name)}</a>`).join(", ")}</p>` : ""}
    <p style="margin-top:12px">이런 말로도 찾아봐: ${s.examples.map((w) => `<button class="btn btn-sm" type="button" data-example="${esc(w)}">${esc(w)}</button>`).join(" ")}</p>
  </div>`;
}

function render() {
  const filters = { q: $("q").value, field: $("field").value, experienceableOnly: $("exp").checked };
  const results = filterJobs(allJobs, filters);
  $("count").textContent = `${results.length}개 직무`;
  $("results").innerHTML = results.length ? results.slice(0, shown).map(card).join("") : renderEmpty(filters);
  $("more").hidden = results.length <= shown;
  $("more").textContent = `더 보기 (${results.length - shown}개 남음)`;
  renderRecent();
  writeState();
}

function renderRecent() {
  const recent = readRecent();
  $("recent").innerHTML = recent.length
    ? `<span class="small muted">최근 본 직무</span>${recent.map((item) => `<a class="chip" href="/job.html?code=${esc(item.code)}">${esc(item.name)}</a>`).join("")}<button class="btn btn-sm" type="button" data-action="clear-recent">지우기</button>`
    : "";
}

async function main() {
  renderHeader("jobs", { compareCount: readCompare().length });
  renderFooter();
  initCompareTray();
  const state = readState();
  $("q").value = state.q;
  $("exp").checked = state.exp;
  shown = state.shown;
  try {
    const res = await fetch("/api/jobs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allJobs = data.jobs;
    $("total").textContent = String(data.total);
    $("field").innerHTML = `<option value="">전체 분야</option>${data.fields.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("")}`;
    $("field").value = state.field;
  } catch (error) {
    $("results").innerHTML = `<div class="notice notice-err" style="grid-column:1/-1">직무 목록을 불러오지 못했어. 잠시 후 다시 시도해줘.</div>`;
    return;
  }
  render();
  if (state.scrollY) requestAnimationFrame(() => window.scrollTo(0, state.scrollY));

  let timer = null;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { shown = PAGE; render(); }, 120);
  });
  $("field").addEventListener("change", () => { shown = PAGE; render(); });
  $("exp").addEventListener("change", () => { shown = PAGE; render(); });
  $("more").addEventListener("click", () => { shown += PAGE; render(); });
  window.addEventListener("scroll", () => {
    clearTimeout(window.__exploreScroll);
    window.__exploreScroll = setTimeout(writeState, 150);
  }, { passive: true });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const compare = target.closest("[data-compare]");
    if (compare) {
      const job = allJobs.find((j) => j.code === compare.dataset.compare);
      const result = toggleCompare(job);
      if (result === "full") toast(`비교는 ${COMPARE_MAX}개까지 담을 수 있어. 하나를 빼고 다시 담아줘.`);
      render();
      return;
    }
    const action = target.closest("[data-action]")?.dataset.action;
    if (action === "clear-field") { $("field").value = ""; render(); }
    if (action === "clear-exp") { $("exp").checked = false; render(); }
    if (action === "clear-recent") { clearRecent(); renderRecent(); }
    const example = target.closest("[data-example]");
    if (example) { $("q").value = example.dataset.example; shown = PAGE; render(); }
  });
  window.addEventListener("jobsim:compare-changed", () => render());
}

main();
