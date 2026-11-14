function getApiToken() {
  try {
    return localStorage.getItem("jobsim:api_token") || "";
  } catch (_) {
    return "";
  }
}

let csrfToken = null;

// 로그인한 상태면 상태 변경 요청에 CSRF 토큰을 붙인다.
export async function getAuthSession() {
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    const data = response.ok ? await response.json() : { authenticated: false };
    csrfToken = data.csrf_token || null;
    return data;
  } catch (_) {
    return { authenticated: false };
  }
}

function buildHeaders() {
  const token = getApiToken().trim();
  return {
    "Content-Type": "application/json",
    ...(token ? { "x-api-token": token } : {}),
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
  };
}

async function sendJson(method, url, payload) {
  const response = await fetch(url, {
    method,
    headers: buildHeaders(),
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json())?.error?.message || message;
    } catch (_) {
      // 본문이 JSON이 아니면 상태 코드만 쓴다.
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function getJson(url) {
  const token = getApiToken().trim();
  const response = await fetch(url, {
    method: "GET",
    headers: token ? { "x-api-token": token } : undefined
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function bootstrapCatalogRequest() {
  const data = await getJson("/api/bootstrap");
  if (!Array.isArray(data?.jobDefs) || !Array.isArray(data?.allMissions) || !data?.jobInfo) {
    throw new Error("부팅 응답 형식이 올바르지 않습니다.");
  }
  return data;
}

export async function sendEvaluationLogRequest(entry) {
  return postJson("/api/logs", entry);
}

// 서버 카탈로그의 미션(mission_key)으로 채점한다. attempt_id가 있으면 체험 기록에 함께 저장된다.
export async function evaluateAnswerRequest({ answer, mission, missionKey, attemptId, round, selfReport }) {
  const data = await postJson("/api/evaluate", {
    answer,
    ...(missionKey ? { mission_key: missionKey } : { mission }),
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...(round ? { round } : {}),
    ...(selfReport ? { self_report: selfReport } : {})
  });
  if (!data?.missionScore || !data?.evaluation) {
    throw new Error("채점 응답 형식이 올바르지 않습니다.");
  }
  return data;
}

export async function recommendationsRequest({
  selectedJobs,
  missionScoresByJob,
  evaluationLogs,
  topN
}) {
  const data = await postJson("/api/recommendations", {
    selectedJobs,
    missionScoresByJob,
    evaluationLogs,
    topN
  });

  if (!data?.axisProfile || !data?.compatibility || !data?.axisEvidenceSummary || !data?.jobInsights) {
    throw new Error("결과 분석 응답 형식이 올바르지 않습니다.");
  }

  return data;
}

export async function getJobPostings(jobCode) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobCode)}/postings`, { method: "GET" });
  if (!response.ok) {
    throw new Error(`채용공고 응답 오류(HTTP ${response.status})`);
  }
  const data = await response.json();
  if (!data?.status || !Array.isArray(data?.items)) {
    throw new Error("채용공고 응답 형식이 올바르지 않습니다.");
  }
  return data;
}

// ── 체험 기록 ─────────────────────────────
export function createAttemptRequest({ jobCodes, preAnswers }) {
  return sendJson("POST", "/api/attempts", { job_codes: jobCodes, pre_answers: preAnswers || {} });
}

export function completeAttemptRequest(attemptId, snapshot) {
  return sendJson("POST", `/api/attempts/${encodeURIComponent(attemptId)}/complete`, { snapshot });
}

export function getAttemptRequest(attemptId) {
  return sendJson("GET", `/api/attempts/${encodeURIComponent(attemptId)}`);
}

// ── 쓰던 답안(로그인한 경우) ──────────────────
export function saveDraftRequest(missionKey, answer) {
  return sendJson("PUT", `/api/me/drafts/${encodeURIComponent(missionKey)}`, { answer });
}

export function getDraftRequest(missionKey) {
  return sendJson("GET", `/api/me/drafts/${encodeURIComponent(missionKey)}`);
}

export function deleteDraftRequest(missionKey) {
  return sendJson("DELETE", `/api/me/drafts/${encodeURIComponent(missionKey)}`);
}

// ── 결과 화면 확장 ────────────────────────────
export function jobsByAxisRequest(axis) {
  return sendJson("GET", `/api/jobs/by-axis/${encodeURIComponent(axis)}`);
}

export function postingRequirementsRequest(jobCode) {
  return sendJson("GET", `/api/jobs/${encodeURIComponent(jobCode)}/postings/requirements`);
}

// 해설(U21): 이 기록에서 미션을 제출한 뒤에만 열린다.
export function missionExplanationRequest(missionKey, attemptId) {
  return sendJson("GET", `/api/missions/${encodeURIComponent(missionKey)}/explanation?attempt_id=${encodeURIComponent(attemptId)}`);
}
