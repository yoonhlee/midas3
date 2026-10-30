/* 결과 화면 확장: 저장 상태, 결과 해석(U17), 근거 강조(U19), 흥미 변화(U22), 재도전(U21), 다음 미션(U20), 강점 공고(U24), 공고 요구역량(U25), 결과 카드(U03) */

import { averageAxisScores, radarSvg } from "./radar.js";

const SCORING_LABEL = { llm: "AI 채점", heuristic: "임시 추정(키 없음)", fake: "가짜 채점(테스트·시연용)", precheck: "사전 점검", unavailable: "채점 실패" };

export function roundOneLogs(state) {
  return (state.evaluationLogs || []).filter((log) => (log.round || 1) === 1);
}

function fmt(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

// 받침에 맞춰 조사를 고른다: withJosa("정보분석·논리", "이", "가") → "정보분석·논리가"
export function withJosa(word, withBatchim, withoutBatchim) {
  const text = String(word || "");
  const code = text.charCodeAt(text.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return `${text}${withBatchim}(${withoutBatchim})`;
  return `${text}${(code - 0xac00) % 28 ? withBatchim : withoutBatchim}`;
}

// ── 저장 상태 + 체험 후 질문(U22) ─────────────────────────
export function renderResultStatus({ state, esc }) {
  const notes = [];
  if (state.viewingAttempt) {
    notes.push(`<div class="notice">저장된 결과를 다시 보는 중이야 · ${esc(state.viewingAttempt.date || "")}${state.viewingAttempt.outdated ? " · <span style=\"color:var(--warn)\">체험 뒤에 미션 내용이 바뀌었어(이전 버전 미션)</span>" : ""} · <a href="/me.html">내 기록으로</a></div>`);
  } else if (state.attemptSave === "account") {
    notes.push(`<div class="notice notice-ok" id="save-status">이 결과는 내 기록에 저장됐어. <a href="/me.html">내 기록 보기</a></div>`);
  } else if (state.attemptSave === "anonymous" && state.attemptId) {
    const back = encodeURIComponent(`/index.html?attempt=${state.attemptId}#simulation`);
    notes.push(`<div class="notice" id="save-status">로그인하면 이 결과를 내 기록에 저장할 수 있어(24시간 안에). <a href="/login.html?return=${back}">로그인하고 저장하기</a></div>`);
  } else if (state.attemptSave === "failed") {
    notes.push(`<div class="notice notice-warn" id="save-status">결과를 기록에 저장하지 못했어. 화면은 그대로 볼 수 있어.</div>`);
  }
  if (state.evalMode === "fake") {
    notes.push(`<div class="notice notice-warn">가짜 채점 모드(테스트·시연용)야. 점수는 실제 평가가 아니야.</div>`);
  }
  return notes.join("");
}

const SCALE = [1, 2, 3, 4, 5];

function scaleInput(name, label, value, lowText, highText) {
  return `<fieldset class="sr-scale"><legend>${label}</legend>
    <div class="sr-opts">${SCALE.map((v) => `<label><input type="radio" name="${name}" value="${v}"${Number(value) === v ? " checked" : ""}> ${v}</label>`).join("")}</div>
    <div class="sr-ends"><span>${lowText}</span><span>${highText}</span></div></fieldset>`;
}

export function renderPostSurvey({ state }) {
  if (state.viewingAttempt) return "";
  const job = state.selectedJobs[0];
  const post = state.selfReports?.post?.[job];
  if (post?.submitted) return "";
  return `<div class="rs" id="post-survey"><div class="rs-title">해보니 어땠어?</div>
    <p class="axis-note">솔직하게 답하면 체험 전후 흥미 변화를 결과에 함께 보여줄게. 건너뛰어도 돼.</p>
    ${scaleInput("sr-interest", "이 일이 얼마나 흥미로웠어?", post?.interest, "전혀", "매우")}
    ${scaleInput("sr-difficulty", "얼마나 어려웠어?", post?.difficulty, "쉬움", "어려움")}
    <fieldset class="sr-scale"><legend>이 일을 더 해보고 싶어?</legend><div class="sr-opts">
      ${[["yes", "더 해보고 싶어"], ["maybe", "글쎄"], ["no", "아니"]].map(([v, t]) => `<label><input type="radio" name="sr-again" value="${v}"${post?.again === v ? " checked" : ""}> ${t}</label>`).join("")}
    </div></fieldset>
    <button class="btn btn-p" id="btn-survey-save" type="button">답변 저장</button>
  </div>`;
}

// ── 체험 전후 흥미 변화(U22) ─────────────────────────────
export function renderInterestChange({ state, jobDefs, esc }) {
  const rows = state.selectedJobs.map((code) => {
    const pre = Number(state.preqAnswers?.[code]?.interest_pre) || null;
    const post = state.selfReports?.post?.[code];
    if (!pre && !post?.interest) return "";
    const job = jobDefs.find((j) => j.job_code === code);
    const diff = pre && post?.interest ? post.interest - pre : null;
    const diffText = diff === null ? "" : diff > 0 ? `<b style="color:var(--success)">+${diff}</b>` : diff < 0 ? `<b style="color:var(--danger)">${diff}</b>` : "변화 없음";
    return `<div class="ic-row"><span>${esc(job?.job_name || code)}</span>
      <span>체험 전 <b>${pre ?? "-"}</b> → 체험 후 <b>${post?.interest ?? "-"}</b> ${diffText}</span>
      ${post?.difficulty ? `<span class="axis-note">어려움 ${post.difficulty}/5 · 더 해보고 싶음: ${{ yes: "응", maybe: "글쎄", no: "아니" }[post.again] || "-"}</span>` : ""}</div>`;
  }).join("");
  if (!rows.trim()) return "";
  return `<div class="rs" id="interest-change"><div class="rs-title">체험 전후 흥미 변화</div>${rows}
    <p class="axis-note">내가 직접 고른 값(1~5)이야. 점수와 따로 보면 돼.</p></div>`;
}

// ── 결과 해석(U17): 수행 수준 · 직무 유사도 · 측정 범위를 나눠서 ──
export function renderInterpretation({ state, axes, axisLabels, jobDefs, esc }) {
  const logs = roundOneLogs(state);
  if (!logs.length) return "";
  const summary = state.resultSummary || {};
  const avg = averageAxisScores(axes, logs);
  const measured = summary.measuredAxes || axes;
  const unmeasured = axes.filter((a) => !measured.includes(a));
  const ranked = measured.slice().sort((a, b) => avg[b] - avg[a]);
  const top = ranked[0];
  const low = ranked[ranked.length - 1];
  const sources = [...new Set(logs.map((l) => l.evaluation?.source || "llm"))];
  const confidences = logs.flatMap((l) => axes.map((a) => Number(l.evaluation?.axes?.[a]?.confidence) || 0));
  const avgConf = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const compat = state.selectedJobs.map((code) => {
    const job = jobDefs.find((j) => j.job_code === code);
    const meta = summary.selectedJobMeta?.[code] || {};
    return `<li>${esc(job?.job_name || code)}: <b>${state.compatibility?.[code] ?? 0}%</b>${meta.referenceJobName ? ` <span class="axis-note">(기준: ${esc(meta.referenceJobName)})</span>` : ""}</li>`;
  }).join("");
  return `<div class="rs" id="interpretation"><div class="rs-title">결과를 이렇게 읽어줘</div>
    <div class="interp-grid">
      <div class="interp-card"><div class="interp-k">수행 수준</div>
        <p>답변에서 실제로 드러난 역량이야(0~4점). 가장 잘 드러난 건 <b>${esc(axisLabels[top])}</b> ${fmt(avg[top])}점${low && low !== top ? `, 가장 덜 드러난 건 <b>${esc(axisLabels[low])}</b> ${fmt(avg[low])}점` : ""}이야.</p></div>
      <div class="interp-card"><div class="interp-k">직무 유사도</div>
        <ul>${compat}</ul>
        <p class="axis-note">답변의 5축 비중이 KNOW 재직자 직무 프로필과 얼마나 비슷한지야. 잘했다는 뜻이 아니라 ‘결이 비슷하다’는 뜻이야.</p></div>
      <div class="interp-card"><div class="interp-k">측정 범위</div>
        <p>미션 ${logs.length}개로 잰 결과야. ${unmeasured.length ? `이번 미션은 <b>${esc(withJosa(unmeasured.map((a) => axisLabels[a]).join(", "), "을", "를"))}</b> 거의 재지 않았어.` : "다섯 축을 모두 조금씩 쟀어."}</p>
        <p class="axis-note">채점: ${sources.map((s) => SCORING_LABEL[s] || s).join(", ")} · 평균 확실도 ${Math.round(avgConf * 100)}%</p></div>
    </div></div>`;
}

// ── 답변 근거 강조(U19) ──────────────────────────────
function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// 인용구가 이 문장에 해당하는지(정확히 포함하거나 단어 대부분이 겹치면)
export function quoteMatchesSentence(quote, sentence) {
  const q = normalize(quote);
  const s = normalize(sentence);
  if (!q || !s) return false;
  if (s.includes(q) || q.includes(s)) return true;
  const tokens = q.split(" ").filter((t) => t.length >= 2);
  if (tokens.length < 3) return false;
  return tokens.filter((t) => s.includes(t)).length / tokens.length >= 0.75;
}

export function renderEvidenceHighlight({ state, axes, axisLabels, esc }) {
  const logs = roundOneLogs(state).filter((log) => log.answer);
  if (!logs.length) return "";
  const blocks = logs.map((log, index) => {
    const evidenceByAxis = Object.fromEntries(axes.map((axis) => [axis, (log.evaluation?.axes?.[axis]?.evidence || []).map((e) => e.quote)]));
    const sentences = splitSentences(log.answer).map((sentence) => {
      const hits = axes.filter((axis) => evidenceByAxis[axis].some((quote) => quoteMatchesSentence(quote, sentence)));
      return hits.length ? `<mark data-axes="${hits.join(" ")}">${esc(sentence)}</mark>` : `<span>${esc(sentence)}</span>`;
    }).join(" ");
    const available = axes.filter((axis) => evidenceByAxis[axis].length);
    return { index, title: log.mission_title, sentences, available };
  });
  const allAxes = axes.filter((axis) => blocks.some((b) => b.available.includes(axis)));
  if (!allAxes.length) {
    return `<div class="rs" id="evidence-highlight"><div class="rs-title">내 답변의 근거 문장</div><p class="axis-note">이번 채점에서는 답변에서 인용한 근거 문장이 없어. 수치·관찰·판단 이유를 문장으로 써 주면 근거로 잡혀.</p></div>`;
  }
  return `<div class="rs" id="evidence-highlight"><div class="rs-title">내 답변의 근거 문장</div>
    <p class="axis-note">역량을 누르면 그 역량이 드러난 내 문장이 강조돼.</p>
    <div class="hl-axes" role="group" aria-label="역량 고르기">${allAxes.map((axis, i) => `<button type="button" class="btn btn-g hl-btn" data-hl-axis="${axis}" aria-pressed="${i === 0}">${esc(axisLabels[axis])}</button>`).join("")}</div>
    ${blocks.map((b) => `<div class="hl-wrap" data-axis="${allAxes[0]}"><div class="hl-title">${esc(b.title)}</div><p class="hl-text">${b.sentences}</p></div>`).join("")}
  </div>`;
}

// ── 재도전(U21) ────────────────────────────────────────
export function renderRetrySection({ state, axes, axisLabels, esc }) {
  const first = roundOneLogs(state)[0];
  if (!first) return "";
  const retry = state.retry;
  if (retry?.second) {
    const before = Object.fromEntries(axes.map((a) => [a, Number(retry.first?.evaluation?.axes?.[a]?.score) || 0]));
    const after = Object.fromEntries(axes.map((a) => [a, Number(retry.second?.evaluation?.axes?.[a]?.score) || 0]));
    const rows = axes.map((a) => {
      const d = after[a] - before[a];
      return `<tr><td>${esc(axisLabels[a])}</td><td>${before[a]}</td><td>${after[a]}</td><td>${d > 0 ? `<b style="color:var(--success)">+${d}</b>` : d < 0 ? `<b style="color:var(--danger)">${d}</b>` : "0"}</td></tr>`;
    }).join("");
    return `<div class="rs" id="retry-result"><div class="rs-title">재도전 점수 변화</div>
      <div class="retry-grid"><div>${radarSvg({ axes, labels: axisLabels, idPrefix: "retry-radar", series: [
        { label: "1차", values: before, color: "#8a8f98", fill: "rgba(138,143,152,.12)", dashed: true },
        { label: "2차", values: after, color: "#5e6ad2", fill: "rgba(94,106,210,.30)" }
      ] })}<div class="axis-note">점선 1차 · 실선 2차</div></div>
      <table class="gap-tbl retry-tbl"><thead><tr><th>역량</th><th>1차</th><th>2차</th><th>변화</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="axis-note">해설을 본 뒤 다시 쓴 답이라 점수가 오르는 게 자연스러워. 처음 결과(위)는 그대로 두고 비교만 보여줘.</p></div>`;
  }
  if (state.viewingAttempt) return "";
  return `<div class="rs" id="retry-offer"><div class="rs-title">해설 보고 다시 도전</div>
    <p class="axis-note">이 미션의 기대 답안 방향과 채점 기준을 보여줄게. 같은 미션을 다시 내면 1차와 2차를 레이더로 겹쳐 비교해줘.</p>
    <button class="btn btn-p" type="button" id="btn-retry-open" data-mission-key="${esc(first.mission_key)}">해설 보기</button></div>`;
}

export function renderRetryScreen({ state, mission, axes, axisLabels, esc }) {
  const first = state.retry?.first;
  // 해설은 제출한 뒤 서버(/api/missions/:key/explanation)에서 받아 온 것만 쓴다.
  const evaluation = state.retry?.explanation || {};
  const weak = axes
    .filter((a) => Number(mission.axis_signals?.[a] || 0) >= 0.1)
    .map((a) => ({ axis: a, score: Number(first?.evaluation?.axes?.[a]?.score) || 0, reason: first?.evaluation?.axes?.[a]?.reason || "" }))
    .sort((x, y) => x.score - y.score)
    .slice(0, 2);
  return `<div class="sec-head"><div class="eyebrow">재도전</div><div class="sec-h">${esc(mission.title)}</div>
    <div class="sec-sub">해설은 제출한 뒤에만 볼 수 있어. 기준을 보고 답을 고쳐서 다시 내봐.</div></div>
    <div class="retry-layout">
      <div class="card">
        <div class="pq-lbl">아쉬웠던 부분(1차 채점)</div>
        <ul class="retry-list">${weak.map((w) => `<li><b>${esc(axisLabels[w.axis])}</b> ${w.score}/4 — ${esc(w.reason).slice(0, 160)}</li>`).join("") || "<li>특별히 낮은 축이 없어.</li>"}</ul>
        <div class="pq-lbl" style="margin-top:14px">기대 답안 방향</div>
        <ul class="retry-list">${(evaluation.expected_insights || []).map((i) => `<li>${esc(i)}</li>`).join("") || "<li>이 미션에는 해설이 없어.</li>"}</ul>
        <div class="pq-lbl" style="margin-top:14px">채점 기준</div>
        <ul class="retry-list">${(evaluation.rubric || []).map((r) => `<li><b>${esc(r.criterion)}</b>${r.points ? ` (${esc(r.points)}점)` : ""} — ${esc(r.description || "")}</li>`).join("")}</ul>
      </div>
      <div class="card">
        <div class="pq-lbl">다시 쓰기</div>
        <textarea id="retry-ans" rows="12">${esc(state.retry?.draft ?? first?.answer ?? "")}</textarea>
        <div class="char-ct" id="retry-ct">${(state.retry?.draft ?? first?.answer ?? "").length}자</div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn btn-g" id="btn-retry-cancel" type="button">← 결과로 돌아가기</button>
          <button class="btn btn-p" id="btn-retry-submit" type="button" style="margin-left:auto">다시 제출</button>
        </div>
        <div id="retry-error"></div>
      </div>
    </div>`;
}

// ── 다음 미션 추천(U20): 덜 잰 역량을 재는 미션 ───────────────
export function pickNextMissions({ state, axes, allMissions, limit = 3 }) {
  const coverage = state.resultSummary?.axisCoverage || {};
  const done = new Set(roundOneLogs(state).map((log) => log.mission_key));
  const ranked = axes.slice().sort((a, b) => {
    const ma = coverage[a]?.measured === false ? -1 : (coverage[a]?.totalSignal ?? 0);
    const mb = coverage[b]?.measured === false ? -1 : (coverage[b]?.totalSignal ?? 0);
    return ma - mb;
  });
  const targetAxes = ranked.slice(0, 2);
  const currentJobs = new Set(state.selectedJobs);
  const picks = [];
  for (const axis of targetAxes) {
    const candidates = (allMissions || [])
      .filter((m) => !done.has(m.key) && !picks.some((p) => p.mission.key === m.key))
      .map((m) => ({ mission: m, axis, signal: Number(m.axis_signals?.[axis] || 0) }))
      .filter((c) => c.signal > 0.08)
      .sort((x, y) => (y.signal + (currentJobs.has(y.mission.job_code) ? 0.05 : 0)) - (x.signal + (currentJobs.has(x.mission.job_code) ? 0.05 : 0)));
    picks.push(...candidates.slice(0, 2));
  }
  return { targetAxes, picks: picks.slice(0, limit) };
}

export function renderNextMissions({ state, axes, axisLabels, allMissions, esc }) {
  if (!roundOneLogs(state).length) return "";
  const { targetAxes, picks } = pickNextMissions({ state, axes, allMissions });
  if (!picks.length) return "";
  return `<div class="rs" id="next-missions"><div class="rs-title">다음에 해볼 미션</div>
    <p class="axis-note">이번에 덜 잰 역량(${targetAxes.map((a) => esc(axisLabels[a])).join(", ")})을 재는 미션이야. 결과가 더 고르게 나와.</p>
    <div class="next-list">${picks.map((p) => `<a class="next-card" href="/index.html?mission=${encodeURIComponent(p.mission.key)}#simulation">
      <span class="next-axis">${esc(axisLabels[p.axis])} 측정</span><span class="next-title">${esc(p.mission.title)}</span><span class="axis-note">${esc(p.mission.job_name)}</span></a>`).join("")}</div></div>`;
}

// ── 강점 역량 기반 공고(U24) · 공고 요구역량 비교(U25) — 비동기로 채운다 ──
export function renderStrengthShell() {
  return `<div class="rs" id="strength-jobs"><div class="rs-title">내 강점 역량으로 찾은 직무와 공고</div><div class="pst-skeleton" aria-hidden="true"><div class="pst-sk pst-sk-line"></div></div></div>`;
}

export function strongestAxis(axes, avg) {
  const strong = axes.filter((a) => avg[a] >= 3).sort((a, b) => avg[b] - avg[a]);
  if (strong.length) return { axis: strong[0], strong: true };
  const best = axes.slice().sort((a, b) => avg[b] - avg[a])[0];
  return { axis: best, strong: false };
}

export async function mountStrengthJobs({ root, state, axes, axisLabels, jobsByAxisRequest, esc }) {
  if (!root) return;
  const avg = averageAxisScores(axes, roundOneLogs(state));
  const { axis, strong } = strongestAxis(axes, avg);
  try {
    const data = await jobsByAxisRequest(axis);
    const jobs = data.jobs.slice(0, 6);
    root.innerHTML = `<div class="rs-title">내 강점 역량으로 찾은 직무와 공고</div>
      <p class="axis-note">${strong ? `3점(75%) 이상으로 잘 드러난` : `이번에 가장 잘 드러난`} <b>${esc(axisLabels[axis])}</b>(${fmt(avg[axis])}점) 비중이 큰 직무야. 공고가 연결된 직무는 바로 공고를 볼 수 있어.</p>
      <div class="next-list">${jobs.map((j) => {
        const hasPostings = j.postings_status === "ok" || j.postings_status === "stale";
        return `<a class="next-card" href="/job.html?code=${esc(j.code)}${hasPostings ? "#postings-section" : ""}"><span class="next-title">${esc(j.name)}</span>
          <span class="axis-note">${esc(j.lrcl)}</span>
          <span>${hasPostings ? `<span class="chip-mini ok">공고 보기</span>` : ""}${j.experienceable ? `<span class="chip-mini">체험 가능</span>` : ""}</span></a>`;
      }).join("")}</div>`;
  } catch (_) {
    root.innerHTML = `<div class="rs-title">내 강점 역량으로 찾은 직무와 공고</div><p class="axis-note">지금은 불러오지 못했어.</p>`;
  }
}

export function renderRequirementShell() {
  return `<div class="rs" id="req-compare"><div class="rs-title">공고가 요구하는 역량 vs 내 결과</div><div class="pst-skeleton" aria-hidden="true"><div class="pst-sk pst-sk-line"></div></div></div>`;
}

export async function mountRequirementCompare({ root, state, axes, axisLabels, postingRequirementsRequest, esc }) {
  if (!root) return;
  const code = state.selectedJobs[0];
  const avg = averageAxisScores(axes, roundOneLogs(state));
  try {
    const data = await postingRequirementsRequest(code);
    if ((data.status !== "ok" && data.status !== "stale") || !data.analyzed_postings || !data.axes) {
      root.remove();
      return;
    }
    const rows = axes.map((a) => {
      const req = Math.round((data.axes[a]?.share || 0) * 100);
      const mine = Math.round((avg[a] / 4) * 100);
      return `<div class="req-row"><span class="req-lbl">${esc(axisLabels[a])}</span>
        <div class="req-bars"><div class="req-bar req-post" style="width:${req}%" title="공고 언급 비중 ${req}%"></div><div class="req-bar req-me" style="width:${mine}%" title="내 점수 ${mine}%"></div></div>
        <span class="req-val">${req}% · ${mine}%</span></div>`;
    }).join("");
    const gap = axes.filter((a) => (data.axes[a]?.share || 0) >= 0.2 && avg[a] < 2).map((a) => axisLabels[a]);
    root.innerHTML = `<div class="rs-title">공고가 요구하는 역량 vs 내 결과</div>
      <p class="axis-note">최근 공고 ${data.analyzed_postings}건의 ${data.detail_postings ? `제목과 직무내용(${data.detail_postings}건)` : "제목"}에서 문장 ${data.analyzed_sentences}개를 5개 역량으로 나눠 센 비중(위)과 내 점수(아래)야.</p>
      <div class="req-legend"><span><i class="req-post"></i>공고 언급 비중</span><span><i class="req-me"></i>내 점수(4점=100%)</span></div>
      ${rows}
      ${gap.length ? `<p class="axis-note" style="margin-top:8px">공고에서 자주 찾는데 이번에 덜 드러난 역량: <b>${gap.map(esc).join(", ")}</b></p>` : ""}
      <p class="axis-note">문장을 키워드로 나눈 대략적인 비중이야. 공고 원문을 꼭 확인해.</p>`;
  } catch (_) {
    root.remove();
  }
}

// ── 결과 카드(U03) 버튼 ─────────────────────────────────
export function renderCardActions() {
  return `<div class="rs" id="result-card-actions"><div class="rs-title">결과 카드로 남기기</div>
    <p class="axis-note">레이더, 비슷한 직무 3개, 한 줄 요약만 담아. 답변 원문은 넣지 않아.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-p" id="btn-card-png" type="button">PNG로 저장</button><button class="btn btn-g" id="btn-card-print" type="button">인쇄</button></div>
    <img id="result-card-print" alt="" hidden></div>`;
}
