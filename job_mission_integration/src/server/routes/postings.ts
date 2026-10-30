import express from "express";
import {
  AdminPostingsRefreshRequestSchema,
  JobPostingsParamsSchema,
  JobPostingsResponseSchema
} from "../../lib/api/contracts.js";
import type { PostingsConfig } from "../../lib/postings/config.js";
import type { PostingsService } from "../../lib/postings/service.js";
import { maskSecrets } from "../../lib/postings/work24Client.js";
import type { ServerConfig } from "../config.js";
import { sendApiError } from "../http.js";
import { requireAdmin } from "../middleware.js";

// 채용공고 API. 결과 화면 API는 스냅샷만 읽고 외부 API를 부르지 않는다.
export function postingsRouter(config: ServerConfig, postingsConfig: PostingsConfig, postingsService: PostingsService) {
  const router = express.Router();
  const secrets = [postingsConfig.work24Key, postingsConfig.kakaoKey];
  // 채용공고 관리자 API는 ADMIN_DEMO_UNLOCK과 상관없이 항상 ADMIN_PASSWORD를 요구한다.
  const requireAdminPassword = requireAdmin(config, { allowDemoRead: false });

  router.get("/api/jobs/:jobCode/postings", (req, res) => {
    const params = JobPostingsParamsSchema.safeParse(req.params);
    if (!params.success) {
      return sendApiError(res, 400, "POSTINGS_BAD_REQUEST", "jobCode must match ^K\\d{9}$.", params.error.issues);
    }
    try {
      const validated = JobPostingsResponseSchema.safeParse(postingsService.getJobPostings(params.data.jobCode));
      if (!validated.success) {
        return sendApiError(res, 500, "POSTINGS_RESPONSE_SCHEMA_MISMATCH", "Server produced an invalid postings payload.", validated.error.issues);
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json(validated.data);
    } catch (error) {
      console.error("[postings]", maskSecrets((error as Error)?.message ?? String(error), secrets));
      return sendApiError(res, 500, "POSTINGS_INTERNAL_ERROR", "Failed to read postings snapshot.");
    }
  });

  router.get("/api/admin/postings/status", requireAdminPassword, (_req, res) => {
    try {
      return res.json(postingsService.getAdminStatus());
    } catch (error) {
      return sendApiError(res, 500, "POSTINGS_STATUS_ERROR", maskSecrets((error as Error).message, secrets));
    }
  });

  router.post("/api/admin/postings/refresh", requireAdminPassword, (req, res) => {
    const parsed = AdminPostingsRefreshRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendApiError(res, 400, "POSTINGS_REFRESH_BAD_REQUEST", "jobCode must match ^K\\d{9}$.", parsed.error.issues);
    }
    const alreadyRunning = postingsService.isRefreshing();
    const jobCodes = parsed.data.jobCode ? [parsed.data.jobCode] : undefined;
    void postingsService
      .refresh(jobCodes, (m) => console.log(`[postings] ${m}`))
      .catch((error) => console.error("[postings] refresh failed:", maskSecrets((error as Error).message, secrets)));
    return res.status(202).json({ accepted: true, already_running: alreadyRunning, job_code: parsed.data.jobCode ?? null });
  });

  return router;
}
