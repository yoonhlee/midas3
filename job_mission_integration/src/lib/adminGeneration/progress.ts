// 미션 생성기(pilot_runner)가 찍는 진행 메시지 한 줄을 읽어 단계를 옮긴다.
//   [HH:MM:SS] run started - run_id=<폴더 이름> targets=1 concurrency=1
//   [HH:MM:SS] [1/1] <직업코드> <난이도> - <단계> (<자세한 값>)
//   [HH:MM:SS] run finished - saved=1 failed=0 repair_used=0
// 시각이 붙지 않은 줄(끝에 찍는 폴더 경로와 요약)과 모르는 줄은 상태를 바꾸지 않는다.
// 미션 작성 호출이 형식 크기로 거절된 뒤 다시 불리는 것은 진행 줄에 나오지 않으므로 "다시 쓰기"로 세지 않는다.

export type Stage = "queued" | "blueprint" | "blueprint_check" | "writing" | "mission_check" | "review" | "done";

export interface ProgressState {
  stage: Stage;
  runFolder: string | null;
  rewrites: { blueprint: number; mission: number };
  saved: boolean | null;
  failureCode: string | null;
}

export function initialProgress(): ProgressState {
  return { stage: "queued", runFolder: null, rewrites: { blueprint: 0, mission: 0 }, saved: null, failureCode: null };
}

const TIMESTAMP = /^\[\d{2}:\d{2}:\d{2}\]\s+(.*)$/;
const FAILURE_EVENTS = new Set(["blueprint failed", "decision failed", "repair_failed", "discarded"]);

export function applyProgressLine(state: ProgressState, line: string): ProgressState {
  const stamped = TIMESTAMP.exec(line.trim());
  if (!stamped) return state;
  const body = stamped[1];

  const started = /^run started - run_id=(\S+)/.exec(body);
  if (started) return { ...state, runFolder: started[1] };
  const finished = /^run finished - saved=(\d+)/.exec(body);
  if (finished) return { ...state, saved: Number(finished[1]) >= 1 };

  // "[1/1] 직업 난이도 - 단계 (자세한 값)"에서 " - " 뒤를 본다.
  const dash = body.indexOf(" - ");
  if (dash === -1) return state;
  const parsed = /^(.*?)(?: \((.*)\))?$/.exec(body.slice(dash + 3).trim());
  if (!parsed) return state;
  const event = parsed[1];
  const detail = parsed[2] ?? null;
  const next = (patch: Partial<ProgressState>): ProgressState => ({ ...state, rewrites: { ...state.rewrites }, ...patch });

  if (event === "blueprint LLM started") {
    const attempt = Number(/attempt (\d+)/.exec(detail ?? "")?.[1] ?? 0);
    return next({ stage: "blueprint", rewrites: { ...state.rewrites, blueprint: attempt >= 1 ? attempt : state.rewrites.blueprint } });
  }
  if (/^blueprint check \d+$/.test(event)) return next({ stage: "blueprint_check" });
  if (event === "draft LLM started") return next({ stage: "writing" });
  if (event === "draft LLM finished" || event === "repair LLM finished" || /^validator attempt \d+$/.test(event)) {
    return next({ stage: "mission_check" });
  }
  if (event === "repair LLM started") return next({ stage: "writing", rewrites: { ...state.rewrites, mission: 1 } });
  if (event === "saved") return next({ saved: true });
  if (FAILURE_EVENTS.has(event) && detail) return next({ failureCode: detail });
  if (event === "llm failed") return next({ failureCode: "LLM_FAILED" });
  return state;
}
