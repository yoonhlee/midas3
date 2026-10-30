/* ══════════════════════════════════════════════════════
   JOBSIM v3
   채점: 서버 /api/evaluate
   결과집계/추천/증거요약/사분면: 서버 /api/recommendations
   프론트는 입력/렌더 중심
══════════════════════════════════════════════════════ */

import {
  AXES,
  state,
  resetState,
  emptyMissionScore,
  emptyAxisProfile,
  emptyAxisEvidenceSummary
} from "./state/store.js";
import {
  bootstrapCatalogRequest,
  sendEvaluationLogRequest,
  evaluateAnswerRequest,
  recommendationsRequest,
  getAuthSession,
  createAttemptRequest,
  completeAttemptRequest,
  getAttemptRequest,
  getDraftRequest,
  saveDraftRequest,
  deleteDraftRequest,
  jobsByAxisRequest,
  postingRequirementsRequest,
  missionExplanationRequest
} from "./api-client/jobsimApi.js";
import {
  mountRequirementCompare,
  mountStrengthJobs,
  renderCardActions,
  renderEvidenceHighlight,
  renderInterestChange,
  renderInterpretation,
  renderNextMissions,
  renderPostSurvey,
  renderRequirementShell,
  renderResultStatus,
  renderRetryScreen,
  renderRetrySection,
  renderStrengthShell,
  roundOneLogs,
  withJosa
} from "./components/resultExtras.js";
import { averageAxisScores } from "./components/radar.js";
import { buildCardData, downloadCard, drawResultCard, printCard } from "./components/resultCard.js";
import { loadMissionsCatalog } from "./domain/missionsCatalog.js";
import { createEvaluationWorkflow } from "./domain/evaluationWorkflow.js";
import {
  renderEvidenceSection,
  renderQuadSection
} from "./components/resultSections.js";
import {
  renderCompatibilitySection,
  renderGapSection,
  renderJobIntroSection,
  renderRadarSection,
  renderRecommendationsSection
} from "./components/resultDashboard.js";
import {
  mountPostingsSection,
  renderPostingsSectionShell,
  unmountPostingsSection
} from "./components/postingsSection.js";
import {
  renderMissionListScreen,
  renderMissionScreen,
  renderPreQuestionScreen,
  renderSelectScreen
} from "./components/missionScreens.js";
import {
  bindAppEvents,
  refreshMissionNextButton as refreshMissionNextButtonAction,
  advanceMissionFlow as advanceMissionFlowAction
} from "./state/flowController.js";
import {
  getCurrentMission,
  getDoneMissionCount,
  getMissionsByJobCode,
  getTotalMissionCount,
  isLastMission
} from "./state/missionProgress.js";

const AX_LABELS = { AX1: "정보분석·논리", AX2: "관찰·탐색", AX3: "전략·판단", AX4: "리더십·조직", AX5: "대인서비스" };
const AX_META = {
  AX1: { icon: "📊", name: "데이터로 생각해요", desc: "수치·자료를 분석하고 논리적으로 판단하는 능력", examples: ["데이터 비교", "원인·결과 추론", "수치 기반 판단"] },
  AX2: { icon: "🔍", name: "꼼꼼하게 관찰해요", desc: "이상 현상을 발견하고 변수를 탐색하는 능력", examples: ["패턴 발견", "현장 관찰", "추가 조사 제안"] },
  AX3: { icon: "♟️", name: "전략적으로 판단해요", desc: "우선순위를 정하고 선택지를 비교해 결정하는 능력", examples: ["우선순위 설정", "단기·장기 구분", "선택지 비교"] },
  AX4: { icon: "👥", name: "팀을 이끌어요", desc: "역할을 나누고 팀·조직을 조율하는 능력", examples: ["역할 분담", "보고 구조화", "팀 단위 조율"] },
  AX5: { icon: "💬", name: "사람을 배려해요", desc: "상대방 입장을 고려하고 공감하며 소통하는 능력", examples: ["고객 공감", "불만 원인 파악", "UX 관점 제안"] }
};
const LEVEL_INFO = [
  { label: "근거 없음", emoji: "—", color: "var(--muted)", msg: "이 능력이 답변에서 확인되지 않았어요." },
  { label: "기초", emoji: "🟡", color: "#c4a84a", msg: "기본적인 내용은 언급했어요. 조금 더 구체적으로 써봐요." },
  { label: "보통", emoji: "🔵", color: "var(--accent)", msg: "괜찮은 답변이에요. 더 깊이 있으면 더 좋아요." },
  { label: "좋음", emoji: "🟢", color: "var(--success)", msg: "잘했어요! 이 능력이 잘 드러났어요." },
  { label: "탁월", emoji: "⭐", color: "#f5c842", msg: "아주 뛰어나요! 높은 수준의 분석력을 보여줬어요." }
];
const RADAR_SCALE = 2.8;

let JOB_DEFS = [];
let JOB_INFO = {};
let ALL_MISSIONS = [];
let MISSIONS_INDEX = null;
let LOAD_ERROR = null;
let SESSION = { authenticated: false };
// URL로 들어왔는데 열 수 없을 때 선택 화면 위에 한 번 보여줄 안내
let pendingNotice = null;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function inferEvaluationSource(evaluation) {
  const source = evaluation?.source;
  if (source) return source;
  const promptVersion = String(evaluation?.prompt_version || "");
  if (promptVersion.includes("unavailable")) return "unavailable";
  if (promptVersion.includes("fallback")) return "heuristic";
  if (promptVersion.includes("precheck")) return "precheck";
  return "llm";
}

const evaluationWorkflow = createEvaluationWorkflow({
  state,
  axes: AXES,
  emptyMissionScore,
  emptyAxisProfile,
  emptyAxisEvidenceSummary,
  sendEvaluationLogRequest,
  evaluateAnswerRequest,
  recommendationsRequest
});
const {
  saveEvaluationLog,
  scoreAnswer,
  fetchResultSummary
} = evaluationWorkflow;

function getMissions(jc) { return getMissionsByJobCode(ALL_MISSIONS, jc); }
function curMission() {
  if (state.selectedMissionKey) {
    return ALL_MISSIONS.find((m) => m.key === state.selectedMissionKey) || null;
  }
  return getCurrentMission({ allMissions: ALL_MISSIONS, state });
}
function totalM() { return 1; }
function doneM() { return 0; }
function isLast() { return true; }

const APP = document.getElementById("app");
function render({ scroll = true } = {}) {
  const fn = { select: rSelect, preq: rPreq, "mission-list": rMissionList, mission: rMission, result: rResult, retry: rRetry }[state.screen];
  if (fn) {
    // 이전 결과 화면의 지도(Leaflet 인스턴스)를 먼저 정리해야 다시 그릴 때 충돌하지 않는다.
    unmountPostingsSection();
    const notice = pendingNotice && (state.screen === "select" || state.screen === "preq")
      ? `<div class="notice notice-warn" id="url-notice">${esc(pendingNotice)}</div>`
      : "";
    pendingNotice = null;
    APP.innerHTML = notice + fn();
    document.body.dataset.screen = state.screen;
    if (state.screen === "result" && scroll) window.scrollTo({ top: 0, behavior: "smooth" });
    bindEvents();
    if (state.screen === "result") {
      mountPostings();
      mountResultExtras();
      bindResultExtras();
    }
    if (state.screen === "retry") bindRetryScreen();
  }
}

function mountPostings() {
  try {
    mountPostingsSection(APP.querySelector("#postings-section"), { jobCode: state.selectedJobs[0] });
  } catch (error) {
    console.warn("채용공고 섹션을 열지 못했어", error);
  }
}
function brand() { return ""; }

function rSelect() {
  return renderSelectScreen({
    state,
    jobDefs: JOB_DEFS,
    renderBrand: brand
  });
}

function rPreq() {
  return renderPreQuestionScreen({
    state,
    jobDefs: JOB_DEFS,
    renderBrand: brand
  });
}

function rMissionList() {
  const jobCode = state.selectedJobs[state.missionJobIndex];
  const jobDef = JOB_DEFS.find((j) => j.job_code === jobCode);
  if (!jobDef) return "<p>직무 정보를 찾을 수 없습니다.</p>";
  const missions = getMissions(jobCode);
  return renderMissionListScreen({ state, missions, jobDef, esc });
}

function rMission() {
  const mission = curMission();
  if (!mission) return "<p>미션을 찾을 수 없습니다.</p>";
  const jobCode = state.selectedJobs[state.missionJobIndex];
  const jobDef = JOB_DEFS.find((j) => j.job_code === jobCode);
  if (!jobDef) return "<p>직무 정보를 찾을 수 없습니다.</p>";
  return renderMissionScreen({
    state,
    mission,
    jobDef,
    missionProgressPct: 0,
    missionCount: 1,
    renderBrand: brand,
    isLastMission: true,
    esc
  });
}

function rResult() {
  const nonLlmCount = (state.evaluationLogs || [])
    .filter((log) => inferEvaluationSource(log?.evaluation) !== "llm")
    .length;
  const warn = state.resultError
    ? `<div class="log-note" style="margin-bottom:16px">서버 결과 분석에 실패해 기본값으로 표시 중입니다. (${esc(state.resultError)})</div>`
    : "";
  const sourceWarn = nonLlmCount > 0 && state.evalMode !== "fake"
    ? `<div class="log-note" style="margin-bottom:16px">임시 추정 결과가 포함되어 있습니다. (비LLM 평가 ${nonLlmCount}건)</div>`
    : "";
  const extras = { state, axes: AXES, axisLabels: AX_LABELS, jobDefs: JOB_DEFS, allMissions: ALL_MISSIONS, esc };
  return `<div class="eyebrow">시뮬레이션 완료</div>
  <div class="res-h">당신의 적성 분석 결과</div>
  <div class="res-sub">KNOW 재직자 데이터와 당신의 반응을 교차 분석했습니다</div>
  <div id="result-status">${renderResultStatus(extras)}</div>
  ${warn}${sourceWarn}
  ${rRadar()}${renderInterpretation(extras)}
  ${renderPostSurvey(extras)}<div id="interest-change-slot">${renderInterestChange(extras)}</div>
  ${rEvidence()}${renderEvidenceHighlight(extras)}
  ${rJobIntro()}${rCompat()}${rQuad()}${rRec()}${rGap()}${rEvaluationLogSummary()}
  ${renderRetrySection(extras)}${renderNextMissions(extras)}
  ${renderPostingsSectionShell()}
  ${renderRequirementShell()}${renderStrengthShell()}
  ${renderCardActions()}
  <hr/><button class="btn btn-g btn-lg" id="btn-restart">↺ 처음부터 다시하기</button>`;
}

function rRetry() {
  const mission = ALL_MISSIONS.find((m) => m.key === state.retry?.missionKey);
  if (!mission || !state.retry?.explanation) return "<p>미션을 찾을 수 없습니다.</p>";
  return renderRetryScreen({ state, mission, axes: AXES, axisLabels: AX_LABELS, esc });
}

function rRadar() {
  return renderRadarSection({
    state,
    axes: AXES,
    axisLabels: AX_LABELS,
    axisMeta: AX_META,
    levelInfo: LEVEL_INFO,
    radarScale: RADAR_SCALE,
    emptyAxisProfile,
    jobDefs: JOB_DEFS
  });
}

function rEvidence() {
  const hasLlmEvidence = (state.evaluationLogs || [])
    .some((log) => inferEvaluationSource(log?.evaluation) === "llm");
  if (!hasLlmEvidence) {
    return `<div class="rs"><div class="rs-title">✨ 능력별 상세 피드백</div><div class="log-note">임시 추정 모드에서는 인용 근거 카드가 생략됩니다.</div></div>`;
  }
  return renderEvidenceSection({
    axes: AXES,
    summary: state.resultSummary?.axisEvidenceSummary || emptyAxisEvidenceSummary(),
    axisMeta: AX_META,
    levelInfo: LEVEL_INFO,
    esc
  });
}

function rEvaluationLogSummary() { return ""; }

function rJobIntro() {
  return renderJobIntroSection({
    state,
    jobDefs: JOB_DEFS,
    jobInfo: JOB_INFO,
    esc
  });
}

function rCompat() {
  return renderCompatibilitySection({
    state,
    jobDefs: JOB_DEFS
  });
}

function rQuad() {
  return renderQuadSection({
    selectedJobs: state.selectedJobs,
    jobDefs: JOB_DEFS,
    jobInsights: state.resultSummary?.jobInsights || {}
  });
}

function rRec() {
  return renderRecommendationsSection({
    state,
    jobDefs: JOB_DEFS,
    axes: AXES,
    axisLabels: AX_LABELS,
    radarScale: RADAR_SCALE
  });
}

function rGap() {
  return renderGapSection({
    state,
    jobDefs: JOB_DEFS,
    getMissionsByJobCode: getMissions,
    esc
  });
}

// ── 체험 기록(U02) ─────────────────────────────────────
let attemptPromise = null;

// 미션을 시작할 때 체험 기록을 만든다. 실패해도 체험은 계속할 수 있다(결과만 저장되지 않음).
function ensureAttempt() {
  if (state.viewingAttempt) return Promise.resolve(null);
  if (state.attemptId) return Promise.resolve(state.attemptId);
  if (!attemptPromise) {
    attemptPromise = createAttemptRequest({ jobCodes: state.selectedJobs, preAnswers: state.preqAnswers })
      .then((data) => {
        state.attemptId = data.attempt.id;
        state.attemptSave = data.attempt.saved_to_account ? "account" : "anonymous";
        return state.attemptId;
      })
      .catch((error) => {
        console.warn("체험 기록을 만들지 못했어", error);
        state.attemptSave = "failed";
        return null;
      })
      .finally(() => { attemptPromise = null; });
  }
  return attemptPromise;
}

function buildSnapshot() {
  return {
    selectedJobs: state.selectedJobs,
    preqAnswers: state.preqAnswers,
    missionScores: state.missionScores,
    evaluationLogs: (state.evaluationLogs || []).slice(-30),
    resultSummary: state.resultSummary,
    selfReports: state.selfReports || { post: {} },
    retry: state.retry ? { missionKey: state.retry.missionKey, first: state.retry.first || null, second: state.retry.second || null } : null,
    evalMode: state.evalMode || null,
    resultError: state.resultError || null
  };
}

function refreshResultStatus() {
  const node = document.getElementById("result-status");
  if (node) node.innerHTML = renderResultStatus({ state, esc });
}

// 결과를 처음 보여줄 때, 그리고 체험 후 질문·재도전 뒤에 결과 스냅샷을 다시 저장한다.
async function saveAttemptSnapshot() {
  if (state.viewingAttempt && !state.attemptId) return;
  const attemptId = state.attemptId || await ensureAttempt();
  if (!attemptId) {
    refreshResultStatus();
    return;
  }
  try {
    const data = await completeAttemptRequest(attemptId, buildSnapshot());
    if (!state.viewingAttempt) state.attemptSave = data.saved_to_account ? "account" : "anonymous";
  } catch (error) {
    console.warn("결과를 저장하지 못했어", error);
    if (!state.viewingAttempt) state.attemptSave = "failed";
  }
  refreshResultStatus();
}

async function openSavedAttempt(attemptId) {
  try {
    const data = await getAttemptRequest(attemptId);
    const snap = data.attempt?.result_snapshot;
    if (!snap || !Array.isArray(snap.selectedJobs)) {
      pendingNotice = "이 체험은 결과까지 끝나지 않아서 다시 볼 결과가 없어.";
      return;
    }
    resetState();
    state.selectedJobs = snap.selectedJobs;
    state.preqAnswers = snap.preqAnswers || {};
    state.missionScores = snap.missionScores || {};
    state.evaluationLogs = snap.evaluationLogs || [];
    state.resultSummary = snap.resultSummary || null;
    state.axisProfile = snap.resultSummary?.axisProfile || null;
    state.compatibility = snap.resultSummary?.compatibility || {};
    state.selfReports = snap.selfReports?.post ? snap.selfReports : { post: {} };
    state.retry = snap.retry?.first ? { ...snap.retry } : null;
    state.resultError = snap.resultError || null;
    state.evalMode = snap.evalMode || state.evalMode;
    state.attemptId = data.attempt.id;
    state.attemptSave = data.attempt.user_id ? "account" : "anonymous";
    state.viewingAttempt = {
      date: formatKstDate(data.attempt.completed_at || data.attempt.created_at),
      outdated: (data.missions || []).some((mission) => mission.mission_outdated)
    };
    state.screen = "result";
  } catch (error) {
    pendingNotice = error?.status === 404
      ? "그 기록을 찾을 수 없어. 기록을 만든 계정(또는 브라우저)으로 열어줘."
      : "기록을 불러오지 못했어. 잠시 뒤에 다시 해줘.";
  }
}

function formatKstDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

// ── 쓰던 답안 자동 저장(로그인한 경우) ─────────────────────
let draftTimer = null;

function setDraftStatus(text) {
  state.draftStatus = text;
  const node = document.getElementById("draft-status");
  if (node) node.textContent = text;
}

function scheduleDraftSave() {
  if (!SESSION.authenticated) return;
  const mission = curMission();
  if (!mission?.key) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    const answer = state.missionAnswer;
    if (!answer.trim() || state.screen !== "mission") return;
    try {
      await saveDraftRequest(mission.key, answer.slice(0, 3000));
      setDraftStatus(`자동 저장됨 · ${formatKstDate(new Date().toISOString()).slice(-5)}`);
    } catch (_) {
      setDraftStatus("자동 저장에 실패했어. 답안은 화면에 그대로 있어.");
    }
  }, 1200);
}

async function loadDraftIntoMission() {
  if (!SESSION.authenticated) return;
  const mission = curMission();
  if (!mission?.key) return;
  try {
    const { draft } = await getDraftRequest(mission.key);
    if (state.screen !== "mission" || curMission()?.key !== mission.key) return;
    if (draft?.answer && !state.missionAnswer.trim()) {
      state.missionAnswer = draft.answer;
      const input = document.getElementById("m-ans");
      if (input) input.value = draft.answer;
      refreshMissionNextButtonAction({ state, getCurrentMission: curMission });
      setDraftStatus(`${formatKstDate(draft.updated_at)}에 쓰던 답안을 불러왔어.`);
    }
  } catch (error) {
    if (error?.status !== 404) console.warn("쓰던 답안을 불러오지 못했어", error);
  }
}

function onAnswerSubmitted(mission) {
  clearTimeout(draftTimer);
  if (SESSION.authenticated && mission?.key) deleteDraftRequest(mission.key).catch(() => {});
}

function startMission() {
  state.screen = "mission";
  state.missionStepIndex = 0;
  state.missionAnswer = "";
  state.selectedOption = null;
  state.draftStatus = SESSION.authenticated ? "" : "로그인하면 쓰던 답안이 자동으로 저장돼.";
  void ensureAttempt();
  render();
  void loadDraftIntoMission();
}

// ── 결과 화면 확장 ───────────────────────────────────────
function mountResultExtras() {
  if (!roundOneLogs(state).length) return;
  void mountStrengthJobs({ root: APP.querySelector("#strength-jobs"), state, axes: AXES, axisLabels: AX_LABELS, jobsByAxisRequest, esc });
  void mountRequirementCompare({ root: APP.querySelector("#req-compare"), state, axes: AXES, axisLabels: AX_LABELS, postingRequirementsRequest, esc });
}

function bindResultExtras() {
  const byId = (id) => document.getElementById(id);

  byId("btn-survey-save")?.addEventListener("click", () => {
    const pick = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || null;
    const interest = Number(pick("sr-interest")) || null;
    const difficulty = Number(pick("sr-difficulty")) || null;
    const again = pick("sr-again");
    if (!interest && !difficulty && !again) {
      const box = byId("post-survey");
      if (box && !box.querySelector(".notice")) box.insertAdjacentHTML("beforeend", `<div class="notice notice-warn" style="margin-top:10px">하나 이상 골라줘.</div>`);
      return;
    }
    const job = state.selectedJobs[0];
    state.selfReports = state.selfReports || { post: {} };
    state.selfReports.post[job] = { interest, difficulty, again, submitted: true, at: new Date().toISOString() };
    const box = byId("post-survey");
    if (box) box.outerHTML = `<div class="notice notice-ok" id="post-survey-done">고마워! 답변을 저장했어.</div>`;
    const slot = byId("interest-change-slot");
    if (slot) slot.innerHTML = renderInterestChange({ state, jobDefs: JOB_DEFS, esc });
    void saveAttemptSnapshot();
  });

  document.querySelectorAll(".hl-btn").forEach((button) => button.addEventListener("click", () => {
    const axis = button.dataset.hlAxis;
    document.querySelectorAll(".hl-btn").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    document.querySelectorAll(".hl-wrap").forEach((wrap) => { wrap.dataset.axis = axis; });
  }));

  byId("btn-retry-open")?.addEventListener("click", () => void openRetry(byId("btn-retry-open").dataset.missionKey));
  byId("btn-card-png")?.addEventListener("click", () => void handleCard("png"));
  byId("btn-card-print")?.addEventListener("click", () => void handleCard("print"));
}

async function openRetry(missionKey) {
  const button = document.getElementById("btn-retry-open");
  const box = document.getElementById("retry-offer");
  const showError = (message) => {
    box?.querySelector(".notice")?.remove();
    box?.insertAdjacentHTML("beforeend", `<div class="notice notice-warn" style="margin-top:10px">${esc(message)}</div>`);
  };
  const first = roundOneLogs(state).find((log) => log.mission_key === missionKey);
  if (!first) return;
  if (!state.attemptId) {
    showError("체험 기록이 저장되지 않아서 해설을 열 수 없어. 미션을 다시 해줘.");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "해설 불러오는 중…";
  }
  try {
    const explanation = await missionExplanationRequest(missionKey, state.attemptId);
    state.retry = { missionKey, first, second: null, draft: first.answer || "", explanation };
    state.screen = "retry";
    render();
    document.getElementById("simulation")?.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = "해설 보기";
    }
    showError(error?.message || "해설을 불러오지 못했어.");
  }
}

function bindRetryScreen() {
  const byId = (id) => document.getElementById(id);
  byId("retry-ans")?.addEventListener("input", (event) => {
    state.retry.draft = event.target.value;
    const counter = byId("retry-ct");
    if (counter) counter.textContent = `${state.retry.draft.length}자`;
  });
  byId("btn-retry-cancel")?.addEventListener("click", () => {
    state.screen = "result";
    render();
  });
  byId("btn-retry-submit")?.addEventListener("click", async () => {
    const mission = ALL_MISSIONS.find((m) => m.key === state.retry?.missionKey);
    const answer = byId("retry-ans")?.value ?? state.retry.draft;
    const errorBox = byId("retry-error");
    if (!mission) return;
    if (answer.trim().length <= 10) {
      if (errorBox) errorBox.innerHTML = `<div class="notice notice-warn" style="margin-top:10px">10자 넘게 써줘.</div>`;
      return;
    }
    const button = byId("btn-retry-submit");
    if (button) {
      button.disabled = true;
      button.textContent = "채점 중…";
    }
    try {
      const scored = await scoreAnswer(answer, mission, { round: 2 });
      state.retry.second = {
        answer,
        created_at: new Date().toISOString(),
        evaluation: scored.evaluation,
        mission_score: scored.missionScore
      };
      state.retry.draft = answer;
      state.screen = "result";
      render({ scroll: false });
      document.getElementById("retry-result")?.scrollIntoView({ behavior: "smooth", block: "start" });
      void saveAttemptSnapshot();
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = "다시 제출";
      }
      if (errorBox) errorBox.innerHTML = `<div class="notice notice-err" style="margin-top:10px">채점에 실패했어. 잠시 뒤에 다시 해줘. (${esc(error?.message || error)})</div>`;
    }
  });
}

async function handleCard(kind) {
  const button = document.getElementById(kind === "png" ? "btn-card-png" : "btn-card-print");
  if (button) button.disabled = true;
  try {
    const data = buildCardData({ state, axes: AXES, axisLabels: AX_LABELS, jobDefs: JOB_DEFS, averageAxisScores, roundOneLogs, withJosa });
    const canvas = await drawResultCard(data, { axes: AXES, axisLabels: AX_LABELS });
    if (kind === "png") {
      await downloadCard(canvas, `jobsim-result-${data.date.replace(/[^0-9]/g, "")}.png`);
    } else {
      printCard(canvas, document.getElementById("result-card-print"));
    }
  } catch (error) {
    console.warn("결과 카드를 만들지 못했어", error);
  } finally {
    if (button) button.disabled = false;
  }
}

function flowContext() {
  const ctx = {
    appNode: APP,
    state,
    getCurrentMission: curMission,
    getMissionsByJobCode: getMissions,
    scoreAnswer,
    saveEvaluationLog,
    fetchResultSummary,
    render,
    resetState,
    ensureAttempt,
    startMission,
    onAnswerInput: scheduleDraftSave,
    onAnswerSubmitted,
    onResultShown: () => void saveAttemptSnapshot()
  };
  return {
    ...ctx,
    refreshMissionNextButton: () => refreshMissionNextButtonAction(ctx),
    advanceMissionFlow: () => advanceMissionFlowAction(ctx)
  };
}

function bindEvents() { bindAppEvents(flowContext()); }

function updateNavUser() {
  const link = document.getElementById("nav-user");
  if (!link) return;
  if (SESSION.authenticated) {
    link.textContent = SESSION.user?.nickname || "내 계정";
    link.href = "./me.html";
  } else {
    link.textContent = "로그인";
    link.href = `./login.html?return=${encodeURIComponent("/index.html#simulation")}`;
  }
}

// /index.html?job=CODE · ?mission=KEY(&resume=1) · ?attempt=ID 로 바로 들어온 경우
async function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const attemptId = params.get("attempt");
  const jobCode = params.get("job");
  const missionKey = params.get("mission");
  if (!attemptId && !jobCode && !missionKey) return false;
  history.replaceState(null, "", `${location.pathname}#simulation`);
  if (attemptId) {
    await openSavedAttempt(attemptId);
    return true;
  }
  if (missionKey) {
    const mission = ALL_MISSIONS.find((m) => m.key === missionKey);
    if (!mission) {
      pendingNotice = "그 미션은 지금 체험할 수 없어. 다른 직무를 골라줘.";
      return true;
    }
    state.selectedJobs = [mission.job_code];
    state.selectedMissionKey = mission.key;
    state.missionJobIndex = 0;
    state.preqIndex = 0;
    state.screen = params.get("resume") === "1" ? "mission-start" : "preq";
    return true;
  }
  if (JOB_DEFS.some((job) => job.job_code === jobCode)) {
    state.selectedJobs = [jobCode];
    state.preqIndex = 0;
    state.screen = "preq";
  } else {
    pendingNotice = "이 직무는 아직 체험 미션이 없어. 체험할 수 있는 직무를 골라줘.";
  }
  return true;
}

async function bootstrap() {
  unmountPostingsSection();
  APP.innerHTML = `<div class="boot-state">
    <div class="loading-dots"><span></span><span></span><span></span></div>
    <div class="boot-msg">미션을 불러오는 중…</div>
    <div class="boot-sub">missions/index.json 과 각 미션 JSON 을 가져오고 있어요.</div>
  </div>`;
  const sessionPromise = getAuthSession();
  try {
    let catalog;
    try {
      catalog = await bootstrapCatalogRequest();
      state.evalMode = catalog.eval_mode || null;
    } catch (apiErr) {
      console.warn("Bootstrap API unavailable. Falling back to static mission files.", apiErr);
      catalog = await loadMissionsCatalog({
        axes: AXES,
        axisMeta: AX_META
      });
    }
    MISSIONS_INDEX = catalog.missionsIndex;
    JOB_DEFS = catalog.jobDefs;
    JOB_INFO = catalog.jobInfo;
    ALL_MISSIONS = catalog.allMissions;
  } catch (err) {
    console.error("미션 로드 실패:", err);
    LOAD_ERROR = (err && err.message) ? err.message : String(err);
    APP.innerHTML = `<div class="boot-state err">
      <div class="boot-msg">미션을 불러올 수 없습니다.</div>
      <div class="boot-sub">${esc(LOAD_ERROR)}<br><br>
      ・ 정적 서버를 <code>app/</code> 가 아니라 프로젝트 루트에서 실행했는지 확인하세요.<br>
      ・ <code>missions/index.json</code> 과 각 미션 파일 경로가 존재하는지 확인하세요.</div>
    </div>`;
    return;
  }
  if (!ALL_MISSIONS.length) {
    APP.innerHTML = `<div class="boot-state err">
      <div class="boot-msg">표시할 미션이 없습니다.</div>
      <div class="boot-sub">missions/index.json 의 missions 배열을 확인하세요.</div>
    </div>`;
    return;
  }
  SESSION = await sessionPromise;
  updateNavUser();
  const fromUrl = await applyUrlParams();
  if (state.screen === "mission-start") {
    startMission();
  } else {
    render({ scroll: false });
  }
  if (fromUrl) document.getElementById("simulation")?.scrollIntoView({ behavior: "smooth" });
}
window.goSim = function () {
  document.getElementById("simulation").scrollIntoView({ behavior: "smooth" });
};
window.resetAll = function () {
  resetState();
  delete state.sessionId;
  try { localStorage.removeItem("jobsim:evaluation_logs:v1"); } catch (_) {}
  bootstrap();
  document.getElementById("simulation").scrollIntoView({ behavior: "smooth" });
};
bootstrap();
