import express from "express";
import type { ZodTypeAny, z } from "zod";
import { isAdminMissionKey } from "../../lib/adminGeneration/catalogFile.js";
import { DIFFICULTIES, type Difficulty } from "../../lib/adminGeneration/commands.js";
import type { NcsCatalog } from "../../lib/adminGeneration/ncsCatalog.js";
import type { AdminGenerationService, RunView } from "../../lib/adminGeneration/service.js";
import { AdminGenerationRunsQuerySchema, AdminGenerationStartRequestSchema, AdminMaterialTypesQuerySchema } from "../../lib/api/contracts.js";
import type { ServerConfig } from "../config.js";
import { ApiError, asyncRoute, extractApiToken } from "../http.js";
import { requireAdmin } from "../middleware.js";
import type { MissionStore } from "../missionStore.js";

// 관리자 미션 생성 API (/api/admin/mission-generation/*). 일은 src/lib/adminGeneration/의 서비스가 맡고, 여기서는 받고 돌려주기만 한다.
// 읽기는 조회 전용 열기(ADMIN_DEMO_UNLOCK)에서도 열리고, 바꾸기는 늘 암호가 있어야 한다.

const BASE = "/api/admin/mission-generation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "GENERATION_BAD_REQUEST", "Request does not match the mission generation contract.", parsed.error.issues);
  return parsed.data;
}

// 암호 없이 볼 때(조회 전용 열기)는 서비스에 올라갈 수 있는 미션의 답을 내지 않는다:
// 미션의 기대 답 · 채점 기준(evaluation)과 검수에서 풀어 본 답(solver_result.answers)을 뺀다.
function withoutAnswers(run: RunView): RunView {
  const strip = (value: unknown, key: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { [key]: _hidden, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  const record = run.reviewRecord as Record<string, unknown> | null;
  return {
    ...run,
    mission: strip(run.mission, "evaluation"),
    reviewRecord: record && typeof record === "object" ? { ...record, solver_result: strip(record.solver_result, "answers") } : record
  };
}

// runId가 UUID 모양이 아니면 서비스를 부르지 않는다.
function runIdOf(req: express.Request): string {
  const runId = String(req.params.runId ?? "");
  if (!UUID.test(runId)) throw new ApiError(404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
  return runId;
}

export function adminGenerationRouter(deps: { config: ServerConfig; service: AdminGenerationService; ncs: NcsCatalog; missionStore: MissionStore }) {
  const { config, service, ncs, missionStore } = deps;
  const router = express.Router();
  const guard = requireAdmin(config, { allowDemoRead: true });

  const catalogMissions = () => missionStore.get()?.allMissions ?? [];
  // 조회 전용 열기(암호 없이 읽기)로 온 요청인지. 암호가 맞으면 참이다.
  const hasAdminToken = (req: express.Request) => Boolean(config.admin.password) && extractApiToken(req) === config.admin.password;

  router.get(`${BASE}/status`, guard, asyncRoute(async (_req, res) => {
    const status = await service.status();
    res.json({
      ...status,
      adminLockEnabled: !config.admin.demoUnlock && Boolean(config.admin.password),
      adminDemoUnlockEnabled: config.admin.demoUnlock
    });
  }));

  router.get(`${BASE}/jobs`, guard, (_req, res) => {
    const missions = catalogMissions();
    const jobs = ncs.jobs().map((job) => {
      const ofJob = missions.filter((mission) => mission.job_code === job.jobCode);
      return { ...job, catalog: { missionCount: ofJob.length, addedByAdminCount: ofJob.filter((mission) => isAdminMissionKey(mission.key)).length } };
    });
    res.json({ jobs, total: jobs.length });
  });

  router.get(`${BASE}/jobs/:jobCode/sentences`, guard, (req, res) => {
    const jobCode = String(req.params.jobCode);
    const sentences = ncs.sentences(jobCode);
    if (!sentences) throw new ApiError(404, "GENERATION_JOB_NOT_FOUND", "Job was not found in the NCS job files.");
    // 카탈로그에 그 직업 · 그 문장 번호로 있는 미션의 난이도
    const existing = new Map<string, Set<Difficulty>>();
    for (const mission of catalogMissions()) {
      if (mission.job_code !== jobCode) continue;
      const raw = (mission._raw ?? {}) as { mission?: { difficulty?: { level?: unknown } }; target_exec_job?: { exec_job_id?: unknown } };
      const execJobId = raw.target_exec_job?.exec_job_id;
      const level = raw.mission?.difficulty?.level;
      if (typeof execJobId !== "string" || !(DIFFICULTIES as readonly unknown[]).includes(level)) continue;
      existing.set(execJobId, (existing.get(execJobId) ?? new Set()).add(level as Difficulty));
    }
    res.json({
      job: { jobCode, jobName: ncs.jobName(jobCode) ?? jobCode },
      sentences: sentences.map((sentence) => ({
        ...sentence,
        existingDifficulties: DIFFICULTIES.filter((level) => existing.get(sentence.execJobId)?.has(level))
      }))
    });
  });

  router.get(`${BASE}/material-types`, guard, asyncRoute(async (req, res) => {
    const input = parse(AdminMaterialTypesQuerySchema, req.query);
    res.json(await service.materialTypes(input));
  }));

  router.post(`${BASE}/runs`, guard, asyncRoute(async (req, res) => {
    const input = parse(AdminGenerationStartRequestSchema, req.body);
    res.status(202).json({ run: await service.start(input) });
  }));

  router.get(`${BASE}/runs`, guard, (req, res) => {
    const { limit } = parse(AdminGenerationRunsQuerySchema, req.query);
    res.json({ runs: service.list(limit) });
  });

  router.get(`${BASE}/runs/:runId`, guard, (req, res) => {
    const run = service.get(runIdOf(req));
    if (!run) throw new ApiError(404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
    res.json({ run: hasAdminToken(req) ? run : withoutAnswers(run) });
  });

  router.post(`${BASE}/runs/:runId/review`, guard, asyncRoute(async (req, res) => {
    res.json({ run: await service.rerunReview(runIdOf(req)) });
  }));

  router.post(`${BASE}/runs/:runId/catalog`, guard, asyncRoute(async (req, res) => {
    res.json({ run: await service.addToCatalog(runIdOf(req)) });
  }));

  router.delete(`${BASE}/runs/:runId`, guard, asyncRoute(async (req, res) => {
    const runId = runIdOf(req);
    await service.deleteRun(runId);
    res.json({ ok: true, runId });
  }));

  router.get(`${BASE}/catalog`, guard, (_req, res) => {
    res.json(service.catalog());
  });

  router.delete(`${BASE}/catalog/:missionKey`, guard, asyncRoute(async (req, res) => {
    const result = await service.removeFromCatalog(String(req.params.missionKey));
    res.json({ ok: true, ...result });
  }));

  return router;
}
