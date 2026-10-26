import fs from "node:fs";
import path from "node:path";
import type { JobSnapshot } from "./collector.js";

export type PostingsStatus = "ok" | "empty" | "stale" | "unmapped" | "unconfigured" | "error";

export interface JobRunStatus {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
}

export interface StatusFile {
  updated_at: string | null;
  jobs: Record<string, JobRunStatus>;
}

export function postingsPaths(dataDir: string) {
  return {
    snapshotsDir: path.join(dataDir, "snapshots"),
    snapshot: (jobCode: string) => path.join(dataDir, "snapshots", `${jobCode}.json`),
    status: path.join(dataDir, "status.json"),
    quality: path.join(dataDir, "quality.json"),
    geocodeCache: path.join(dataDir, "geocode-cache.json")
  };
}

// 임시 파일에 쓴 다음 rename으로 교체한다(읽는 쪽이 반쯤 쓰인 파일을 보지 않게).
export function writeJsonAtomic(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

const snapshotCache = new Map<string, { mtimeMs: number; snapshot: JobSnapshot }>();

// 없으면 null, 읽기·파싱 실패는 예외
export function readSnapshot(dataDir: string, jobCode: string): JobSnapshot | null {
  const file = postingsPaths(dataDir).snapshot(jobCode);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    snapshotCache.delete(file);
    return null;
  }
  const cached = snapshotCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.snapshot;
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as JobSnapshot;
  if (snapshot?.schema_version !== "job_postings_snapshot.v1" || !Array.isArray(snapshot.items)) {
    throw new Error(`스냅샷 형식이 올바르지 않아: ${path.basename(file)}`);
  }
  snapshotCache.set(file, { mtimeMs: stat.mtimeMs, snapshot });
  return snapshot;
}

export function writeSnapshot(dataDir: string, snapshot: JobSnapshot) {
  const file = postingsPaths(dataDir).snapshot(snapshot.job_code);
  writeJsonAtomic(file, snapshot);
  snapshotCache.delete(file);
}

export function readStatusFile(dataDir: string): StatusFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(postingsPaths(dataDir).status, "utf8")) as StatusFile;
    return { updated_at: parsed.updated_at ?? null, jobs: parsed.jobs ?? {} };
  } catch {
    return { updated_at: null, jobs: {} };
  }
}

export function updateJobStatus(dataDir: string, jobCode: string, patch: Partial<JobRunStatus>, now = new Date()) {
  const status = readStatusFile(dataDir);
  const prev: JobRunStatus = status.jobs[jobCode] ?? {
    last_attempt_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_error: null
  };
  status.jobs[jobCode] = { ...prev, ...patch };
  status.updated_at = now.toISOString();
  writeJsonAtomic(postingsPaths(dataDir).status, status);
  return status.jobs[jobCode];
}

// 결과 화면 API의 상태 결정(명세 4.3, 5.3). 외부 호출 없이 매핑·스냅샷·상태 파일만 본다.
export function decidePostingsStatus(input: {
  enabled: boolean;
  collectable: boolean;
  mode: "code" | "keyword" | "tbd" | null;
  snapshot: { fetched_at: string; itemCount: number } | null;
  snapshotReadError?: boolean;
  run: Pick<JobRunStatus, "last_failure_at"> | null;
}): PostingsStatus {
  if (!input.enabled) return "unconfigured";
  if (!input.mode || input.mode === "tbd") return "unmapped";
  if (input.snapshotReadError) return "error";
  if (input.snapshot) {
    const failedAt = Date.parse(input.run?.last_failure_at ?? "");
    const fetchedAt = Date.parse(input.snapshot.fetched_at);
    if (Number.isFinite(failedAt) && (!Number.isFinite(fetchedAt) || failedAt > fetchedAt)) return "stale";
    return input.snapshot.itemCount > 0 ? "ok" : "empty";
  }
  // 스냅샷이 아직 없을 때: 수집할 수 없는 환경이면 미설정, 수집 가능한데 없으면(첫 수집 전·실패) 오류
  return input.collectable ? "error" : "unconfigured";
}

export interface QualityRow {
  job_code: string;
  job_name: string;
  fetched_at: string;
  fixture: boolean;
  received: number;
  duplicates_removed: number;
  expired_removed: number;
  filtered_removed: number;
  kept: number;
  geo_rate: { address: number | null; region: number | null; none: number | null };
  metro: number;
  nonmetro: number;
  region_unknown: number;
  sido_cross_check_rate: number | null;
  sido_cross_check: { compared: number; agreed: number };
  relevance_keyword_hit_rate: number | null;
  checks: JobSnapshot["checks"];
}

const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

export function qualityRow(snapshot: JobSnapshot): QualityRow {
  const c = snapshot.counts;
  return {
    job_code: snapshot.job_code,
    job_name: snapshot.job_name,
    fetched_at: snapshot.fetched_at,
    fixture: snapshot.fixture,
    received: c.received,
    duplicates_removed: c.duplicates_removed,
    expired_removed: c.expired_removed,
    filtered_removed: c.title_filtered_out + c.occupation_mismatch_removed + c.regdate_out_of_range_removed,
    kept: c.kept,
    geo_rate: { address: ratio(c.geo_address, c.kept), region: ratio(c.geo_region, c.kept), none: ratio(c.geo_none, c.kept) },
    metro: c.metro,
    nonmetro: c.nonmetro,
    region_unknown: c.region_unknown,
    sido_cross_check_rate: ratio(c.sido_cross_check.agreed, c.sido_cross_check.compared),
    sido_cross_check: c.sido_cross_check,
    relevance_keyword_hit_rate: c.relevance_keyword_hit_rate,
    checks: snapshot.checks
  };
}
