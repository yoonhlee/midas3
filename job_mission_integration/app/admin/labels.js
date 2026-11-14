/* 관리자 화면에 쓰는 말. 서버는 식별자만 주고 화면의 말은 여기서 정한다.
   순수 함수만 둔다(DOM을 쓰지 않는다). 돌려주는 값은 HTML이 아닌 글자이고, 화면에 넣을 때 화면 쪽에서 esc()를 거친다. */

// 진행 단계(run.stages[].id)
export const STAGE_LABELS = {
  blueprint: "설계",
  blueprint_check: "설계 검사",
  writing: "미션 작성",
  mission_check: "미션 검사",
  review: "내용 검수",
  approval: "검토 · 승인"
};

// 단계의 상태(run.stages[].state). rewritten이 참이면 REWRITTEN_LABEL을 붙인다
export const STAGE_STATE_LABELS = { done: "끝남", active: "하는 중", pending: "기다림", skipped: "건너뜀", failed: "멈춤" };
export const REWRITTEN_LABEL = "다시 씀";

// 실행의 상태(run.status)
export const STATUS_LABELS = { running: "생성 중", ready: "검토 대기", added: "추가됨", failed: "실패", interrupted: "중단됨" };

export const DIFFICULTY_LABELS = { easy: "쉬움", normal: "보통", hard: "어려움" };
export const DIFFICULTY_HINTS = {
  easy: "자료 1개 · 과제 1개 · 약 10분 분량",
  normal: "자료 2개 · 과제 1개 · 약 15분 분량",
  hard: "자료 3개 · 과제 2개 · 약 20분 분량"
};

export const MATERIAL_TYPE_LABELS = { table: "표", chart: "차트", log: "기록", memo: "메모", checklist: "체크리스트", email: "이메일", schedule: "일정표" };

// 고를 수 없는 문장의 이유(sentences[].blockedReason)
export const BLOCKED_REASON_TEXT = {
  OTHER_LINK_ONLY: "이어진 능력단위가 있지만 범위가 넓거나 수준이 달라 쓰지 않습니다",
  NO_LINK: "이어진 능력단위가 없습니다"
};

// 근거 기록의 단계마다 누가 정했나(chain[].kind)
export const KIND_LABELS = { data: "데이터", link_decision: "연결 판단", ai_decision: "AI 판단", rule: "규칙" };

const ERROR_TEXT = {
  AUTH_REQUIRED: "관리자 암호가 필요합니다.",
  ADMIN_PASSWORD_NOT_SET: "서버에 관리자 암호가 설정돼 있지 않습니다.",
  GENERATION_ALREADY_RUNNING: "지금 만들고 있는 미션이 있습니다. 끝난 뒤에 다시 시작해 주세요.",
  GENERATION_STILL_RUNNING: "아직 만들고 있는 중이라 할 수 없습니다. 끝난 뒤에 다시 해 주세요.",
  GENERATION_DAILY_LIMIT: "오늘 만들 수 있는 건수를 모두 썼습니다.",
  LLM_API_KEY_MISSING: "서버에 Claude API 키가 없습니다.",
  ANTHROPIC_SDK_MISSING: "서버에 Python 패키지(anthropic)가 깔려 있지 않습니다.",
  ANTHROPIC_AUTH_FAILED: "Claude API 키가 받아들여지지 않았습니다.",
  ANTHROPIC_MODEL_NOT_FOUND: "설정한 모델을 찾을 수 없습니다.",
  ANTHROPIC_PREFLIGHT_FAILED: "Claude API에 연결하지 못했습니다.",
  GENERATION_PYTHON_UNAVAILABLE: "서버에서 Python을 실행하지 못했습니다.",
  GENERATION_CONFIG_INVALID: "서버의 생성 설정 값이 올바르지 않습니다.",
  GENERATION_TIMEOUT: "시간이 너무 오래 걸려 멈췄습니다.",
  CATALOG_ADD_NOT_ALLOWED: "이 미션은 지금 카탈로그에 추가할 수 없습니다.",
  CATALOG_MISSION_PROTECTED: "미리 넣은 미션은 삭제할 수 없습니다."
};

// 표에 그 키가 직접 있을 때만 값을 준다("toString" 같은 키가 걸리지 않게)
function own(table, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// 검수 판정 → 보이는 말과 색. doubt의 수는 검수 기록의 warning_count이고, 모르면(목록 등) "있음"으로 쓴다
export function verdictView(verdict, warningCount) {
  if (verdict === "pass") return { text: "통과", tone: "ok" };
  if (verdict === "doubt") {
    const known = Number.isInteger(warningCount) && warningCount > 0;
    return { text: known ? `확인할 점 ${warningCount}건` : "확인할 점 있음", tone: "quiet" };
  }
  if (verdict === "fail") return { text: "문제", tone: "danger" };
  if (verdict === "review_failed") return { text: "검수 실패", tone: "warn" };
  return { text: "검수 안 함", tone: "muted" };
}

// 조각 번호 → 읽을 수 있는 이름. 모르는 값은 그대로 둔다
const PIECE_FIXED = {
  "K.sum": "직업 요약",
  "K.keco": "직업 분류",
  "N.unit": "능력단위",
  "N.duty": "NCS 직무",
  "M.1": "문장과 능력단위의 연결"
};
const PIECE_NUMBERED = [
  [/^N\.c\.(\d+\.\d+)$/, "수행준거"],
  [/^N\.doc\.(\d+)$/, "서류"],
  [/^N\.con\.(\d+)$/, "고려사항"],
  [/^N\.eval\.(\d+)$/, "평가 지침"],
  [/^K\.act\.(\d+)$/, "업무활동"],
  [/^K\.abil\.(\d+)$/, "능력"],
  [/^K\.know\.(\d+)$/, "지식"]
];

export function pieceName(id) {
  if (typeof id !== "string") return id;
  const fixed = own(PIECE_FIXED, id);
  if (fixed) return fixed;
  if (/^K\.exec\.\d+$/.test(id)) return "하는 일 문장";   // 대상 문장은 하나뿐이라 번호를 쓰지 않는다
  for (const [pattern, name] of PIECE_NUMBERED) {
    const match = pattern.exec(id);
    if (match) return `${name} ${match[1]}`;
  }
  return id;
}

// 글 안의 조각 번호를 모두 pieceName으로 바꾼다. 앞뒤가 영문 · 숫자 · 점으로 이어진 것(N.c.2.2.1 같은 것)은 조각 번호로 보지 않는다
const PIECE_IN_TEXT = /(?<![A-Za-z0-9_.])(?:N\.c\.\d+\.\d+|N\.(?:doc|con|eval)\.\d+|K\.(?:exec|act|abil|know)\.\d+|K\.(?:sum|keco)|N\.(?:unit|duty)|M\.1)(?![A-Za-z0-9_]|\.\d)/g;

export function renamePieces(text) {
  return String(text ?? "").replace(PIECE_IN_TEXT, (id) => pieceName(id));
}

// 예상 소요와 비용. 시간은 30초 단위로 반올림한다
export function estimateText(estimates, difficulty, review) {
  const entry = estimates && typeof estimates === "object" ? own(estimates, difficulty) : undefined;
  if (!entry?.generate) return { time: "—", cost: "—" };
  const parts = review ? [entry.generate, entry.review] : [entry.generate];   // 검수를 켰으면 검수 몫을 더한다
  const seconds = parts.map((part) => part?.seconds);
  const usd = parts.map((part) => part?.usd);
  const time = seconds.every(Number.isFinite) ? minutesText(seconds.reduce((a, b) => a + b, 0)) : "—";
  const cost = usd.every(Number.isFinite) ? `약 $${usd.reduce((a, b) => a + b, 0).toFixed(2)}` : "—";
  return { time, cost };
}

function minutesText(totalSeconds) {
  let seconds = Math.round(totalSeconds / 30) * 30;
  if (seconds <= 0 && totalSeconds > 0) seconds = 30;   // 30초가 안 돼도 "약 0초"로 쓰지 않는다
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `약 ${rest}초`;
  return rest ? `약 ${minutes}분 ${rest}초` : `약 ${minutes}분`;
}

// 오류 코드 → 글. 실패한 실행의 그 밖의 코드는 검사를 통과하지 못한 것으로 쓴다
export function errorText(code, options) {
  const failedRun = Boolean(options && options.failedRun);
  const known = own(ERROR_TEXT, code);
  if (known) return known;
  const tail = code === undefined || code === null || code === "" ? "" : ` (${code})`;
  return failedRun ? `검사를 통과하지 못해 저장되지 않았습니다.${tail}` : `요청을 처리하지 못했습니다.${tail}`;
}

// 자료 형태 목록 → 한 줄. 좁히지 않았으면(null) 일곱 형태를 모두 쓴다
export function materialTypesText(types) {
  if (!Array.isArray(types) || !types.length) return "일곱 형태 모두";
  return types.map((type) => own(MATERIAL_TYPE_LABELS, type) ?? String(type)).join(" · ");
}
