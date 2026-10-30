import { api, esc, formatDate, getSession, loginUrl, qs, renderFooter, renderHeader, toast } from "./common/site.js";
import { readCompare, toggleCompare, isInCompare, COMPARE_MAX, initCompareTray } from "./common/compareTray.js";
import { jobImage } from "./common/jobImages.js";

const main = document.getElementById("main");
let data = null;

const MODE_LABEL = { llm: "AI 채점", heuristic: "임시 추정", fake: "가짜 채점(테스트)", precheck: "사전 점검", unavailable: "채점 실패" };

function statsHtml() {
  const c = data.counts;
  return `<div class="stats">
    <div class="card stat"><div class="n">${c.attempts}</div><div class="l">완료한 체험</div></div>
    <div class="card stat"><div class="n">${c.jobs_tried}</div><div class="l">체험한 직무</div></div>
    <div class="card stat"><div class="n">${c.missions}</div><div class="l">제출한 미션</div></div>
    <div class="card stat"><div class="n">${c.interests}</div><div class="l">관심 직무</div></div>
  </div>`;
}

function draftsHtml() {
  if (!data.drafts.length) return "";
  return `<h2 class="sec-h">쓰던 답안 이어 하기</h2>${data.drafts.map((d) => `<div class="card record">
      <div><div class="title">${esc(d.mission_title)}</div><div class="meta">${esc(d.job_name)} · 마지막 저장 ${formatDate(d.updated_at, true)} · ${d.answer.length}자</div></div>
      <div class="btn-row">${d.mission_available
        ? `<a class="btn btn-sm btn-p" href="/index.html?mission=${encodeURIComponent(d.mission_key)}&resume=1#simulation">이어 쓰기</a>`
        : `<span class="chip chip-warn">미션이 없어졌어</span>`}
        <button class="btn btn-sm" type="button" data-del-draft="${esc(d.mission_key)}">지우기</button></div>
    </div>`).join("")}`;
}

function interestsHtml() {
  const body = data.interests.length
    ? data.interests.map((i) => `<div class="card interest">
        <div class="record">
          <div style="display:flex;gap:10px;align-items:center">${jobImage({ code: i.job_code, lrcl: i.lrcl }, { height: 40 })}
            <div><a class="title" href="/job.html?code=${esc(i.job_code)}" style="color:var(--t1)">${esc(i.name)}</a><div class="meta">${esc(i.lrcl)} · 저장 ${formatDate(i.created_at)}</div></div></div>
          <div class="btn-row">
            ${i.experienceable ? `<a class="btn btn-sm btn-p" href="/index.html?job=${esc(i.job_code)}#simulation">체험하기</a>` : `<span class="chip">아직 미션 없음</span>`}
            <button class="btn btn-sm" type="button" data-compare="${esc(i.job_code)}" data-name="${esc(i.name)}">${isInCompare(i.job_code) ? "비교에서 빼기" : "비교 담기"}</button>
            <button class="btn btn-sm" type="button" data-unsave="${esc(i.job_code)}">빼기</button>
          </div>
        </div>
        <div class="memo-row"><label class="sr-only" for="memo-${esc(i.job_code)}">메모</label><input class="input" id="memo-${esc(i.job_code)}" maxlength="100" placeholder="한 줄 메모" value="${esc(i.memo)}"><button class="btn btn-sm" type="button" data-memo="${esc(i.job_code)}">메모 저장</button></div>
      </div>`).join("")
    : `<div class="empty">아직 저장한 관심 직무가 없어.<div class="btn-row"><a class="btn" href="/jobs.html">직무 둘러보기</a></div></div>`;
  return `<h2 class="sec-h">관심 직무</h2>${body}${data.interests.length > 1 ? `<div class="btn-row" style="margin-top:8px"><a class="btn btn-sm" href="/compare.html?codes=${data.interests.slice(0, 3).map((i) => i.job_code).join(",")}">관심 직무 ${Math.min(3, data.interests.length)}개 비교하기</a></div>` : ""}`;
}

function recordsHtml() {
  const done = data.attempts.filter((a) => a.has_result);
  const body = done.length
    ? done.map((a) => `<div class="card record">
        <div>
          <div class="title">${a.jobs.map((j) => esc(j.name)).join(", ")}</div>
          <div class="meta">${formatDate(a.completed_at || a.created_at, true)} · 미션 ${a.missions.length}개${a.rounds > 1 ? ` · ${a.rounds}회차까지 재도전` : ""} · 채점 방식: ${a.scoring_modes.map((m) => MODE_LABEL[m] || m).join(", ") || "-"}</div>
          <div class="meta">${a.missions.map((m) => esc(m.title)).join(" / ")}</div>
          ${a.mission_outdated ? `<span class="chip chip-warn" title="체험 뒤에 미션 내용이 바뀌었어">이전 버전 미션</span>` : ""}
        </div>
        <div class="btn-row"><a class="btn btn-sm btn-p" href="/index.html?attempt=${esc(a.id)}#simulation">결과 다시 보기</a><button class="btn btn-sm" type="button" data-del-attempt="${esc(a.id)}">기록 지우기</button></div>
      </div>`).join("")
    : `<div class="empty">아직 완료한 체험이 없어. 직무를 하나 골라 미션을 해봐.<div class="btn-row"><a class="btn btn-p" href="/index.html#simulation">체험하러 가기</a><a class="btn" href="/jobs.html">직무 둘러보기</a></div></div>`;
  return `<h2 class="sec-h">완료한 체험</h2>${body}`;
}

function accountHtml() {
  const u = data.user;
  return `<h2 class="sec-h">계정 설정</h2>
    <div class="card">
      <dl class="kv">
        <dt>로그인</dt><dd>${u.provider === "kakao" ? "카카오" : u.provider === "dev" ? "개발용 계정" : esc(u.provider)}</dd>
        <dt>가입일</dt><dd>${formatDate(u.created_at)}</dd>
      </dl>
      <form id="nick-form" style="margin-top:14px"><div class="field"><label for="nick">닉네임</label>
        <div style="display:flex;gap:8px"><input class="input" id="nick" maxlength="20" value="${esc(u.nickname)}"><button class="btn" type="submit">바꾸기</button></div></div></form>
      <div class="btn-row"><a class="btn btn-sm" href="/terms.html">이용약관</a><a class="btn btn-sm" href="/privacy.html">개인정보 처리방침</a><button class="btn btn-sm" type="button" id="logout">로그아웃</button></div>
    </div>
    <div class="card danger-zone">
      <strong>탈퇴</strong>
      <p class="small muted" style="margin:6px 0 10px">탈퇴하면 계정, 체험 기록, 관심 직무, 쓰던 답안이 바로 모두 지워지고 카카오 연결도 끊겨. 되돌릴 수 없어.</p>
      <form id="withdraw-form"><div class="field"><label for="withdraw-confirm">확인을 위해 ‘탈퇴’라고 입력해줘</label>
        <input class="input" id="withdraw-confirm" autocomplete="off"></div><button class="btn btn-danger" type="submit">탈퇴하기</button></form>
    </div>`;
}

function render() {
  const claimed = Number(qs("claimed") || 0);
  main.innerHTML = `
    <div class="eyebrow">내 기록</div>
    <h1 class="page-h">${esc(data.user.nickname)}의 진로 기록</h1>
    ${claimed ? `<div class="notice notice-ok">로그인 전에 한 체험 결과 ${claimed}개를 내 기록으로 옮겼어.</div>` : ""}
    ${statsHtml()}
    ${draftsHtml()}
    ${recordsHtml()}
    ${interestsHtml()}
    ${accountHtml()}`;
  bind();
}

async function reload() {
  data = await api("GET", "/api/me/summary");
  render();
}

function bind() {
  document.getElementById("nick-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("PATCH", "/api/me", { nickname: document.getElementById("nick").value });
      await getSession({ refresh: true });
      toast("닉네임을 바꿨어.");
      renderHeader("me");
      await reload();
    } catch (error) {
      toast(error.message);
    }
  });
  document.getElementById("logout").addEventListener("click", async () => {
    await api("POST", "/api/auth/logout").catch(() => {});
    location.href = "/index.html";
  });
  document.getElementById("withdraw-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const confirmText = document.getElementById("withdraw-confirm").value.trim();
    if (confirmText !== "탈퇴") return toast("‘탈퇴’라고 정확히 입력해줘.");
    try {
      const result = await api("DELETE", "/api/me", { confirm: confirmText });
      if (result.kakao_unlink === "failed") alert("기록은 모두 지웠지만 카카오 연결 끊기는 실패했어. 카카오 계정 설정에서 직접 연결을 끊을 수 있어.");
      location.href = "/index.html";
    } catch (error) {
      toast(error.message);
    }
  });
}

main.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  try {
    const unsave = target.closest("[data-unsave]");
    if (unsave) { await api("DELETE", `/api/me/interests/${unsave.dataset.unsave}`); toast("관심 직무에서 뺐어."); return reload(); }
    const memo = target.closest("[data-memo]");
    if (memo) {
      const code = memo.dataset.memo;
      await api("PUT", `/api/me/interests/${code}`, { memo: document.getElementById(`memo-${code}`).value });
      return toast("메모를 저장했어.");
    }
    const compare = target.closest("[data-compare]");
    if (compare) {
      const result = toggleCompare({ code: compare.dataset.compare, name: compare.dataset.name });
      if (result === "full") toast(`비교는 ${COMPARE_MAX}개까지 담을 수 있어.`);
      return render();
    }
    const delAttempt = target.closest("[data-del-attempt]");
    if (delAttempt) {
      if (!confirm("이 체험 기록을 지울까? 되돌릴 수 없어.")) return;
      await api("DELETE", `/api/attempts/${delAttempt.dataset.delAttempt}`);
      toast("기록을 지웠어.");
      return reload();
    }
    const delDraft = target.closest("[data-del-draft]");
    if (delDraft) { await api("DELETE", `/api/me/drafts/${encodeURIComponent(delDraft.dataset.delDraft)}`); return reload(); }
  } catch (error) {
    toast(error.message);
  }
});

async function start() {
  renderHeader("me", { compareCount: readCompare().length });
  renderFooter();
  initCompareTray();
  const session = await getSession();
  if (!session.authenticated) {
    main.innerHTML = `<div class="eyebrow">내 기록</div><h1 class="page-h">로그인하면 기록을 볼 수 있어</h1>
      <p class="page-sub">지난 체험 결과, 관심 직무, 쓰던 답안이 여기에 모여.</p>
      <a class="btn btn-p" href="${esc(loginUrl("/me.html"))}">로그인</a>`;
    return;
  }
  try {
    await reload();
  } catch (error) {
    main.innerHTML = `<div class="notice notice-err">기록을 불러오지 못했어. ${esc(error.message)}</div>`;
  }
}

start();
