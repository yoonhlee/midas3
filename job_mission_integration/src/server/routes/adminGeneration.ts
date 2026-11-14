import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import express from "express";
import OpenAI from "openai";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import { sendApiError } from "../http.js";
import { requireAdmin } from "../middleware.js";
import { MissionStore } from "../missionStore.js";

// 관리자 미션 생성·내보내기 API (/api/admin/mission-generation/*)
const ADMIN_LOG_LIMIT = 500;
const ADMIN_DIFFICULTIES = ["easy", "normal", "hard"] as const;

type GenerationStatus = "running" | "succeeded" | "failed" | "exported";

type MissionPreview = {
  mission_id: string;
  title: string;
  job_name: string;
  difficulty: string;
  estimated_time_minutes: number | null;
  scenario_summary: string;
  tasks: string[];
  materials: Array<{
    material_id: string;
    type: string;
    subtype: string;
    title: string;
    description: string;
    used_for: string;
    data: unknown;
    confidence: unknown;
  }>;
  materials_count: number;
  mission_output_path: string;
  reliability_score: number | null;
  warning_count: number;
  fail_count: number;
};

type ExportResult = {
  status: "succeeded" | "failed";
  finished_at: string;
  output: string;
  validation?: ReturnType<MissionStore["validateAndRefresh"]>;
};

type GenerationRun = {
  runId: string;
  status: GenerationStatus;
  jobCode: string;
  difficulty: typeof ADMIN_DIFFICULTIES[number];
  createdAt: string;
  updatedAt: string;
  logs: Array<{ at: string; stream: "system" | "stdout" | "stderr"; message: string }>;
  process?: ChildProcessWithoutNullStreams;
  runDir?: string;
  summary?: unknown;
  missionPreview?: MissionPreview | null;
  exitCode?: number | null;
  error?: string;
  exportResult?: ExportResult;
};

type OpenAiAdminStatus = {
  configured: boolean;
  eval_model: string;
  generation_model: string;
  generation_api_key_env: "OPENAI_API_KEY";
};

const GenerationRunRequestSchema = z.object({
  jobCode: z.string().regex(/^K\d+$/),
  difficulty: z.enum(ADMIN_DIFFICULTIES)
});

export function adminGenerationRouter(config: ServerConfig, missionStore: MissionStore) {
  const router = express.Router();
  const __dirname = config.paths.root;
  const OUTPUTS_DIR = config.paths.outputs;
  const API_RAW_DIR = config.paths.apiRaw;
  const ADDITIONAL_SEARCH_DIR = config.paths.additionalSearch;
  const OPENAI_EVAL_MODEL = config.openai.evalModel;
  const OPENAI_GENERATION_MODEL = config.openai.generationModel;
  const OPENAI_PREFLIGHT_TIMEOUT_MS = config.openai.preflightTimeoutMs;
  const ADMIN_PASSWORD = config.admin.password;
  const ADMIN_DEMO_UNLOCK = config.admin.demoUnlock;
  const generationRuns = new Map<string, GenerationRun>();
  let activeGenerationRunId: string | null = null;
  let generationStartupInProgress = false;
  const requireApiToken = requireAdmin(config, { allowDemoRead: true });
  const validateAndRefreshMissionBootstrap = () => missionStore.validateAndRefresh();

function getPythonBin() {
  if (process.env.PYTHON_BIN?.trim()) return process.env.PYTHON_BIN.trim();
  return os.platform() === "win32" ? "python" : "python3";
}

function decodeKnownXml(buffer: Buffer) {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("euc-kr").decode(buffer);
  } catch {
    return utf8;
  }
}

function extractXmlTag(text: string, tag: string) {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

function loadAdminJobs() {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(API_RAW_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && /^K\d+$/.test(entry.name))
    .map((entry) => {
      const jobCode = entry.name;
      const detailPath = path.join(API_RAW_DIR, jobCode, "dtlGb_2.xml");
      const practicePath = path.join(ADDITIONAL_SEARCH_DIR, `${jobCode}.md`);
      let jobName = jobCode;
      let jobField = "";
      let summary = "";
      if (fs.existsSync(detailPath)) {
        const text = decodeKnownXml(fs.readFileSync(detailPath));
        jobName = extractXmlTag(text, "jobSmclNm") || jobCode;
        jobField = extractXmlTag(text, "jobMdclNm");
        summary = extractXmlTag(text, "jobSum");
      }
      return {
        jobCode,
        jobName,
        jobField,
        summary,
        enabled: fs.existsSync(practicePath),
        hasPracticeSheet: fs.existsSync(practicePath),
        rawPath: path.relative(__dirname, path.join(API_RAW_DIR, jobCode)).replace(/\\/g, "/"),
        practiceSheetPath: fs.existsSync(practicePath)
          ? path.relative(__dirname, practicePath).replace(/\\/g, "/")
          : null
      };
    })
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.jobCode.localeCompare(b.jobCode);
    });
}

function addRunLog(run: GenerationRun, stream: "system" | "stdout" | "stderr", message: string) {
  const lines = message.replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    run.logs.push({ at: new Date().toISOString(), stream, message: line });
  }
  if (run.logs.length > ADMIN_LOG_LIMIT) {
    run.logs.splice(0, run.logs.length - ADMIN_LOG_LIMIT);
  }
  run.updatedAt = new Date().toISOString();
}

function serializeRun(run: GenerationRun) {
  const { process: _process, ...serializable } = run;
  return serializable;
}

function resolveInside(base: string, candidate: string) {
  const resolved = path.resolve(base, candidate);
  const normalizedBase = path.resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Path escapes base directory: ${candidate}`);
  }
  return resolved;
}

function findLatestRunDir(startedAtMs: number) {
  const runsRoot = path.join(OUTPUTS_DIR, "pilot/v1/runs");
  if (!fs.existsSync(runsRoot)) return null;
  const candidates = fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(runsRoot, entry.name);
      const stat = fs.statSync(dir);
      return { dir, mtimeMs: stat.mtimeMs };
    })
    .filter((item) => item.mtimeMs >= startedAtMs - 5_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.dir ?? null;
}

function loadJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function openAiAdminStatus(): OpenAiAdminStatus {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    eval_model: OPENAI_EVAL_MODEL,
    generation_model: OPENAI_GENERATION_MODEL,
    generation_api_key_env: "OPENAI_API_KEY"
  };
}

type OpenAiGenerationPreflightFailure = {
  httpStatus: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
};

type OpenAiGenerationPreflightResult =
  | { ok: true }
  | ({ ok: false } & OpenAiGenerationPreflightFailure);

function mapOpenAiPreflightError(error: unknown): OpenAiGenerationPreflightFailure {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    param?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const upstreamStatus = typeof candidate.status === "number" ? candidate.status : undefined;
  const upstreamCode = typeof candidate.code === "string" ? candidate.code : undefined;
  const upstreamType = typeof candidate.type === "string" ? candidate.type : undefined;
  const upstreamParam = typeof candidate.param === "string" ? candidate.param : undefined;
  const message = typeof candidate.message === "string" && candidate.message
    ? candidate.message
    : "OpenAI preflight request failed.";

  let code = "OPENAI_PREFLIGHT_FAILED";
  if (upstreamStatus === 401 || upstreamStatus === 403) code = "OPENAI_AUTH_FAILED";
  else if (upstreamStatus === 429) code = "OPENAI_RATE_LIMITED";
  else if (upstreamStatus !== undefined && upstreamStatus >= 500) code = "OPENAI_SERVER_ERROR";
  else if (upstreamStatus === 400 || upstreamStatus === 404) code = "OPENAI_BAD_REQUEST";
  else if (!upstreamStatus) code = "OPENAI_NETWORK_OR_TIMEOUT";

  return {
    httpStatus: 503,
    code,
    message: `OpenAI generation preflight failed: ${message}`,
    details: {
      model: OPENAI_GENERATION_MODEL,
      upstream_status: upstreamStatus ?? null,
      upstream_code: upstreamCode ?? null,
      upstream_type: upstreamType ?? null,
      upstream_param: upstreamParam ?? null
    }
  };
}

async function checkOpenAiGenerationPreflight(): Promise<OpenAiGenerationPreflightResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      httpStatus: 503,
      code: "OPENAI_API_KEY_MISSING",
      message: "OPENAI_API_KEY is not set. Mission generation was not started.",
      details: {
        model: OPENAI_GENERATION_MODEL,
        key_env: "OPENAI_API_KEY"
      }
    };
  }

  try {
    const client = new OpenAI({
      apiKey,
      timeout: OPENAI_PREFLIGHT_TIMEOUT_MS,
      maxRetries: 0
    });
    await client.responses.create({
      model: OPENAI_GENERATION_MODEL,
      input: "Reply with OK.",
      max_output_tokens: 16
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, ...mapOpenAiPreflightError(error) };
  }
}

function buildMissionPreview(runDir: string): MissionPreview | null {
  const summaryPath = path.join(runDir, "pilot_summary.json");
  const artifactIndexPath = path.join(runDir, "artifact_index.json");
  if (!fs.existsSync(summaryPath) || !fs.existsSync(artifactIndexPath)) return null;

  const artifactIndex = loadJsonFile<{ items?: Array<{ status?: string; mission_output_path?: string | null }> }>(artifactIndexPath);
  const missionRelPath = artifactIndex.items?.find((item) => item.status === "saved" && item.mission_output_path)?.mission_output_path;
  if (!missionRelPath) return null;
  const missionPath = resolveInside(runDir, missionRelPath);
  const mission = loadJsonFile<Record<string, any>>(missionPath);
  const missionBlock = mission.mission ?? {};
  const difficulty = missionBlock.difficulty ?? {};
  const scenario = missionBlock.scenario ?? {};
  const tasks = Array.isArray(missionBlock.tasks) ? missionBlock.tasks : [];
  const materials = Array.isArray(missionBlock.materials) ? missionBlock.materials : [];
  const reliability = mission.reliability ?? {};

  return {
    mission_id: String(mission.mission_id ?? ""),
    title: String(missionBlock.title ?? ""),
    job_name: String(mission.job_identity?.job_smcl_nm ?? ""),
    difficulty: String(difficulty.level ?? ""),
    estimated_time_minutes: Number.isFinite(Number(difficulty.estimated_time_minutes))
      ? Number(difficulty.estimated_time_minutes)
      : null,
    scenario_summary: [
      scenario.context,
      scenario.goal ? `목표: ${scenario.goal}` : "",
      mission.mission_facts?.main_issue ? `핵심 이슈: ${mission.mission_facts.main_issue}` : ""
    ].filter(Boolean).join("\n"),
    tasks: tasks.map((task: { instruction?: unknown }) => String(task?.instruction ?? "")).filter(Boolean),
    materials: materials.map((material: Record<string, unknown>) => ({
      material_id: String(material.material_id ?? ""),
      type: String(material.type ?? ""),
      subtype: String(material.subtype ?? ""),
      title: String(material.title ?? ""),
      description: String(material.description ?? ""),
      used_for: String(material.used_for ?? ""),
      data: material.data ?? {},
      confidence: material.confidence ?? null
    })),
    materials_count: materials.length,
    mission_output_path: path.relative(__dirname, missionPath).replace(/\\/g, "/"),
    reliability_score: Number.isFinite(Number(reliability.score)) ? Number(reliability.score) : null,
    warning_count: Number(reliability.warning_count ?? 0),
    fail_count: Number(reliability.fail_count ?? 0)
  };
}

function completeGenerationRun(run: GenerationRun, exitCode: number | null, startedAtMs: number) {
  run.exitCode = exitCode;
  run.process = undefined;
  activeGenerationRunId = null;

  if (exitCode !== 0) {
    run.status = "failed";
    run.error = `Generation process exited with code ${exitCode ?? "unknown"}.`;
    addRunLog(run, "system", run.error);
    return;
  }

  const runDir = findLatestRunDir(startedAtMs);
  if (!runDir) {
    run.status = "failed";
    run.error = "Generation finished, but no output run directory was found.";
    addRunLog(run, "system", run.error);
    return;
  }

  run.runDir = path.relative(__dirname, runDir).replace(/\\/g, "/");
  const summaryPath = path.join(runDir, "pilot_summary.json");
  try {
    run.summary = fs.existsSync(summaryPath) ? loadJsonFile(summaryPath) : null;
    run.missionPreview = buildMissionPreview(runDir);
    const savedCount = Number((run.summary as { saved_count?: unknown } | null)?.saved_count ?? 0);
    run.status = savedCount > 0 && run.missionPreview ? "succeeded" : "failed";
    if (run.status === "failed") {
      run.error = "Generation completed, but no saved mission output was found.";
    }
    addRunLog(run, "system", `Generation ${run.status}. runDir=${run.runDir}`);
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    addRunLog(run, "system", run.error);
  }
}

function runCommandCapture(command: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, output: string) => {
      if (settled) return;
      settled = true;
      resolve({ code, output });
    };
    const child = spawn(command, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(1, output);
    });
    child.on("close", (code) => {
      finish(code, output);
    });
  });
}

router.get("/api/admin/mission-generation/jobs", requireApiToken, (_req, res) => {
  const jobs = loadAdminJobs();
  return res.json({
    jobs,
    total: jobs.length,
    enabled_count: jobs.filter((job) => job.enabled).length,
    admin_lock_enabled: !ADMIN_DEMO_UNLOCK && Boolean(ADMIN_PASSWORD),
    admin_demo_unlock_enabled: ADMIN_DEMO_UNLOCK,
    openai: openAiAdminStatus()
  });
});

router.post("/api/admin/mission-generation/runs", requireApiToken, async (req, res) => {
  const parsed = GenerationRunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(
      res,
      400,
      "GENERATION_BAD_REQUEST",
      "Request body does not match generation run contract.",
      parsed.error.issues
    );
  }

  const activeRun = activeGenerationRunId ? generationRuns.get(activeGenerationRunId) : null;
  if (generationStartupInProgress || activeRun?.status === "running") {
    return sendApiError(
      res,
      409,
      "GENERATION_ALREADY_RUNNING",
      "Another mission generation run is already in progress.",
      activeRun ? { run_id: activeRun.runId } : { phase: "preflight" }
    );
  }

  const jobs = loadAdminJobs();
  const selectedJob = jobs.find((job) => job.jobCode === parsed.data.jobCode);
  if (!selectedJob) {
    return sendApiError(res, 404, "GENERATION_JOB_NOT_FOUND", "Job code was not found under data/api_raw.");
  }
  if (!selectedJob.enabled) {
    return sendApiError(
      res,
      400,
      "GENERATION_JOB_DISABLED",
      "This job cannot be generated until data/additional_search contains a matching Markdown file.",
      { job_code: selectedJob.jobCode }
    );
  }

  generationStartupInProgress = true;
  const preflight = await checkOpenAiGenerationPreflight();
  if (!preflight.ok) {
    generationStartupInProgress = false;
    return sendApiError(
      res,
      preflight.httpStatus,
      preflight.code,
      preflight.message,
      preflight.details
    );
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  const run: GenerationRun = {
    runId,
    status: "running",
    jobCode: selectedJob.jobCode,
    difficulty: parsed.data.difficulty,
    createdAt: now,
    updatedAt: now,
    logs: [],
    missionPreview: null
  };
  generationRuns.set(runId, run);
  activeGenerationRunId = runId;

  const pythonBin = getPythonBin();
  const args = [
    "-u",
    "-m",
    "src.mission_generation.pilot_runner",
    "--jobs",
    selectedJob.jobCode,
    "--difficulties",
    parsed.data.difficulty,
    "--concurrency",
    "1"
  ];
  const startedAtMs = Date.now();
  addRunLog(run, "system", `Starting ${pythonBin} ${args.join(" ")}`);

  try {
    const child = spawn(pythonBin, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    run.process = child;
    child.stdout.on("data", (data) => addRunLog(run, "stdout", String(data)));
    child.stderr.on("data", (data) => addRunLog(run, "stderr", String(data)));
    child.on("error", (error) => {
      run.process = undefined;
      run.status = "failed";
      run.error = error.message;
      activeGenerationRunId = null;
      addRunLog(run, "system", error.message);
    });
    child.on("close", (code) => {
      completeGenerationRun(run, code, startedAtMs);
    });
  } catch (error) {
    run.process = undefined;
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    activeGenerationRunId = null;
    addRunLog(run, "system", run.error);
  } finally {
    generationStartupInProgress = false;
  }

  return res.status(202).json({ run: serializeRun(run) });
});

router.get("/api/admin/mission-generation/runs/:runId", requireApiToken, (req, res) => {
  const run = generationRuns.get(req.params.runId);
  if (!run) {
    return sendApiError(res, 404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
  }
  return res.json({ run: serializeRun(run) });
});

router.delete("/api/admin/mission-generation/runs/:runId", requireApiToken, async (req, res) => {
  const run = generationRuns.get(req.params.runId);
  if (!run) {
    return sendApiError(res, 404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
  }
  if (run.status === "running") {
    return sendApiError(res, 409, "GENERATION_STILL_RUNNING", "Cannot delete while generation is still running.");
  }
  if (run.status === "exported") {
    return sendApiError(
      res,
      409,
      "GENERATION_ALREADY_EXPORTED",
      "This run has already been exported. Delete from the mission catalog separately."
    );
  }

  try {
    if (run.runDir) {
      const runDir = resolveInside(__dirname, run.runDir);
      await fsp.rm(runDir, { recursive: true, force: true });
    }
    if (activeGenerationRunId === run.runId) activeGenerationRunId = null;
    generationRuns.delete(run.runId);
    return res.json({ ok: true, run_id: run.runId });
  } catch (error) {
    return sendApiError(
      res,
      500,
      "GENERATION_DELETE_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }
});

router.post("/api/admin/mission-generation/runs/:runId/export", requireApiToken, async (req, res) => {
  const run = generationRuns.get(req.params.runId);
  if (!run) {
    return sendApiError(res, 404, "GENERATION_RUN_NOT_FOUND", "Mission generation run was not found.");
  }
  if (run.status === "running") {
    return sendApiError(res, 409, "GENERATION_STILL_RUNNING", "Cannot export while generation is still running.");
  }
  if (!run.runDir) {
    return sendApiError(res, 400, "GENERATION_RUN_HAS_NO_OUTPUT", "Run does not have an output directory to export.");
  }
  if (run.status === "exported" && run.exportResult) {
    return res.json({ run: serializeRun(run) });
  }

  try {
    const runDir = resolveInside(__dirname, run.runDir);
    addRunLog(run, "system", `Export approval started for ${run.runDir}`);
    const command = getPythonBin();
    const result = await runCommandCapture(command, ["scripts/export_missions.py", "--outputs", runDir]);
    addRunLog(run, result.code === 0 ? "stdout" : "stderr", result.output);

    if (result.code !== 0) {
      run.exportResult = {
        status: "failed",
        finished_at: new Date().toISOString(),
        output: result.output
      };
      return sendApiError(
        res,
        500,
        "MISSION_EXPORT_FAILED",
        "export_missions.py failed.",
        run.exportResult
      );
    }

    const validation = validateAndRefreshMissionBootstrap();
    run.exportResult = {
      status: validation.ok ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
      output: result.output,
      validation
    };

    if (!validation.ok) {
      addRunLog(run, "system", `Export validation failed. issues=${validation.issues.length}`);
      return sendApiError(
        res,
        500,
        "MISSION_EXPORT_VALIDATION_FAILED",
        "Export finished, but mission catalog validation failed.",
        validation
      );
    }

    run.status = "exported";
    addRunLog(run, "system", `Export approved. missions=${validation.missions} jobs=${validation.jobs}`);
    return res.json({ run: serializeRun(run) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.exportResult = {
      status: "failed",
      finished_at: new Date().toISOString(),
      output: message
    };
    addRunLog(run, "system", `Export failed. ${message}`);
    return sendApiError(res, 500, "MISSION_EXPORT_FAILED", message, run.exportResult);
  }
});

  return router;
}
