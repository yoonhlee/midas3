import express from "express";
import type { Db } from "../../lib/db/database.js";
import { currentSchemaVersion } from "../../lib/db/database.js";
import { getEvalMode, getEvalModel } from "../../lib/evaluator/evaluateAnswer.js";
import type { PostingsService } from "../../lib/postings/service.js";
import type { ServerConfig } from "../config.js";

export function healthRouter(config: ServerConfig, db: Db, postingsService: PostingsService) {
  const router = express.Router();
  router.get("/health", (_req, res) => {
    let dbOk = true;
    let schemaVersion = 0;
    try {
      schemaVersion = currentSchemaVersion(db);
    } catch {
      dbOk = false;
    }
    return res.json({
      ok: dbOk,
      service: "jobsim-llm-evaluator",
      now: new Date().toISOString(),
      uptime_sec: Math.round(process.uptime()),
      app_env: config.appEnv,
      has_openai_key: Boolean(process.env.OPENAI_API_KEY),
      eval_model: getEvalModel(),
      eval_mode: getEvalMode(),
      compatibility_score_gamma: Number.isFinite(config.compatibilityGamma) ? config.compatibilityGamma : 1.5,
      evaluate_rate_limit: {
        window_ms: config.evaluateRateLimit.windowMs,
        max_requests: config.evaluateRateLimit.max
      },
      admin_lock_enabled: Boolean(config.admin.password),
      admin_demo_unlock_enabled: config.admin.demoUnlock,
      database: { ok: dbOk, schema_version: schemaVersion },
      auth: {
        kakao_configured: Boolean(config.auth.kakaoClientId),
        kakao_unlink_configured: Boolean(config.auth.kakaoAdminKey),
        dev_login: config.auth.devLogin
      },
      postings: postingsService.getHealth()
    });
  });
  return router;
}
