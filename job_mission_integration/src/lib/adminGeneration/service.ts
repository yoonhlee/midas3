import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/database.js";
import {
  addGenerationStart,
  deleteGenerationRun,
  findGenerationRunByCatalogKey,
  getGenerationRun,
  getGenerationStartCount,
  insertGenerationRun,
  interruptRunningGenerationRuns,
  listGenerationRuns,
  recoverSavedReviewRuns,
  updateGenerationRun,
  type GenerationRunRow,
  type GenerationRunStatus
} from "../db/repos.js";
import type { ServerConfig } from "../../server/config.js";
import { ApiError } from "../../server/http.js";
import type { MissionStore } from "../../server/missionStore.js";
import {
  catalogKeys,
  isAdminMissionKey,
  prepareExportStaging,
  removeCatalogMission,
  restoreCatalog,
  snapshotCatalog,
  type CatalogSnapshot
} from "./catalogFile.js";
import { DIFFICULTIES, type CommandOutcome, type Difficulty, type GenerationCommands, type PreflightResult, type TargetInput } from "./commands.js";
import type { NcsCatalog, SelectedLink } from "./ncsCatalog.js";
import { applyProgressLine, initialProgress, type ProgressState, type Stage } from "./progress.js";
import { readReview, readRunArtifacts, runDirFor, type ReviewVerdict } from "./runFiles.js";

// 관리자 미션 생성 한 건의 순서: 확인 → 잠금 → 하루 한도 → 시작 전 확인 → 대상 파일 → (뒤에서) 생성 → 검수 → 검토 대기.
// 한 번에 하나만 돈다. 생성 기록은 DB(repos.ts)에 남고, 로그는 서버가 도는 동안만 기억한다.

export interface StartInput extends TargetInput {
  review: boolean;
}

export interface StageView {
  id: "blueprint" | "blueprint_check" | "writing" | "mission_check" | "review" | "approval";
  state: "pending" | "active" | "done" | "skipped" | "failed";
  rewritten: boolean;
}

export interface RunListItem {
  runId: string;
  status: GenerationRunStatus;
  stage: Stage;
  selection: {
    jobCode: string;
    jobName: string;
    execJobId: string;
    execJobText: string;
    unitKey: string;
    unitName: string;
    linkKind: string;
    difficulty: Difficulty;
    review: boolean;
    allowedMaterialTypes: string[] | null;
  };
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  missionId: string | null;
  missionTitle: string | null;
  reviewVerdict: ReviewVerdict | null;
  catalog: { key: string | null; canAdd: boolean; canReview: boolean };
  error: { code: string; message: string } | null;
}

export interface LogEntry {
  at: string;
  stream: "system" | "stdout";
  message: string;
}

export interface RunView extends RunListItem {
  stages: StageView[];
  mission: unknown | null;
  basis: unknown | null;
  reviewRecord: unknown | null;
  logs: LogEntry[];
}

export interface CatalogView {
  jobs: Array<{
    jobCode: string;
    jobName: string;
    counts: Record<Difficulty, number>;
    addedByAdminOnly: boolean;
    missions: Array<{ key: string; missionId: string; title: string; difficulty: string; execJobId: string | null; addedByAdmin: boolean; runId: string | null }>;
  }>;
  total: { jobs: number; missions: number; addedByAdmin: number };
}

export interface GenerationStatus {
  mode: "live" | "fake";
  preflight: PreflightResult & { checkedAt: string };
  today: { day: string; started: number; limit: number };
  narrowing: boolean;
  activeRunId: string | null;
  estimates: Record<Difficulty, { generate: { seconds: number; usd: number }; review: { seconds: number; usd: number } }>;
}

// 실제 호출 확인에서 난이도마다 한 건씩 잰 값을 어림한 고정 숫자.
const ESTIMATES: GenerationStatus["estimates"] = {
  easy: { generate: { seconds: 60, usd: 0.25 }, review: { seconds: 20, usd: 0.06 } },
  normal: { generate: { seconds: 75, usd: 0.28 }, review: { seconds: 20, usd: 0.05 } },
  hard: { generate: { seconds: 125, usd: 0.4 }, review: { seconds: 40, usd: 0.12 } }
};
const PREFLIGHT_CACHE_MS = 60_000;
const LOG_LIMIT = 500;
const STAGE_ORDER: StageView["id"][] = ["blueprint", "blueprint_check", "writing", "mission_check", "review", "approval"];

// 한국 시간의 YYYY-MM-DD. 하루 한도를 세는 날짜다.
export function seoulDay(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseRewrites(raw: string): { blueprint: number; mission: number } {
  try {
    const value = JSON.parse(raw) as { blueprint?: unknown; mission?: unknown };
    return { blueprint: Number(value.blueprint) || 0, mission: Number(value.mission) || 0 };
  } catch {
    return { blueprint: 0, mission: 0 };
  }
}

function parseTypes(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map(String) : null;
  } catch {
    return null;
  }
}

function stageIndex(stage: string) {
  const index = STAGE_ORDER.indexOf(stage as StageView["id"]);
  return index === -1 ? 0 : index; // queued(아직 진행 줄이 없음)는 설계 단계로 본다
}

export function buildStages(row: GenerationRunRow): StageView[] {
  const rewrites = parseRewrites(row.rewrites);
  const reviewRequested = row.review_requested === 1;
  const states: StageView["state"][] = STAGE_ORDER.map(() => "pending");
  if (row.status === "ready" || row.status === "added") {
    for (let i = 0; i < 4; i += 1) states[i] = "done";
    states[4] = row.review_verdict === "review_failed" ? "failed" : row.review_verdict ? "done" : "skipped";
    states[5] = row.status === "added" ? "done" : "active";
  } else {
    const current = stageIndex(row.stage);
    for (let i = 0; i < current; i += 1) states[i] = "done";
    states[current] = row.status === "running" ? "active" : "failed";
    if (!reviewRequested && current < 4) states[4] = "skipped";
  }
  return STAGE_ORDER.map((id, index) => ({
    id,
    state: states[index],
    rewritten: (id === "blueprint_check" && rewrites.blueprint > 0) || (id === "mission_check" && rewrites.mission > 0)
  }));
}

function linkError(error: "JOB_NOT_FOUND" | "LINK_NOT_FOUND" | "LINK_NOT_SELECTABLE"): ApiError {
  if (error === "JOB_NOT_FOUND") return new ApiError(404, "GENERATION_JOB_NOT_FOUND", "Job was not found in the NCS job files.");
  if (error === "LINK_NOT_FOUND") return new ApiError(404, "GENERATION_LINK_NOT_FOUND", "No link between this duty sentence and competency unit.");
  return new ApiError(400, "GENERATION_LINK_NOT_SELECTABLE", "Only direct and field-limited links can be used for generation.");
}

export interface AdminGenerationDeps {
  config: ServerConfig;
  db: Db;
  missionStore: MissionStore;
  ncs: NcsCatalog;
  commands: GenerationCommands;
  now?: () => Date;
}

export class AdminGenerationService {
  protected readonly config: ServerConfig;
  protected readonly db: Db;
  protected readonly missionStore: MissionStore;
  protected readonly ncs: NcsCatalog;
  protected readonly commands: GenerationCommands;
  protected readonly now: () => Date;
  // 한 번에 하나: 시작부터 뒤의 일이 끝날 때까지 실행 번호를 쥐고 있다.
  protected activeRunId: string | null = null;
  private readonly logs = new Map<string, LogEntry[]>();
  private readonly background = new Set<Promise<void>>();
  private preflightCache: (PreflightResult & { checkedAt: string; atMs: number }) | null = null;
  private readonly materialCache = new Map<string, string[] | null>();
  // 카탈로그 파일을 바꾸는 일(추가, 카탈로그에서 삭제, 추가된 실행의 삭제)은 한 번에 하나씩 차례로 한다.
  private catalogChain: Promise<unknown> = Promise.resolve();
  // 추가 · 삭제가 기다리거나 도는 중인 실행. 그동안은 검수만 다시 돌리기를 받지 않는다.
  private readonly catalogBusy = new Map<string, number>();

  constructor(deps: AdminGenerationDeps) {
    this.config = deps.config;
    this.db = deps.db;
    this.missionStore = deps.missionStore;
    this.ncs = deps.ncs;
    this.commands = deps.commands;
    this.now = deps.now ?? (() => new Date());
    // 서버를 다시 켰을 때: 미션을 저장하고 검수하던 실행은 검토 대기(검수 실패)로 돌리고,
    // 그 밖에 돌던 실행은 끝을 알 수 없으므로 중단됨으로 바꾼다.
    recoverSavedReviewRuns(this.db);
    interruptRunningGenerationRuns(this.db);
  }

  // ── 조회 ────────────────────────────────────────────
  async status(): Promise<GenerationStatus> {
    const preflight = await this.cachedPreflight();
    const day = seoulDay(this.now());
    return {
      mode: preflight.mode,
      preflight,
      today: { day, started: getGenerationStartCount(this.db, day), limit: this.config.adminGeneration.dailyLimit },
      narrowing: this.config.adminGeneration.narrow,
      activeRunId: this.activeRunId,
      estimates: ESTIMATES
    };
  }

  async materialTypes(input: TargetInput): Promise<{ narrowing: boolean; allowedMaterialTypes: string[] | null }> {
    const link = this.ncs.findSelectable(input.jobCode, input.execJobId, input.unitKey);
    if ("error" in link) throw linkError(link.error);
    if (!this.config.adminGeneration.narrow) return { narrowing: false, allowedMaterialTypes: null };
    const key = [input.jobCode, input.execJobId, input.unitKey, input.difficulty].join("|");
    if (!this.materialCache.has(key)) {
      const plan = await this.commands.planTarget(input, { narrow: true });
      if (!plan.ok) throw new ApiError(500, plan.code, plan.message || "Material types could not be planned.");
      this.materialCache.set(key, plan.allowedMaterialTypes);
    }
    return { narrowing: true, allowedMaterialTypes: this.materialCache.get(key) ?? null };
  }

  get(runId: string): RunView | null {
    const row = getGenerationRun(this.db, runId);
    return row ? this.toView(row) : null;
  }

  list(limit = 50): RunListItem[] {
    return listGenerationRuns(this.db, limit).map((row) => this.toListItem(row));
  }

  // 뒤에서 도는 일이 끝날 때까지 기다린다(테스트와 서버 종료용).
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ── 생성 시작 ───────────────────────────────────────
  async start(input: StartInput): Promise<RunView> {
    const link = this.ncs.findSelectable(input.jobCode, input.execJobId, input.unitKey);
    if ("error" in link) throw linkError(link.error);
    // 기다림(await)이 나오기 전에 잠금을 건다. 거의 동시에 온 두 요청 가운데 하나만 지나간다.
    if (this.activeRunId) throw new ApiError(409, "GENERATION_ALREADY_RUNNING", "Another mission generation run is in progress.", { runId: this.activeRunId });
    const runId = randomUUID();
    this.activeRunId = runId;
    let launched = false;
    try {
      const day = seoulDay(this.now());
      const started = getGenerationStartCount(this.db, day);
      const limit = this.config.adminGeneration.dailyLimit;
      if (started >= limit) throw new ApiError(429, "GENERATION_DAILY_LIMIT", "Daily generation limit reached.", { started, limit });

      const preflight = await this.freshPreflight();
      if (!preflight.ok) {
        const failed = preflight.checks.find((check) => !check.ok);
        throw new ApiError(503, failed?.code ?? "ANTHROPIC_PREFLIGHT_FAILED", failed?.message || "Generation preflight failed.", { checks: preflight.checks });
      }

      const targetFile = path.join(this.config.paths.outputs, "admin_targets", `${runId}.json`);
      const plan = await this.commands.planTarget(input, { narrow: this.config.adminGeneration.narrow, outFile: targetFile });
      if (!plan.ok) throw new ApiError(500, plan.code, plan.message || "Target file could not be written.");

      insertGenerationRun(this.db, this.newRow(runId, input, link, plan.allowedMaterialTypes));
      addGenerationStart(this.db, day);
      this.log(runId, "system", `생성 시작: ${link.jobCode} ${link.execJobId} ${link.unitKey} ${input.difficulty}`);
      this.track(this.runGeneration(runId, input, targetFile));
      launched = true;
      return this.get(runId) as RunView;
    } finally {
      if (!launched) this.activeRunId = null;
    }
  }

  // ── 카탈로그와 기록 ─────────────────────────────────
  // 카탈로그에 추가: 이름이 고정된 준비 폴더를 거쳐 내보내기 스크립트를 부른다. 실패하면 색인과 파일을 되돌린다.
  async addToCatalog(runId: string): Promise<RunView> {
    this.requireSettledRun(runId);
    return this.serialForRun(runId, async () => {
      const row = this.requireSettledRun(runId);
      if (row.status === "added") return this.toView(row);
      if (row.status !== "ready") throw new ApiError(409, "CATALOG_ADD_NOT_ALLOWED", "Only runs waiting for review can be added.", { reason: "NOT_READY" });
      if (row.review_verdict === "fail") {
        throw new ApiError(409, "CATALOG_ADD_NOT_ALLOWED", "A mission whose review found a problem cannot be added.", { reason: "REVIEW_VERDICT_FAIL" });
      }
      const runDir = this.runDirOf(row);
      const artifacts = runDir ? readRunArtifacts(runDir) : null;
      if (!artifacts?.saved || !artifacts.missionFile) {
        throw new ApiError(409, "CATALOG_ADD_NOT_ALLOWED", "The mission file of this run is missing.", { reason: "NOT_READY" });
      }
      const missionsDir = this.config.paths.missions;
      const before = this.snapshot();
      const keysBefore = new Set(catalogKeys(missionsDir));
      let staging: string | null = null;
      try {
        staging = prepareExportStaging(this.config.paths.outputs, artifacts.missionFile, row.job_code, row.difficulty);
        const outcome = await this.commands.exportMission(staging, missionsDir);
        if (outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnError) {
          throw new ApiError(500, "MISSION_EXPORT_FAILED", "export_missions.py failed.", { output: outcome.spawnError ?? outcome.lines.slice(-20) });
        }
        const added = catalogKeys(missionsDir).filter((key) => !keysBefore.has(key));
        if (added.length !== 1 || !isAdminMissionKey(added[0])) {
          throw new ApiError(500, "MISSION_EXPORT_KEY_UNEXPECTED", "The exported mission key was not the expected admin key.", { keys: added });
        }
        const validation = this.validateCatalog();
        if (!validation.ok) throw new ApiError(500, "MISSION_EXPORT_VALIDATION_FAILED", "Export finished, but mission catalog validation failed.", validation);
        updateGenerationRun(this.db, runId, { status: "added", catalog_key: added[0] });
        this.log(runId, "system", `카탈로그에 추가: ${added[0]}`);
        return this.get(runId) as RunView;
      } catch (error) {
        this.restoreCatalogAndRefresh(before);
        this.log(runId, "system", `카탈로그 추가 실패: ${error instanceof ApiError ? error.code : String(error)}`);
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, "MISSION_EXPORT_FAILED", error instanceof Error ? error.message : String(error));
      } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true });
      }
    });
  }

  // 카탈로그에서만 뺀다(관리자 페이지에서 추가한 미션만). 그 키를 가진 기록은 검토 대기로 돌아간다.
  async removeFromCatalog(missionKey: string): Promise<{ missionKey: string; runId: string | null }> {
    return this.serial(async () => {
      const keys = catalogKeys(this.config.paths.missions);
      if (!isAdminMissionKey(missionKey)) {
        if (keys.includes(missionKey)) throw new ApiError(403, "CATALOG_MISSION_PROTECTED", "Missions that were not added from the admin page cannot be removed.");
        throw new ApiError(404, "CATALOG_MISSION_NOT_FOUND", "Mission was not found in the catalog.");
      }
      if (!keys.includes(missionKey)) throw new ApiError(404, "CATALOG_MISSION_NOT_FOUND", "Mission was not found in the catalog.");
      this.removeKeyFromCatalog(missionKey);
      const run = findGenerationRunByCatalogKey(this.db, missionKey);
      if (run) {
        updateGenerationRun(this.db, run.id, { status: "ready", catalog_key: null });
        this.log(run.id, "system", `카탈로그에서 삭제: ${missionKey}`);
      }
      return { missionKey, runId: run?.id ?? null };
    });
  }

  // 생성 결과를 완전히 지운다: 추가돼 있으면 카탈로그에서 빼고, 실행 폴더와 대상 파일, 기록과 로그를 지운다.
  async deleteRun(runId: string): Promise<void> {
    this.requireSettledRun(runId);
    await this.serialForRun(runId, async () => {
      const row = this.requireSettledRun(runId);
      const key = row.catalog_key;
      if (row.status === "added" && key && isAdminMissionKey(key) && catalogKeys(this.config.paths.missions).includes(key)) {
        this.removeKeyFromCatalog(key);
      }
      const runDir = this.runDirOf(row); // 이름이 이상하면 null이라 지우지 않는다
      if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      if (/^[A-Za-z0-9-]+$/.test(row.id)) fs.rmSync(path.join(this.config.paths.outputs, "admin_targets", `${row.id}.json`), { force: true });
      deleteGenerationRun(this.db, runId);
      this.forgetLogs(runId);
    });
  }

  // 검수만 다시 돌리기: 검수가 실패했거나 검수 없이 만든 미션만. 하루 건수에 세지 않는다.
  async rerunReview(runId: string): Promise<RunView> {
    const row = getGenerationRun(this.db, runId);
    if (!row) throw new ApiError(404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
    // 도는 중이거나 카탈로그 추가 · 삭제가 기다리는 실행이면 받지 않는다(추가와 겹치면 같은 미션이 두 번 들어갈 수 있다).
    if (row.status === "running" || this.catalogBusy.has(runId)) {
      throw new ApiError(409, "GENERATION_STILL_RUNNING", "The run is still in progress.");
    }
    const runDir = this.runDirOf(row);
    if (!this.toListItem(row).catalog.canReview || !runDir) {
      throw new ApiError(409, "REVIEW_NOT_ALLOWED", "Review can be rerun only for missions whose review failed or was skipped.");
    }
    if (this.activeRunId) throw new ApiError(409, "GENERATION_ALREADY_RUNNING", "Another mission generation run is in progress.", { runId: this.activeRunId });
    this.activeRunId = runId;
    updateGenerationRun(this.db, runId, { status: "running", stage: "review", review_requested: 1, review_verdict: null, finished_at: null });
    this.log(runId, "system", "검수 다시 돌리기");
    this.track(
      (async () => {
        try {
          await this.reviewRun(runId, runDir, row.job_code, row.difficulty);
        } catch (error) {
          updateGenerationRun(this.db, runId, { review_verdict: "review_failed" });
          this.log(runId, "system", `검수 실패: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          updateGenerationRun(this.db, runId, { status: "ready", stage: "done", finished_at: this.now().toISOString() });
          if (this.activeRunId === runId) this.activeRunId = null;
        }
      })()
    );
    return this.get(runId) as RunView;
  }

  // 서비스에 올라가 있는 미션(직업별).
  catalog(): CatalogView {
    const byJob = new Map<string, CatalogView["jobs"][number]>();
    let addedByAdmin = 0;
    for (const mission of this.missionStore.get()?.allMissions ?? []) {
      const raw = (mission._raw ?? {}) as { mission?: { difficulty?: { level?: unknown } }; target_exec_job?: { exec_job_id?: unknown } };
      const admin = isAdminMissionKey(mission.key);
      if (admin) addedByAdmin += 1;
      const difficulty = String(raw.mission?.difficulty?.level ?? "");
      const job = byJob.get(mission.job_code) ?? {
        jobCode: mission.job_code,
        jobName: mission.job_name,
        counts: { easy: 0, normal: 0, hard: 0 },
        addedByAdminOnly: true,
        missions: []
      };
      if ((DIFFICULTIES as readonly string[]).includes(difficulty)) job.counts[difficulty as Difficulty] += 1;
      job.addedByAdminOnly = job.addedByAdminOnly && admin;
      job.missions.push({
        key: mission.key,
        missionId: mission.mission_id,
        title: mission.title,
        difficulty,
        execJobId: typeof raw.target_exec_job?.exec_job_id === "string" ? raw.target_exec_job.exec_job_id : null,
        addedByAdmin: admin,
        runId: admin ? findGenerationRunByCatalogKey(this.db, mission.key)?.id ?? null : null
      });
      byJob.set(mission.job_code, job);
    }
    const jobs = [...byJob.values()];
    return { jobs, total: { jobs: jobs.length, missions: jobs.reduce((sum, job) => sum + job.missions.length, 0), addedByAdmin } };
  }

  // ── 안쪽 ────────────────────────────────────────────
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.catalogChain.then(work, work);
    this.catalogChain = next.catch(() => undefined);
    return next;
  }

  // 실행 하나의 카탈로그 일. 기다리는 동안과 도는 동안 그 실행을 바쁨으로 표시한다.
  private serialForRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    this.catalogBusy.set(runId, (this.catalogBusy.get(runId) ?? 0) + 1);
    return this.serial(work).finally(() => {
      const left = (this.catalogBusy.get(runId) ?? 1) - 1;
      if (left > 0) this.catalogBusy.set(runId, left);
      else this.catalogBusy.delete(runId);
    });
  }

  // 바꾸기 전 모습을 읽지 못하면 카탈로그를 건드리지 않고 멈춘다.
  private snapshot(keyToRemove?: string): CatalogSnapshot {
    try {
      return snapshotCatalog(this.config.paths.missions, keyToRemove);
    } catch (error) {
      throw new ApiError(500, "CATALOG_UPDATE_FAILED", "The mission catalog could not be read before changing it.", {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private requireSettledRun(runId: string): GenerationRunRow {
    const row = getGenerationRun(this.db, runId);
    if (!row) throw new ApiError(404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
    if (row.status === "running") throw new ApiError(409, "GENERATION_STILL_RUNNING", "The run is still in progress.");
    return row;
  }

  // 카탈로그를 검증하고 통과하면 서비스의 미션 목록을 바꾼다. 색인이 가리키는 파일이 없으면 던지므로 그것도 실패로 다룬다.
  private validateCatalog(): { ok: boolean; issues: Array<{ code: string; message: string }> } {
    try {
      const result = this.missionStore.validateAndRefresh();
      return { ok: result.ok, issues: result.issues };
    } catch (error) {
      return { ok: false, issues: [{ code: "CATALOG_READ_FAILED", message: error instanceof Error ? error.message : String(error) }] };
    }
  }

  private restoreCatalogAndRefresh(snapshot: CatalogSnapshot) {
    restoreCatalog(this.config.paths.missions, snapshot);
    this.validateCatalog();
  }

  private removeKeyFromCatalog(missionKey: string) {
    const missionsDir = this.config.paths.missions;
    const snapshot = this.snapshot(missionKey);
    let failure: string | null = null;
    try {
      removeCatalogMission(missionsDir, missionKey);
      const validation = this.validateCatalog();
      if (!validation.ok) failure = validation.issues.map((issue) => issue.code).join(", ") || "validation failed";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== null) {
      this.restoreCatalogAndRefresh(snapshot);
      throw new ApiError(500, "CATALOG_UPDATE_FAILED", "The mission could not be removed from the catalog.", { reason: failure });
    }
  }

  // 뒤에서 도는 일을 기억한다. 그 안에서 난 오류(예: DB 오류)가 처리되지 않은 거절로 서버를 끄지 않게 여기서 받는다.
  protected track(work: Promise<void>) {
    const job: Promise<void> = work
      .catch((error) => console.error(`[admin-generation] background work failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.background.delete(job));
    this.background.add(job);
  }

  protected log(runId: string, stream: LogEntry["stream"], message: string) {
    const entries = this.logs.get(runId) ?? [];
    entries.push({ at: this.now().toISOString(), stream, message });
    if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
    this.logs.set(runId, entries);
  }

  protected forgetLogs(runId: string) {
    this.logs.delete(runId);
  }

  private async freshPreflight() {
    const result = await this.commands.preflight();
    const at = this.now();
    this.preflightCache = { ...result, checkedAt: at.toISOString(), atMs: at.getTime() };
    return result;
  }

  private async cachedPreflight(): Promise<PreflightResult & { checkedAt: string }> {
    const cached = this.preflightCache;
    if (!cached || this.now().getTime() - cached.atMs >= PREFLIGHT_CACHE_MS) await this.freshPreflight();
    const { atMs: _atMs, ...result } = this.preflightCache!;
    return result;
  }

  private newRow(runId: string, input: StartInput, link: SelectedLink, allowed: string[] | null) {
    return {
      id: runId,
      status: "running" as const,
      stage: "queued",
      job_code: link.jobCode,
      job_name: link.jobName,
      exec_job_id: link.execJobId,
      exec_job_text: link.execJobText,
      unit_key: link.unitKey,
      unit_name: link.unitName,
      link_kind: link.linkKind,
      difficulty: input.difficulty,
      review_requested: input.review ? 1 : 0,
      allowed_material_types: allowed ? JSON.stringify(allowed) : null,
      run_folder: null,
      mission_id: null,
      mission_title: null,
      review_verdict: null,
      rewrites: JSON.stringify({ blueprint: 0, mission: 0 }),
      catalog_key: null,
      error_code: null,
      error_message: null
    };
  }

  private fail(runId: string, code: string, message: string) {
    this.log(runId, "system", `실패: ${code} ${message}`);
    updateGenerationRun(this.db, runId, { status: "failed", error_code: code, error_message: message.slice(0, 500), finished_at: this.now().toISOString() });
  }

  private async runGeneration(runId: string, input: StartInput, targetFile: string) {
    try {
      let state: ProgressState = initialProgress();
      const onLine = (line: string) => {
        this.log(runId, "stdout", line);
        const next = applyProgressLine(state, line);
        if (next === state) return;
        const changed = next.stage !== state.stage || next.runFolder !== state.runFolder || JSON.stringify(next.rewrites) !== JSON.stringify(state.rewrites);
        state = next;
        if (changed) updateGenerationRun(this.db, runId, { stage: state.stage, run_folder: state.runFolder, rewrites: JSON.stringify(state.rewrites) });
      };
      const outcome = await this.commands.generate(targetFile, onLine);
      if (outcome.timedOut) return this.fail(runId, "GENERATION_TIMEOUT", "Generation took too long and was stopped.");
      if (outcome.spawnError) return this.fail(runId, "GENERATION_PYTHON_UNAVAILABLE", outcome.spawnError);
      const runDir = state.runFolder ? runDirFor(this.config.paths.outputs, state.runFolder) : null;
      if (!runDir) return this.fail(runId, "GENERATION_RUN_DIR_NOT_FOUND", "The generator did not report its run folder.");
      const artifacts = readRunArtifacts(runDir);
      if (!artifacts.saved) {
        return this.fail(runId, artifacts.failureCode ?? state.failureCode ?? "GENERATION_NOT_SAVED", lastLines(outcome));
      }
      updateGenerationRun(this.db, runId, { mission_id: artifacts.missionId, mission_title: artifacts.missionTitle });
      if (input.review) await this.reviewRun(runId, runDir, input.jobCode, input.difficulty);
      updateGenerationRun(this.db, runId, { status: "ready", stage: "done", finished_at: this.now().toISOString() });
      this.log(runId, "system", "검토 대기");
    } catch (error) {
      this.fail(runId, "GENERATION_INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    } finally {
      if (this.activeRunId === runId) this.activeRunId = null;
    }
  }

  // 검수: 프로세스가 죽거나 시간이 넘어도 미션은 남는다. 판정만 review_failed가 된다.
  protected async reviewRun(runId: string, runDir: string, jobCode: string, difficulty: string) {
    updateGenerationRun(this.db, runId, { stage: "review" });
    const outcome = await this.commands.review(runDir, (line) => this.log(runId, "stdout", line));
    const verdict: ReviewVerdict = outcome.timedOut || outcome.spawnError ? "review_failed" : readReview(runDir, jobCode, difficulty).verdict;
    updateGenerationRun(this.db, runId, { review_verdict: verdict });
    this.log(runId, "system", `검수 판정: ${verdict}`);
  }

  protected runDirOf(row: GenerationRunRow): string | null {
    return row.run_folder ? runDirFor(this.config.paths.outputs, row.run_folder) : null;
  }

  protected toListItem(row: GenerationRunRow): RunListItem {
    const verdict = (row.review_verdict as ReviewVerdict | null) ?? null;
    const ready = row.status === "ready";
    return {
      runId: row.id,
      status: row.status,
      stage: row.stage as Stage,
      selection: {
        jobCode: row.job_code,
        jobName: row.job_name,
        execJobId: row.exec_job_id,
        execJobText: row.exec_job_text,
        unitKey: row.unit_key,
        unitName: row.unit_name,
        linkKind: row.link_kind,
        difficulty: row.difficulty as Difficulty,
        review: row.review_requested === 1,
        allowedMaterialTypes: parseTypes(row.allowed_material_types)
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      missionId: row.mission_id,
      missionTitle: row.mission_title,
      reviewVerdict: verdict,
      catalog: {
        key: row.catalog_key,
        canAdd: ready && verdict !== "fail",
        canReview: ready && (verdict === null || verdict === "review_failed")
      },
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null
    };
  }

  protected toView(row: GenerationRunRow): RunView {
    const runDir = this.runDirOf(row);
    const artifacts = runDir ? readRunArtifacts(runDir) : null;
    const review = runDir ? readReview(runDir, row.job_code, row.difficulty) : null;
    return {
      ...this.toListItem(row),
      stages: buildStages(row),
      mission: artifacts?.mission ?? null,
      basis: artifacts?.basis ?? null,
      reviewRecord: review?.record ?? null,
      logs: [...(this.logs.get(row.id) ?? [])]
    };
  }
}

function lastLines(outcome: CommandOutcome) {
  return outcome.lines.slice(-5).join("\n") || "The mission was not saved.";
}
