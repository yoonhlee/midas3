import { api, esc, formatWon, getSession, loginUrl, qs, renderFooter, renderHeader, toast } from "./common/site.js";
import { clearCompare, readCompare, removeFromCompare } from "./common/compareTray.js";
import { jobImage } from "./common/jobImages.js";

const host = document.getElementById("compare");
let interests = new Set();

function list(items, n) {
  const rows = (items || []).slice(0, n);
  return rows.length ? `<ul>${rows.map((item) => `<li>${esc(Array.isArray(item) ? item[0] : item)}</li>`).join("")}</ul>` : `<span class="muted">자료 없음</span>`;
}

// 다른 직업보다 두드러진 능력(직업 간 비교 값이 큰 순)
function standout(items, n) {
  return list((items || []).filter((row) => row[2] !== null).slice().sort((a, b) => b[2] - a[2]).slice(0, n), n);
}

function prospectUp(job) {
  const up = job.prospect.distribution.filter((d) => d.label === "증가" || d.label === "다소 증가").reduce((s, d) => s + (d.ratio || 0), 0);
  return job.prospect.distribution.length ? `증가 예상 ${up}% <span class="muted small">(${job.prospect.year ?? "-"}년)</span>` : `<span class="muted">자료 없음</span>`;
}

function render(jobs, session) {
  if (!jobs.length) {
    host.innerHTML = `<div class="empty">아직 비교할 직무를 담지 않았어.
      <div class="btn-row"><a class="btn btn-p" href="/jobs.html">직무 탐색에서 담기</a></div></div>`;
    return;
  }
  const rows = [
    ["분야", (j) => `${esc(j.lrcl)}<div class="small muted">${esc(j.mdcl)}</div>`],
    ["하는 일", (j) => `<span style="color:var(--t2)">${esc(j.summary)}</span>`],
    ["중요한 업무수행능력", (j) => list(j.abilities, 5)],
    ["다른 직업보다 두드러진 능력", (j) => standout(j.abilities, 3)],
    ["중요한 지식", (j) => list(j.knowledge, 3)],
    ["근무 환경", (j) => list(j.environment, 3)],
    ["흥미 유형", (j) => list(j.interests, 2)],
    ["연 임금(중위)", (j) => `${formatWon(j.salary.p50)} <span class="muted small">(${j.salary.year ?? "-"}년)</span>`],
    ["직업 만족도", (j) => (j.satisfaction !== null ? `${j.satisfaction}%` : `<span class="muted">자료 없음</span>`)],
    ["일자리 전망", prospectUp],
    ["체험", (j) => (j.experienceable ? `<a class="btn btn-sm btn-p" href="/index.html?job=${esc(j.code)}#simulation">체험하기</a>` : `<span class="muted">아직 미션 없음</span>`)],
    ["관심 직무", (j) => (session.authenticated
      ? `<button class="btn btn-sm" type="button" data-interest="${esc(j.code)}" aria-pressed="${interests.has(j.code)}">${interests.has(j.code) ? "저장됨 · 빼기" : "관심 저장"}</button>`
      : `<a class="btn btn-sm" href="${esc(loginUrl())}">로그인하고 저장</a>`)]
  ];
  host.innerHTML = `<div class="table-wrap"><table class="compare">
    <thead><tr><th scope="col"><span class="sr-only">항목</span></th>${jobs.map((j) => `<th scope="col"><div class="col-head">
      ${jobImage(j, { height: 44 })}
      <a class="name" href="/job.html?code=${esc(j.code)}">${esc(j.name)}</a>
      <button class="btn btn-sm" type="button" data-remove="${esc(j.code)}">비교에서 빼기</button></div></th>`).join("")}</tr></thead>
    <tbody>${rows.map(([label, fn]) => `<tr><th scope="row">${label}</th>${jobs.map((j) => `<td>${fn(j)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>
  <div class="btn-row" style="margin-top:12px"><a class="btn" href="/jobs.html">직무 더 담기</a><button class="btn" type="button" data-action="clear">모두 비우기</button></div>
  <p class="small muted" style="margin-top:12px">출처: 한국고용정보원 한국직업정보(KNOW). 능력·지식 순서는 그 직업 안에서 중요한 순서야.</p>`;
}

async function load() {
  // 주소에 codes가 있으면(공유 링크) 그걸 쓰고, 없으면 담아둔 목록을 쓴다.
  const fromUrl = (qs("codes") || "").split(",").filter((c) => /^K\d{9}$/.test(c)).slice(0, 3);
  const codes = fromUrl.length ? fromUrl : readCompare().map((item) => item.code);
  const session = await getSession();
  if (session.authenticated) {
    try {
      interests = new Set((await api("GET", "/api/me/interests")).interests.map((row) => row.job_code));
    } catch (_) {
      interests = new Set();
    }
  }
  if (!codes.length) return render([], session);
  try {
    const data = await api("GET", `/api/jobs/compare?codes=${codes.join(",")}`);
    render(data.jobs, session);
  } catch (error) {
    host.innerHTML = `<div class="notice notice-err">비교 정보를 불러오지 못했어. 잠시 후 다시 시도해줘.</div>`;
  }
}

host.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const remove = target.closest("[data-remove]");
  if (remove) {
    removeFromCompare(remove.dataset.remove);
    history.replaceState(null, "", location.pathname);
    return load();
  }
  if (target.closest("[data-action='clear']")) {
    clearCompare();
    history.replaceState(null, "", location.pathname);
    return load();
  }
  const interest = target.closest("[data-interest]");
  if (interest) {
    const code = interest.dataset.interest;
    try {
      if (interests.has(code)) {
        await api("DELETE", `/api/me/interests/${code}`);
        interests.delete(code);
      } else {
        await api("PUT", `/api/me/interests/${code}`, {});
        interests.add(code);
      }
      load();
    } catch (error) {
      toast(error.message);
    }
  }
});

renderHeader("compare", { compareCount: readCompare().length });
renderFooter();
load();
