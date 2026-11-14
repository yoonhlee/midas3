import type { PostingsService } from "./service.js";

export interface SchedulerHandle {
  stop(): void;
}

// 서버 시작 30초 뒤 한 번, 이후 1시간마다 오래된 스냅샷이 있는지 확인해 갱신한다.
// 서버 시작을 막지 않도록 타이머만 걸고 바로 돌아온다.
export function startPostingsScheduler(
  service: PostingsService,
  options: { initialDelayMs?: number; intervalMs?: number; log?: (message: string) => void } = {}
): SchedulerHandle {
  const log = options.log ?? ((m: string) => console.log(m));
  const { config } = service;
  if (!config.enabled) {
    log("[postings] 기능이 꺼져 있어(POSTINGS_ENABLED=false). 스케줄러를 시작하지 않아.");
    return { stop() {} };
  }
  if (config.fixture) {
    log("[postings] 고정 데이터 모드라 스케줄러를 끄고, 스냅샷은 npm run postings:fixture-snapshots로 만들어.");
    return { stop() {} };
  }
  if (!config.work24Key) {
    log("[postings] WORK24_RECRUIT_AUTH_KEY가 없어 자동 갱신을 하지 않아.");
    return { stop() {} };
  }

  const tick = async () => {
    if (service.isRefreshing()) return;
    try {
      const due = service.jobsDueForRefresh();
      if (!due.length) return;
      log(`[postings] 자동 갱신 시작: ${due.join(", ")}`);
      const results = await service.refresh(due, () => {});
      const summary = results.map((r) => `${r.job_code}:${r.ok ? `ok(${r.snapshot?.counts.kept ?? 0})` : r.skipped ?? "fail"}`);
      log(`[postings] 자동 갱신 끝: ${summary.join(" ")}`);
    } catch (error) {
      log(`[postings] 자동 갱신 오류: ${(error as Error).message}`);
    }
  };

  const first = setTimeout(() => { void tick(); }, options.initialDelayMs ?? 30_000);
  const interval = setInterval(() => { void tick(); }, options.intervalMs ?? 60 * 60 * 1000);
  first.unref();
  interval.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
    }
  };
}
