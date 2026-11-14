import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ServerConfig } from "../../server/config.js";
import { createFakeCommands } from "./fakeCommands.js";
import type { NcsCatalog } from "./ncsCatalog.js";

// 관리자 미션 생성이 Python을 부르는 자리. 서버는 이 인터페이스로만 생성기를 부른다.
// 실제 구현(Python 띄우기)과 가짜 구현(fakeCommands.ts, 고정 실행 결과 복사)을 바꿔 끼울 수 있다.

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface TargetInput {
  jobCode: string;
  execJobId: string;
  unitKey: string;
  difficulty: Difficulty;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  code: string | null;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  mode: "live" | "fake";
  model: string | null;
  reasoning_effort: string | null;
  speed: string | null;
  checks: PreflightCheck[];
}

export type TargetPlan = { ok: true; allowedMaterialTypes: string[] | null } | { ok: false; code: string; message: string };

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
  lines: string[]; // 마지막 500줄
}

export interface GenerationCommands {
  preflight(): Promise<PreflightResult>;
  // outFile이 없으면 파일을 쓰지 않는다(--print).
  planTarget(input: TargetInput, options: { narrow: boolean; outFile?: string }): Promise<TargetPlan>;
  generate(targetFile: string, onLine: (line: string) => void): Promise<CommandOutcome>;
  review(runDir: string, onLine: (line: string) => void): Promise<CommandOutcome>;
  exportMission(stagingDir: string, missionsDir: string): Promise<CommandOutcome>;
}

const KEEP_LINES = 500;
const SHORT_TIMEOUT_MS = 30_000; // 시작 전 확인, 대상 파일
const EXPORT_TIMEOUT_MS = 60_000;

// 관리자 화면의 생성은 Claude로 돈다. 셸이나 .env에 다른 제공자가 적혀 있어도 이 자리에서 못박는다.
export function pythonSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    MISSION_LLM_PROVIDER: "anthropic"
  };
}

export function preflightArgs(): string[] {
  return ["-m", "src.mission_generation.preflight"];
}

export function targetArgs(input: TargetInput, options: { narrow: boolean; outFile?: string }, ncsRoot: string): string[] {
  return [
    "-m",
    "src.mission_generation.admin_target",
    "--job",
    input.jobCode,
    "--exec",
    input.execJobId,
    "--unit",
    input.unitKey,
    "--difficulty",
    input.difficulty,
    "--ncs-root",
    ncsRoot,
    ...(options.narrow ? [] : ["--no-narrow"]),
    ...(options.outFile ? ["--out", options.outFile] : ["--print"])
  ];
}

export function generateArgs(targetFile: string, ncsRoot: string): string[] {
  return [
    "-u",
    "-m",
    "src.mission_generation.pilot_runner",
    "--ncs-background",
    "--two-stage-basis",
    "--ncs-targets",
    targetFile,
    "--ncs-root",
    ncsRoot,
    "--concurrency",
    "1"
  ];
}

export function reviewArgs(runDir: string): string[] {
  return ["-u", "-m", "src.mission_generation.mission_reviewer", "--run-dir", runDir];
}

export function exportArgs(stagingDir: string, missionsDir: string): string[] {
  return ["scripts/export_missions.py", "--outputs", stagingDir, "--missions-dir", missionsDir];
}

// 프로세스 출력 덩어리를 줄로 나눈다. 덩어리 경계에서 잘린 줄과 여러 바이트 글자(한글)를 이어 붙인다.
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line) onLine(line);
  };
  return {
    push(chunk: Buffer) {
      pending += decoder.write(chunk);
      let index = pending.indexOf("\n");
      while (index !== -1) {
        emit(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
    },
    flush() {
      pending += decoder.end();
      if (pending) emit(pending);
      pending = "";
    }
  };
}

function runPython(config: ServerConfig, args: string[], timeoutMs: number, onLine: (line: string) => void = () => {}): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    const lines: string[] = [];
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const collect = (line: string) => {
      lines.push(line);
      if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES);
      try {
        onLine(line);
      } catch {
        // 줄을 받는 쪽의 오류가 프로세스 읽기를 멈추게 하지 않는다.
      }
    };
    const finish = (exitCode: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, timedOut, spawnError, lines });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.adminGeneration.pythonBin, args, { cwd: config.paths.root, env: pythonSpawnEnv(), windowsHide: true });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    const stdout = createLineSplitter(collect);
    const stderr = createLineSplitter(collect);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => {
      stdout.flush();
      stderr.flush();
      finish(code, null);
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

function lastJsonObject(lines: string[]): Record<string, unknown> | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (!text.startsWith("{")) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // JSON이 아닌 줄은 넘어간다.
    }
  }
  return null;
}

function failedPreflight(code: string, name: string, message: string): PreflightResult {
  return { ok: false, mode: "live", model: null, reasoning_effort: null, speed: null, checks: [{ name, ok: false, code, message }] };
}

const textOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

export function createPythonCommands(config: ServerConfig): GenerationCommands {
  const ncsRoot = () => toPosix(path.relative(config.paths.root, config.paths.ncsJobs) || ".");
  const tail = (outcome: CommandOutcome) =>
    (outcome.spawnError ?? (outcome.timedOut ? "timed out" : outcome.lines.slice(-5).join("\n"))).slice(0, 500);

  return {
    async preflight() {
      const outcome = await runPython(config, preflightArgs(), SHORT_TIMEOUT_MS);
      if (outcome.spawnError) return failedPreflight("GENERATION_PYTHON_UNAVAILABLE", "python", outcome.spawnError.slice(0, 500));
      const json = lastJsonObject(outcome.lines);
      if (!json) return failedPreflight("GENERATION_PREFLIGHT_UNREADABLE", "python", tail(outcome));
      const checks = Array.isArray(json.checks)
        ? json.checks.map((raw) => {
            const check = (raw ?? {}) as Record<string, unknown>;
            return { name: String(check.name ?? ""), ok: check.ok === true, code: textOrNull(check.code), message: String(check.message ?? "") };
          })
        : [];
      return {
        ok: json.ok === true,
        mode: "live",
        model: textOrNull(json.model),
        reasoning_effort: textOrNull(json.reasoning_effort),
        speed: textOrNull(json.speed),
        checks
      };
    },

    async planTarget(input, options) {
      const outFile = options.outFile ? path.resolve(options.outFile) : undefined;
      const outcome = await runPython(config, targetArgs(input, { narrow: options.narrow, outFile }, ncsRoot()), SHORT_TIMEOUT_MS);
      const json = lastJsonObject(outcome.lines);
      if (!json || outcome.exitCode === 2) return { ok: false, code: "TARGET_COMMAND_FAILED", message: tail(outcome) };
      if (json.ok === false) {
        const error = (json.error ?? {}) as Record<string, unknown>;
        return { ok: false, code: textOrNull(error.code) ?? "TARGET_COMMAND_FAILED", message: String(error.message ?? "") };
      }
      const raw = outFile ? json.allowed_material_types : (json.material_mix as Record<string, unknown> | undefined)?.allowed_material_types;
      return { ok: true, allowedMaterialTypes: Array.isArray(raw) ? raw.map(String) : null };
    },

    generate(targetFile, onLine) {
      return runPython(config, generateArgs(path.resolve(targetFile), ncsRoot()), config.adminGeneration.generateTimeoutMs, onLine);
    },

    review(runDir, onLine) {
      return runPython(config, reviewArgs(path.resolve(runDir)), config.adminGeneration.reviewTimeoutMs, onLine);
    },

    exportMission(stagingDir, missionsDir) {
      return runPython(config, exportArgs(path.resolve(stagingDir), path.resolve(missionsDir)), EXPORT_TIMEOUT_MS);
    }
  };
}

// 설정의 모드에 따라 명령을 고른다: fake면 고정 결과를 복사하는 가짜, 아니면 Python.
export function createCommands(config: ServerConfig, ncs: NcsCatalog): GenerationCommands {
  return config.adminGeneration.mode === "fake" ? createFakeCommands(config, ncs) : createPythonCommands(config);
}
