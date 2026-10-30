export const AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"];

export function emptyMissionScore() {
  return Object.fromEntries(AXES.map((axis) => [axis, 0]));
}

export function emptyAxisProfile() {
  return Object.fromEntries(AXES.map((axis) => [axis, 0]));
}

export function emptyAxisEvidenceSummary() {
  return Object.fromEntries(AXES.map((axis) => [axis, {
    score: 0,
    confidence: 0,
    evidence: [],
    flags: [],
    sources: 0
  }]));
}

export function createInitialState() {
  return {
    screen: "select",
    selectedJobs: [],
    preqIndex: 0,
    preqAnswers: {},
    missionJobIndex: 0,
    missionStepIndex: 0,
    missionAnswer: "",
    selectedOption: null,
    selectedMissionKey: null,
    missionScores: {},
    evaluationLogs: [],
    axisProfile: null,
    compatibility: {},
    pendingScores: [],
    resultSummary: null,
    resultError: null,
    // 체험 기록(U02): 서버 attempt id, 저장 위치('account' | 'anonymous' | 'failed')
    attemptId: null,
    attemptSave: null,
    // 저장된 결과를 다시 볼 때 { date, outdated }
    viewingAttempt: null,
    // 체험 후 질문(U22): { post: { [jobCode]: { interest, difficulty, again, submitted } } }
    selfReports: { post: {} },
    // 재도전(U21): { missionKey, first, second, draft }
    retry: null,
    draftStatus: null
  };
}

export const state = createInitialState();

export function resetState() {
  Object.assign(state, createInitialState());
}
