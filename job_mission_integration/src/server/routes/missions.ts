import express from "express";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  BootstrapResponseSchema,
  CompleteAttemptRequestSchema,
  CreateAttemptRequestSchema,
  EvaluateRequestSchema,
  EvaluateResponseSchema,
  LogEntrySchema,
  RecommendationsRequestSchema,
  RecommendationsResponseSchema,
  UpdateAttemptRequestSchema
} from "../../lib/api/contracts.js";
import type { Db } from "../../lib/db/database.js";
import {
  completeAttempt,
  createAttempt,
  deleteAttempt,
  getAttempt,
  insertAttemptMission,
  isAttemptOwner,
  listAttemptMissions,
  updateAttemptPreAnswers
} from "../../lib/db/repos.js";
import { evaluateAnswer, getEvalMode } from "../../lib/evaluator/evaluateAnswer.js";
import { buildResultSummary, type MissionScoresByJob, type buildJobWeightCatalog } from "../../lib/recommendation/engine.js";
import type { ServerConfig } from "../config.js";
import { asyncRoute, sendApiError } from "../http.js";
import { ensureAnonId, getAuth, ownerOf, requireCsrf } from "../authContext.js";
import { rateLimit } from "../middleware.js";
import { missionExplanation, missionHash, missionToEvaluateInput, type MissionStore } from "../missionStore.js";

const EVALUATION_LOG_PREFIX = "evaluation-logs-";

export interface MissionsDeps {
  config: ServerConfig;
  db: Db;
  missionStore: MissionStore;
  jobWeightCatalog: ReturnType<typeof buildJobWeightCatalog>;
}

function getLocalDateStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// 미션 카탈로그·채점·결과 분석·체험 기록 API
export function missionsRouter({ config, db, missionStore, jobWeightCatalog }: MissionsDeps) {
  const router = express.Router();
  const reportsDir = config.paths.reports;
  let lastLogCleanupAt = 0;

  async function cleanupOldEvaluationLogs(now = Date.now()) {
    if (now - lastLogCleanupAt < 6 * 60 * 60 * 1000) return;
    lastLogCleanupAt = now;
    const cutoff = now - (config.evaluationLogRetentionDays * 24 * 60 * 60 * 1000);
    let names: string[] = [];
    try {
      names = await fsp.readdir(reportsDir);
    } catch {
      return;
    }
    const stale = names.filter((name) => {
      if (!name.startsWith(EVALUATION_LOG_PREFIX) || !name.endsWith(".jsonl")) return false;
      const stamp = name.slice(EVALUATION_LOG_PREFIX.length, -".jsonl".length);
      const parsed = Date.parse(`${stamp}T00:00:00`);
      if (!Number.isFinite(parsed)) return false;
      return parsed < cutoff;
    });
    await Promise.all(stale.map((name) => fsp.rm(path.join(reportsDir, name), { force: true })));
  }

  function ownedAttempt(res: express.Response, attemptId: string) {
    const attempt = getAttempt(db, attemptId);
    if (!attempt || !isAttemptOwner(attempt, ownerOf(res))) return null;
    return attempt;
  }

  router.get("/api/bootstrap", (_req, res) => {
    const payload = missionStore.getPublic();
    if (!payload) {
      return sendApiError(res, 500, "BOOTSTRAP_UNAVAILABLE", "Mission bootstrap payload is not available on this server instance.");
    }
    const validated = BootstrapResponseSchema.safeParse(payload);
    if (!validated.success) {
      return sendApiError(res, 500, "BOOTSTRAP_RESPONSE_SCHEMA_MISMATCH", "Server produced an invalid bootstrap response payload.", validated.error.issues);
    }
    return res.json({ ...validated.data, eval_mode: getEvalMode() });
  });

  router.post("/api/evaluate", rateLimit({
    windowMs: config.evaluateRateLimit.windowMs,
    max: config.evaluateRateLimit.max,
    message: "Too many evaluate requests. Please retry later."
  }), asyncRoute(async (req, res) => {
    const parsed = EvaluateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, "EVALUATE_BAD_REQUEST", "Request body does not match evaluate contract.", parsed.error.issues);
    }
    const input = parsed.data;
    const catalogMission = missionStore.findByKey(input.mission_key) ?? missionStore.findById(input.mission?.mission_id);
    if (!catalogMission && !input.mission) {
      return sendApiError(res, 404, "MISSION_NOT_FOUND", "서버에 없는 미션이야.");
    }
    let attempt = null;
    if (input.attempt_id) {
      attempt = ownedAttempt(res, input.attempt_id);
      if (!attempt) return sendApiError(res, 404, "ATTEMPT_NOT_FOUND", "체험 기록을 찾을 수 없어.");
      if (!catalogMission) return sendApiError(res, 400, "MISSION_NOT_IN_CATALOG", "기록에 저장하려면 서버 카탈로그의 미션이어야 해.");
    }

    const missionInput = catalogMission ? missionToEvaluateInput(catalogMission) : input.mission!;
    const result = await evaluateAnswer({ mission: missionInput, answer: input.answer });
    let attemptMissionId: string | null = null;
    if (attempt && catalogMission) {
      const row = insertAttemptMission(db, {
        attempt_id: attempt.id,
        round: input.round ?? 1,
        job_code: catalogMission.job_code,
        mission_key: catalogMission.key,
        mission_id: catalogMission.mission_id,
        mission_title: catalogMission.title || catalogMission.mission_id,
        mission_hash: missionHash(catalogMission),
        answer: input.answer,
        evaluation: result.evaluation as unknown as Record<string, unknown>,
        mission_score: result.missionScore,
        scoring_mode: String(result.evaluation.source ?? "llm"),
        self_report: input.self_report ?? {}
      });
      attemptMissionId = row.id;
    }
    const payload = {
      ...result,
      scoring: { mode: getEvalMode(), source: String(result.evaluation.source ?? "llm"), server_mission: Boolean(catalogMission) },
      attempt_mission_id: attemptMissionId
    };
    const validated = EvaluateResponseSchema.safeParse(payload);
    if (!validated.success) {
      return sendApiError(res, 500, "EVALUATE_RESPONSE_SCHEMA_MISMATCH", "Server produced an invalid evaluate response payload.", validated.error.issues);
    }
    return res.json(validated.data);
  }));

  router.post("/api/recommendations", (req, res) => {
    const parsed = RecommendationsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, "RECOMMENDATIONS_BAD_REQUEST", "Request body does not match recommendations contract.", parsed.error.issues);
    }
    const missionSignalsByKey: Record<string, Record<string, number>> = {};
    const missionSignalsById: Record<string, Record<string, number>> = {};
    const missionSignalsByJob: Record<string, Array<Record<string, number>>> = {};
    for (const mission of missionStore.get()?.allMissions ?? []) {
      const rawSignals = (mission as { axis_signals?: Record<string, unknown> }).axis_signals ?? {};
      const sanitizedSignals = Object.fromEntries(
        Object.entries(rawSignals).map(([axis, value]) => [axis, Number(value) || 0])
      ) as Record<string, number>;
      if (mission.key) missionSignalsByKey[mission.key] = sanitizedSignals;
      if (mission.mission_id) missionSignalsById[mission.mission_id] = sanitizedSignals;
      if (!missionSignalsByJob[mission.job_code]) missionSignalsByJob[mission.job_code] = [];
      missionSignalsByJob[mission.job_code].push(sanitizedSignals);
    }
    const summary = buildResultSummary({
      selectedJobs: parsed.data.selectedJobs,
      missionScoresByJob: parsed.data.missionScoresByJob as MissionScoresByJob,
      evaluationLogs: parsed.data.evaluationLogs,
      topN: parsed.data.topN,
      catalog: jobWeightCatalog,
      missionSignalsByKey,
      missionSignalsById,
      missionSignalsByJob
    });
    const validated = RecommendationsResponseSchema.safeParse(summary);
    if (!validated.success) {
      return sendApiError(res, 500, "RECOMMENDATIONS_RESPONSE_SCHEMA_MISMATCH", "Server produced an invalid recommendations response payload.", validated.error.issues);
    }
    return res.json(validated.data);
  });

  router.post("/api/logs", asyncRoute(async (req, res) => {
    const parsed = LogEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, "LOGS_BAD_REQUEST", "Request body does not match log entry contract.", parsed.error.issues);
    }
    const now = Date.now();
    await fsp.mkdir(reportsDir, { recursive: true });
    await cleanupOldEvaluationLogs(now);
    const logPath = path.join(reportsDir, `${EVALUATION_LOG_PREFIX}${getLocalDateStamp(new Date(now))}.jsonl`);
    await fsp.appendFile(logPath, `${JSON.stringify(parsed.data)}\n`, "utf8");
    return res.status(201).json({ ok: true });
  }));

  // ── 체험 기록(시도) ─────────────────────────────────────
  // 로그인하지 않았으면 브라우저 식별자에 묶어 임시로 두고, 로그인하면 내 기록으로 옮긴다.
  router.post("/api/attempts", (req, res) => {
    const parsed = CreateAttemptRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendApiError(res, 400, "ATTEMPT_BAD_REQUEST", "job_codes가 올바르지 않아.", parsed.error.issues);
    const auth = getAuth(res);
    const anonId = auth.user ? null : ensureAnonId(res, config);
    const attempt = createAttempt(db, { userId: auth.user?.id ?? null, anonId }, {
      jobCodes: parsed.data.job_codes,
      preAnswers: parsed.data.pre_answers
    });
    return res.status(201).json({ attempt: { id: attempt.id, saved_to_account: Boolean(auth.user), created_at: attempt.created_at } });
  });

  router.patch("/api/attempts/:id", (req, res) => {
    const attempt = ownedAttempt(res, req.params.id);
    if (!attempt) return sendApiError(res, 404, "ATTEMPT_NOT_FOUND", "체험 기록을 찾을 수 없어.");
    const parsed = UpdateAttemptRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendApiError(res, 400, "ATTEMPT_BAD_REQUEST", "pre_answers가 필요해.", parsed.error.issues);
    updateAttemptPreAnswers(db, attempt.id, parsed.data.pre_answers);
    return res.json({ ok: true });
  });

  router.post("/api/attempts/:id/complete", express.json({ limit: "2mb" }), (req, res) => {
    const attempt = ownedAttempt(res, req.params.id);
    if (!attempt) return sendApiError(res, 404, "ATTEMPT_NOT_FOUND", "체험 기록을 찾을 수 없어.");
    const parsed = CompleteAttemptRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendApiError(res, 400, "ATTEMPT_SNAPSHOT_INVALID", "결과 스냅샷 형식이 올바르지 않아.", parsed.error.issues);
    completeAttempt(db, attempt.id, parsed.data.snapshot);
    return res.json({ ok: true, saved_to_account: Boolean(attempt.user_id) });
  });

  router.get("/api/attempts/:id", (req, res) => {
    const attempt = ownedAttempt(res, req.params.id);
    if (!attempt) return sendApiError(res, 404, "ATTEMPT_NOT_FOUND", "체험 기록을 찾을 수 없어.");
    const missions = listAttemptMissions(db, attempt.id).map((row) => {
      const current = missionStore.findByKey(row.mission_key);
      return {
        ...row,
        mission_outdated: !current || missionHash(current) !== row.mission_hash
      };
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ attempt, missions });
  });

  // 해설(U21): 이 체험 기록에서 해당 미션을 제출한 사람에게만 기대 답안과 채점 기준을 보여준다.
  router.get("/api/missions/:key/explanation", (req, res) => {
    const mission = missionStore.findByKey(req.params.key);
    if (!mission) return sendApiError(res, 404, "MISSION_NOT_FOUND", "서버에 없는 미션이야.");
    const attemptId = typeof req.query.attempt_id === "string" ? req.query.attempt_id : "";
    const attempt = attemptId ? ownedAttempt(res, attemptId) : null;
    if (!attempt) return sendApiError(res, 404, "ATTEMPT_NOT_FOUND", "체험 기록을 찾을 수 없어.");
    const submitted = listAttemptMissions(db, attempt.id).some((row) => row.mission_key === mission.key);
    if (!submitted) return sendApiError(res, 403, "EXPLANATION_LOCKED", "해설은 이 미션을 제출한 뒤에 볼 수 있어.");
    res.setHeader("Cache-Control", "no-store");
    return res.json(missionExplanation(mission));
  });

  router.delete("/api/attempts/:id", requireCsrf, (req, res) => {
    const attempt = ownedAttempt(res, req.params.id);
    if (!attempt) return sendApiError(res, 404, "ATTEMPT_NOT_FOUND", "체험 기록을 찾을 수 없어.");
    deleteAttempt(db, attempt.id);
    return res.json({ ok: true });
  });

  return router;
}
