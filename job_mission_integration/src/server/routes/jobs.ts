import express from "express";
import { z } from "zod";
import { jobsByAxisStrength, type JobsCatalog } from "../../lib/jobs/catalog.js";
import type { PostingsService } from "../../lib/postings/service.js";
import type { buildJobWeightCatalog } from "../../lib/recommendation/engine.js";
import { sendApiError } from "../http.js";
import type { MissionStore } from "../missionStore.js";

const CodeSchema = z.string().regex(/^K\d{9}$/);

export interface JobsDeps {
  jobsCatalog: JobsCatalog;
  missionStore: MissionStore;
  jobWeightCatalog: ReturnType<typeof buildJobWeightCatalog>;
  postingsService: PostingsService;
}

// 직무 탐색·상세·비교 API. 탐색 필터링은 브라우저가 목록을 받아 바로 한다.
export function jobsRouter({ jobsCatalog, missionStore, postingsService }: JobsDeps) {
  const router = express.Router();

  function experienceable() {
    return missionStore.experienceableJobCodes();
  }

  function postingsStatus(code: string) {
    try {
      return postingsService.getJobPostings(code).status;
    } catch {
      return "error";
    }
  }

  router.get("/api/jobs", (_req, res) => {
    const exp = experienceable();
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.json({
      meta: jobsCatalog.meta,
      total: jobsCatalog.index.length,
      fields: [...new Set(jobsCatalog.index.map((job) => job.lrcl))].sort(),
      experienceable: [...exp],
      jobs: jobsCatalog.index.map((job) => ({ ...job, experienceable: exp.has(job.code) }))
    });
  });

  router.get("/api/jobs/by-axis/:axis", (req, res) => {
    const exp = experienceable();
    const jobs = jobsByAxisStrength(jobsCatalog, req.params.axis, 12).map((job) => ({
      ...job,
      experienceable: exp.has(job.code),
      postings_status: postingsStatus(job.code)
    }));
    if (!jobs.length) return sendApiError(res, 400, "AXIS_INVALID", "axis는 AX1~AX5 중 하나여야 해.");
    return res.json({ axis: req.params.axis, jobs });
  });

  router.get("/api/jobs/compare", (req, res) => {
    const codes = String(req.query.codes ?? "").split(",").map((code) => code.trim()).filter(Boolean);
    if (!codes.length || codes.length > 3 || !codes.every((code) => CodeSchema.safeParse(code).success)) {
      return sendApiError(res, 400, "COMPARE_BAD_REQUEST", "codes는 직업코드 1~3개를 쉼표로 이어서 보내줘.");
    }
    const exp = experienceable();
    const jobs = codes.map((code) => jobsCatalog.get(code)).filter(Boolean).map((job) => ({ ...job!, experienceable: exp.has(job!.code) }));
    return res.json({ meta: jobsCatalog.meta, descriptions: jobsCatalog.descriptions, jobs });
  });

  // 공고 요구역량(U25): 최근 공고 문장을 5개 역량으로 나눠 센 비중
  router.get("/api/jobs/:code/postings/requirements", (req, res) => {
    const parsed = CodeSchema.safeParse(req.params.code);
    if (!parsed.success) return sendApiError(res, 400, "JOB_CODE_INVALID", "직업코드는 K와 숫자 9자리야.");
    let result;
    try {
      result = postingsService.getRequirements(parsed.data);
    } catch {
      return res.json({ status: "error", job_code: parsed.data, analyzed_postings: 0 });
    }
    const summary = result.summary;
    return res.json({
      status: result.status,
      job_code: result.job_code,
      job_name: result.job_name,
      fetched_at: result.fetched_at,
      source: result.source,
      method: result.method,
      generated_from: summary?.generated_from ?? null,
      analyzed_postings: summary?.analyzed_postings ?? 0,
      detail_postings: summary?.detail_postings ?? 0,
      analyzed_sentences: summary?.analyzed_sentences ?? 0,
      matched_sentences: summary?.matched_sentences ?? 0,
      axes: summary?.axes ?? null
    });
  });

  router.get("/api/jobs/:code", (req, res) => {
    const parsed = CodeSchema.safeParse(req.params.code);
    if (!parsed.success) return sendApiError(res, 400, "JOB_CODE_INVALID", "직업코드는 K와 숫자 9자리야.");
    const job = jobsCatalog.get(parsed.data);
    if (!job) return sendApiError(res, 404, "JOB_NOT_FOUND", "그 직무를 찾을 수 없어.");
    const exp = experienceable();
    const missions = (missionStore.get()?.allMissions ?? [])
      .filter((mission) => mission.job_code === job.code)
      .map((mission) => ({ key: mission.key, title: mission.title }));
    return res.json({
      meta: jobsCatalog.meta,
      descriptions: jobsCatalog.descriptions,
      job: {
        ...job,
        experienceable: exp.has(job.code),
        missions,
        similar: job.similar.map((item) => ({ ...item, experienceable: exp.has(item.code) })),
        postings_status: postingsStatus(job.code)
      }
    });
  });

  return router;
}
