import express from "express";
import { z } from "zod";
import type { Db } from "../../lib/db/database.js";
import {
  claimAnonymousAttempts,
  countUserMissions,
  deleteDraft,
  deleteInterest,
  getDraft,
  listAttemptMissions,
  listDrafts,
  listInterests,
  listUserAttempts,
  upsertDraft,
  upsertInterest
} from "../../lib/db/repos.js";
import type { JobsCatalog } from "../../lib/jobs/catalog.js";
import type { ServerConfig } from "../config.js";
import { sendApiError } from "../http.js";
import { getAuth, requireCsrf, requireUser } from "../authContext.js";
import { missionHash, type MissionStore } from "../missionStore.js";

const CodeSchema = z.string().regex(/^K\d{9}$/);
const MemoSchema = z.string().max(100);

export interface MeDeps {
  db: Db;
  config: ServerConfig;
  missionStore: MissionStore;
  jobsCatalog: JobsCatalog;
}

// 내 기록(대시보드), 관심 직무, 쓰던 답안. 모두 로그인이 필요하다.
export function meRouter({ db, missionStore, jobsCatalog }: MeDeps) {
  const router = express.Router();
  router.use("/api/me", requireUser, requireCsrf);

  function jobName(code: string) {
    return jobsCatalog.name(code) ?? missionStore.get()?.jobDefs.find((job) => job.job_code === code)?.job_name ?? code;
  }

  function attemptSummaries(userId: string) {
    return listUserAttempts(db, userId).map((attempt) => {
      const missions = listAttemptMissions(db, attempt.id);
      const rounds = Math.max(1, ...missions.map((m) => m.round));
      const modes = [...new Set(missions.map((m) => m.scoring_mode))];
      const outdated = missions.some((m) => {
        const current = missionStore.findByKey(m.mission_key);
        return !current || missionHash(current) !== m.mission_hash;
      });
      return {
        id: attempt.id,
        status: attempt.status,
        created_at: attempt.created_at,
        completed_at: attempt.completed_at,
        jobs: attempt.job_codes.map((code) => ({ code, name: jobName(code) })),
        missions: missions.filter((m) => m.round === 1).map((m) => ({ key: m.mission_key, title: m.mission_title })),
        mission_count: missions.length,
        rounds,
        scoring_modes: modes,
        mission_outdated: outdated,
        has_result: Boolean(attempt.result_snapshot)
      };
    });
  }

  router.get("/api/me/summary", (_req, res) => {
    const user = getAuth(res).user!;
    const attempts = attemptSummaries(user.id);
    const interests = listInterests(db, user.id);
    const drafts = listDrafts(db, user.id);
    const jobsTried = new Set(attempts.flatMap((a) => a.jobs.map((j) => j.code)));
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      user: { id: user.id, nickname: user.nickname, provider: user.provider, created_at: user.created_at },
      counts: {
        attempts: attempts.filter((a) => a.status === "completed").length,
        jobs_tried: jobsTried.size,
        missions: countUserMissions(db, user.id),
        interests: interests.length
      },
      attempts,
      interests: interests.map((row) => ({
        ...row,
        name: jobName(row.job_code),
        lrcl: jobsCatalog.get(row.job_code)?.lrcl ?? "",
        experienceable: missionStore.experienceableJobCodes().has(row.job_code)
      })),
      drafts: drafts.map((row) => ({
        ...row,
        job_name: jobName(row.job_code),
        mission_title: missionStore.findByKey(row.mission_key)?.title ?? row.mission_key,
        mission_available: Boolean(missionStore.findByKey(row.mission_key))
      }))
    });
  });

  router.get("/api/me/attempts", (_req, res) => {
    return res.json({ attempts: attemptSummaries(getAuth(res).user!.id) });
  });

  router.post("/api/me/claim-anonymous", (_req, res) => {
    const auth = getAuth(res);
    const claimed = auth.anonId ? claimAnonymousAttempts(db, auth.anonId, auth.user!.id) : 0;
    return res.json({ claimed });
  });

  // ── 관심 직무 ───────────────────────────────
  router.get("/api/me/interests", (_req, res) => {
    return res.json({ interests: listInterests(db, getAuth(res).user!.id) });
  });

  router.put("/api/me/interests/:code", (req, res) => {
    const code = CodeSchema.safeParse(req.params.code);
    if (!code.success || !jobsCatalog.has(code.data)) return sendApiError(res, 404, "JOB_NOT_FOUND", "그 직무를 찾을 수 없어.");
    const memoRaw = (req.body ?? {}).memo;
    const memo = memoRaw === undefined ? undefined : MemoSchema.safeParse(String(memoRaw).trim());
    if (memo && !memo.success) return sendApiError(res, 400, "MEMO_TOO_LONG", "메모는 100자까지 쓸 수 있어.");
    const row = upsertInterest(db, getAuth(res).user!.id, code.data, memo?.data);
    return res.json({ interest: row });
  });

  router.delete("/api/me/interests/:code", (req, res) => {
    const removed = deleteInterest(db, getAuth(res).user!.id, req.params.code);
    if (!removed) return sendApiError(res, 404, "INTEREST_NOT_FOUND", "관심 직무에 없어.");
    return res.json({ ok: true });
  });

  // ── 쓰던 답안 이어 하기 ──────────────────────
  router.get("/api/me/drafts/:missionKey", (req, res) => {
    const draft = getDraft(db, getAuth(res).user!.id, req.params.missionKey);
    if (!draft) return sendApiError(res, 404, "DRAFT_NOT_FOUND", "저장된 답안이 없어.");
    return res.json({ draft });
  });

  router.put("/api/me/drafts/:missionKey", (req, res) => {
    const mission = missionStore.findByKey(req.params.missionKey);
    if (!mission) return sendApiError(res, 404, "MISSION_NOT_FOUND", "서버에 없는 미션이야.");
    const answer = String((req.body ?? {}).answer ?? "");
    if (answer.length > 3000) return sendApiError(res, 400, "DRAFT_TOO_LONG", "답안은 3000자까지 저장할 수 있어.");
    const draft = upsertDraft(db, getAuth(res).user!.id, mission.key, mission.job_code, answer);
    return res.json({ draft });
  });

  router.delete("/api/me/drafts/:missionKey", (req, res) => {
    deleteDraft(db, getAuth(res).user!.id, req.params.missionKey);
    return res.json({ ok: true });
  });

  return router;
}
