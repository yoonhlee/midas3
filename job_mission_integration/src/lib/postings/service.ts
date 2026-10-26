import { FIXTURE_DIR, FIXTURE_NOW, isCollectable, type PostingsConfig } from "./config.js";
import { collectJob, SOURCE_LABEL, type JobSnapshot } from "./collector.js";
import { GeocodeCache, createGeocoder, fixtureLookup, kakaoLookup, type Geocoder } from "./geocoder.js";
import { loadOccupationMap, type OccupationMap } from "./occupationMap.js";
import {
  decidePostingsStatus,
  postingsPaths,
  qualityRow,
  readSnapshot,
  readStatusFile,
  updateJobStatus,
  writeJsonAtomic,
  writeSnapshot,
  type PostingsStatus
} from "./store.js";
import { createFixtureWork24Client, createLiveWork24Client, maskSecrets, type Work24Client } from "./work24Client.js";

export const MAX_API_ITEMS = 1000;

export interface RefreshResult {
  job_code: string;
  ok: boolean;
  skipped?: string;
  error?: string;
  snapshot?: JobSnapshot;
}

export class PostingsService {
  private refreshing: Promise<RefreshResult[]> | null = null;

  constructor(
    readonly config: PostingsConfig,
    private readonly deps: { client?: Work24Client; geocodeLookup?: Parameters<typeof createGeocoder>[0]["lookup"] | null } = {}
  ) {}

  private mask(text: string) {
    return maskSecrets(text, [this.config.work24Key, this.config.kakaoKey]);
  }

  loadMap(): OccupationMap {
    return loadOccupationMap();
  }

  isRefreshing() {
    return this.refreshing !== null;
  }

  // 실제 모드 서버는 고정 데이터 스냅샷을 보여주지 않는다.
  private readUsableSnapshot(jobCode: string) {
    const snapshot = readSnapshot(this.config.dataDir, jobCode);
    if (snapshot && snapshot.fixture && !this.config.fixture) return null;
    return snapshot;
  }

  private createClient(log: (m: string) => void): Work24Client {
    if (this.deps.client) return this.deps.client;
    if (this.config.fixture) return createFixtureWork24Client(FIXTURE_DIR);
    return createLiveWork24Client({ authKey: this.config.work24Key, delayMs: this.config.requestDelayMs, log });
  }

  private createGeocoderFor(cache: GeocodeCache): Geocoder | null {
    if (this.deps.geocodeLookup !== undefined) {
      return this.deps.geocodeLookup ? createGeocoder({ lookup: this.deps.geocodeLookup, cache }) : null;
    }
    if (this.config.fixture) return createGeocoder({ lookup: fixtureLookup(FIXTURE_DIR), cache });
    if (!this.config.kakaoKey) return null;
    return createGeocoder({ lookup: kakaoLookup(this.config.kakaoKey), cache });
  }

  // 갱신 실행. 이미 돌고 있으면 그 실행을 기다려 같은 결과를 돌려준다(동시 실행 방지 잠금).
  refresh(jobCodes?: string[], log: (message: string) => void = () => {}): Promise<RefreshResult[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runRefresh(jobCodes, log).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(jobCodes: string[] | undefined, log: (message: string) => void) {
    const results: RefreshResult[] = [];
    if (!isCollectable(this.config)) {
      return [{ job_code: "*", ok: false, skipped: "수집 불가: 기능이 꺼져 있거나 WORK24_RECRUIT_AUTH_KEY가 없어." }];
    }
    const map = this.loadMap();
    const targets = jobCodes?.length ? jobCodes : Object.keys(map.jobs);
    const safeLog = (m: string) => log(this.mask(m));
    const client = this.createClient(safeLog);
    const cache = new GeocodeCache(postingsPaths(this.config.dataDir).geocodeCache);
    const geocoder = this.createGeocoderFor(cache);

    for (const jobCode of targets) {
      const entry = map.jobs[jobCode];
      if (!entry) {
        results.push({ job_code: jobCode, ok: false, skipped: "매핑 파일에 없는 직업" });
        continue;
      }
      if (entry.mode === "tbd") {
        safeLog(`▷ ${jobCode} ${entry.job_name}: 직종 미정(tbd)이라 건너뜀`);
        results.push({ job_code: jobCode, ok: false, skipped: "tbd" });
        continue;
      }
      const startedAt = new Date();
      safeLog(`▶ ${jobCode} ${entry.job_name}`);
      try {
        const snapshot = await collectJob({
          jobCode,
          entry,
          client,
          geocoder,
          regDate: this.config.regDate,
          maxPages: this.config.maxPages,
          now: this.config.fixture ? FIXTURE_NOW : startedAt,
          fetchedAt: startedAt,
          fixture: this.config.fixture,
          log: safeLog
        });
        snapshot.errors = snapshot.errors.map((e) => ({ ...e, message: this.mask(e.message) }));
        writeSnapshot(this.config.dataDir, snapshot);
        updateJobStatus(this.config.dataDir, jobCode, {
          last_attempt_at: startedAt.toISOString(),
          last_success_at: new Date().toISOString(),
          last_error: null
        });
        results.push({ job_code: jobCode, ok: true, snapshot });
      } catch (error) {
        const message = this.mask((error as Error)?.message ?? String(error));
        safeLog(`  실패: ${message}`);
        // 이전 스냅샷은 그대로 두고 실패 정보만 남긴다.
        updateJobStatus(this.config.dataDir, jobCode, {
          last_attempt_at: startedAt.toISOString(),
          last_failure_at: new Date().toISOString(),
          last_error: message
        });
        results.push({ job_code: jobCode, ok: false, error: message });
      } finally {
        cache.save();
      }
    }
    this.writeQuality(map);
    return results;
  }

  writeQuality(map = this.loadMap()) {
    const rows = [];
    for (const jobCode of Object.keys(map.jobs)) {
      try {
        const snapshot = this.readUsableSnapshot(jobCode);
        if (snapshot) rows.push(qualityRow(snapshot));
      } catch {
        // 깨진 스냅샷은 품질표에서 뺀다(상태 API에서 error로 보인다).
      }
    }
    writeJsonAtomic(postingsPaths(this.config.dataDir).quality, {
      generated_at: new Date().toISOString(),
      fixture: this.config.fixture,
      jobs: rows
    });
    return rows;
  }

  // 결과 화면 API 응답. 외부 API는 부르지 않는다.
  getJobPostings(jobCode: string) {
    let map: OccupationMap | null = null;
    try {
      map = this.loadMap();
    } catch {
      map = null;
    }
    const entry = map?.jobs[jobCode] ?? null;
    let snapshot: JobSnapshot | null = null;
    let snapshotReadError = false;
    try {
      snapshot = this.readUsableSnapshot(jobCode);
    } catch {
      snapshotReadError = true;
    }
    const run = readStatusFile(this.config.dataDir).jobs[jobCode] ?? null;
    const status: PostingsStatus = map
      ? decidePostingsStatus({
          enabled: this.config.enabled,
          collectable: isCollectable(this.config),
          mode: entry?.mode ?? null,
          snapshot: snapshot ? { fetched_at: snapshot.fetched_at, itemCount: snapshot.items.length } : null,
          snapshotReadError,
          run
        })
      : "error";
    const showData = status === "ok" || status === "stale" || status === "empty";
    const data = showData ? snapshot : null;
    const occupation = data
      ? data.query.occupation_labels ?? data.query.occupation.map((code) => ({ code, name: code }))
      : entry?.work24_codes ?? [];
    return {
      status,
      job_code: jobCode,
      job_name: data?.job_name ?? entry?.job_name ?? null,
      fetched_at: data?.fetched_at ?? null,
      source: SOURCE_LABEL,
      query: {
        mode: data?.query.mode ?? entry?.mode ?? null,
        occupation,
        keyword: data?.query.keyword ?? entry?.keyword ?? null,
        regDate: data?.query.regDate ?? (entry ? this.config.regDate : null)
      },
      counts: data
        ? {
            kept: data.counts.kept,
            metro: data.counts.metro,
            nonmetro: data.counts.nonmetro,
            region_unknown: data.counts.region_unknown,
            geo_address: data.counts.geo_address,
            geo_region: data.counts.geo_region,
            geo_none: data.counts.geo_none,
            by_sido: data.counts.by_sido,
            company_type: data.counts.company_type
          }
        : null,
      checks: data?.checks ?? null,
      items: data ? data.items.slice(0, MAX_API_ITEMS) : []
    };
  }

  getAdminStatus() {
    const map = this.loadMap();
    const runs = readStatusFile(this.config.dataDir).jobs;
    const jobs = Object.entries(map.jobs).map(([jobCode, entry]) => {
      let snapshot: JobSnapshot | null = null;
      let snapshotError: string | null = null;
      try {
        snapshot = this.readUsableSnapshot(jobCode);
      } catch (error) {
        snapshotError = (error as Error).message;
      }
      const run = runs[jobCode] ?? null;
      return {
        job_code: jobCode,
        job_name: entry.job_name,
        mode: entry.mode,
        work24_codes: entry.work24_codes,
        keyword: entry.keyword,
        evidence: entry.evidence,
        api_status: this.getJobPostings(jobCode).status,
        fetched_at: snapshot?.fetched_at ?? null,
        last_attempt_at: run?.last_attempt_at ?? null,
        last_success_at: run?.last_success_at ?? null,
        last_failure_at: run?.last_failure_at ?? null,
        last_error: run?.last_error ?? snapshotError,
        quality: snapshot ? qualityRow(snapshot) : null,
        counts: snapshot?.counts ?? null,
        checks: snapshot?.checks ?? null,
        errors: snapshot?.errors ?? []
      };
    });
    return {
      enabled: this.config.enabled,
      fixture: this.config.fixture,
      work24_key_configured: Boolean(this.config.work24Key),
      kakao_key_configured: Boolean(this.config.kakaoKey),
      refreshing: this.isRefreshing(),
      refresh_hours: this.config.refreshHours,
      reg_date: this.config.regDate,
      max_pages: this.config.maxPages,
      jobs
    };
  }

  getHealth() {
    let jobs: Record<string, PostingsStatus> = {};
    let lastSuccessAt: string | null = null;
    try {
      const map = this.loadMap();
      const runs = readStatusFile(this.config.dataDir).jobs;
      jobs = Object.fromEntries(Object.keys(map.jobs).map((code) => [code, this.getJobPostings(code).status]));
      for (const run of Object.values(runs)) {
        if (run.last_success_at && (!lastSuccessAt || run.last_success_at > lastSuccessAt)) lastSuccessAt = run.last_success_at;
      }
    } catch {
      jobs = {};
    }
    return {
      enabled: this.config.enabled,
      fixture: this.config.fixture,
      work24_key_configured: Boolean(this.config.work24Key),
      kakao_key_configured: Boolean(this.config.kakaoKey),
      last_success_at: lastSuccessAt,
      jobs
    };
  }

  // 스냅샷이 없거나 refreshHours보다 오래된 수집 대상 직업
  jobsDueForRefresh(now = new Date()) {
    const map = this.loadMap();
    const maxAgeMs = this.config.refreshHours * 60 * 60 * 1000;
    return Object.entries(map.jobs)
      .filter(([, entry]) => entry.mode !== "tbd")
      .filter(([jobCode]) => {
        try {
          const snapshot = this.readUsableSnapshot(jobCode);
          if (!snapshot) return true;
          return now.getTime() - Date.parse(snapshot.fetched_at) >= maxAgeMs;
        } catch {
          return true;
        }
      })
      .map(([jobCode]) => jobCode);
  }
}
