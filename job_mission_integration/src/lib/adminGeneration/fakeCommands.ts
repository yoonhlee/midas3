import fs from "node:fs";
import path from "node:path";
import type { ServerConfig } from "../../server/config.js";
import { createPythonCommands, type CommandOutcome, type GenerationCommands } from "./commands.js";
import type { NcsCatalog } from "./ncsCatalog.js";
import { RUNS_SUBDIR } from "./runFiles.js";

// 외부 API 없이 도는 가짜 생성(ADMIN_GENERATION_MODE=fake). 생성과 검수를 하지 않고
// 저장소에 든 고정 실행 결과(tests/fixtures/admin_generation/run_sample)를 고른 직업과 난이도에 맞춰 복사한다.
// 진행 메시지는 실제 생성기와 같은 줄을 같은 순서로 낸다. 카탈로그 추가(내보내기)는 실제 스크립트를 그대로 쓴다.

const DIFFICULTY_LABELS: Record<string, string> = { easy: "쉬움", normal: "보통", hard: "어려움" };
const FAKE_MATERIAL_TYPES = ["table", "memo"];

export interface SampleSelection {
  jobCode: string;
  jobName: string;
  difficulty: string;
  execJobId: string;
  execJobText: string;
  runFolder: string;
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
}

function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const missionIdFor = (jobCode: string, difficulty: string) => `mission_${jobCode}_${difficulty}_001`;

// 고정 실행 결과를 실제 실행 폴더 모양으로 놓되, 고른 직업 · 난이도 · 문장에 맞춰 고친다.
export function writeSampleRun(sampleDir: string, runDir: string, selection: SampleSelection) {
  const { jobCode, jobName, difficulty, execJobId, execJobText, runFolder } = selection;
  const missionId = missionIdFor(jobCode, difficulty);
  const relative = `jobs/${jobCode}/${difficulty}/mission_output.json`;

  const mission = readJson(path.join(sampleDir, "mission_output.json"));
  mission.mission_id = missionId;
  mission.job_identity = { ...(mission.job_identity ?? {}), job_cd: jobCode, job_smcl_nm: jobName };
  mission.mission = mission.mission ?? {};
  mission.mission.difficulty = { ...(mission.mission.difficulty ?? {}), level: difficulty, label: DIFFICULTY_LABELS[difficulty] ?? difficulty };
  mission.target_exec_job = { ...(mission.target_exec_job ?? {}), exec_job_id: execJobId, text: execJobText };
  writeJson(path.join(runDir, relative), mission);

  const basis = readJson(path.join(sampleDir, "generation_basis.json"));
  Object.assign(basis, { mission_id: missionId, job_cd: jobCode, difficulty });
  writeJson(path.join(runDir, "jobs", jobCode, difficulty, "generation_basis.json"), basis);

  const summary = readJson(path.join(sampleDir, "pilot_summary.json"));
  const first = (Array.isArray(summary.results) ? summary.results[0] : null) ?? {};
  summary.run_id = runFolder;
  summary.results = [
    { ...first, job_cd: jobCode, job_name: jobName, difficulty_code: difficulty, status: "saved", mission_id: missionId, mission_output_path: relative }
  ];
  writeJson(path.join(runDir, "pilot_summary.json"), summary);
}

// 검수 기록을 실행 폴더의 review/<직업코드>_<난이도>.json으로 놓는다.
export function writeSampleReview(sampleDir: string, runDir: string, selection: Pick<SampleSelection, "jobCode" | "jobName" | "difficulty">, title: string | null) {
  const record = readJson(path.join(sampleDir, "review_record.json"));
  Object.assign(record, {
    mission_id: missionIdFor(selection.jobCode, selection.difficulty),
    job_cd: selection.jobCode,
    job_name: selection.jobName,
    difficulty: selection.difficulty,
    ...(title ? { title } : {})
  });
  writeJson(path.join(runDir, "review", `${selection.jobCode}_${selection.difficulty}.json`), record);
}

const pad = (value: number) => String(value).padStart(2, "0");
const clock = () => {
  const now = new Date();
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
};
const wait = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export function createFakeCommands(config: ServerConfig, ncs: NcsCatalog, options: { stepDelayMs?: number; sampleDir?: string } = {}): GenerationCommands {
  const stepDelayMs = options.stepDelayMs ?? 150;
  const sampleDir = options.sampleDir ?? path.join(config.paths.root, "tests/fixtures/admin_generation/run_sample");
  let sequence = 0;

  const outcome = (exitCode: number, lines: string[]): CommandOutcome => ({ exitCode, timedOut: false, spawnError: null, lines });

  return {
    async preflight() {
      return { ok: true, mode: "fake", model: "fake", reasoning_effort: null, speed: null, checks: [{ name: "fake", ok: true, code: null, message: "" }] };
    },

    async planTarget(input, planOptions) {
      const link = ncs.findSelectable(input.jobCode, input.execJobId, input.unitKey);
      if ("error" in link) return { ok: false, code: `TARGET_${link.error}`, message: link.error };
      const allowed = planOptions.narrow ? [...FAKE_MATERIAL_TYPES] : null;
      if (planOptions.outFile) {
        writeJson(planOptions.outFile, {
          schema_version: "admin_single_target.v1",
          targets: [
            {
              job_cd: link.jobCode,
              job_name: link.jobName,
              exec_job_id: link.execJobId,
              exec_job_text: link.execJobText,
              unit_key: link.unitKey,
              unit_name: link.unitName,
              difficulty: input.difficulty,
              ...(allowed ? { material_mix: { allowed_material_types: allowed } } : {})
            }
          ]
        });
      }
      return { ok: true, allowedMaterialTypes: allowed };
    },

    async generate(targetFile, onLine) {
      const lines: string[] = [];
      const say = (line: string) => {
        lines.push(line);
        onLine(line);
      };
      let target: Record<string, any>;
      try {
        target = readJson(targetFile).targets[0];
      } catch {
        say("target file could not be read");
        return outcome(1, lines);
      }
      const runsRoot = path.join(config.paths.outputs, RUNS_SUBDIR);
      let runFolder = "";
      do {
        sequence += 1;
        runFolder = `admin_fake_${Date.now()}${String(sequence).padStart(3, "0")}`;
      } while (fs.existsSync(path.join(runsRoot, runFolder)));
      const prefix = `[1/1] ${target.job_cd} ${target.difficulty} - `;

      say(`${clock()} run started - run_id=${runFolder} targets=1 concurrency=1`);
      for (const step of ["blueprint LLM started (attempt 0)", "blueprint check 0 (pass)", "draft LLM started", "draft LLM finished (completed)", "validator attempt 0 (pass)"]) {
        await wait(stepDelayMs);
        say(`${clock()} ${prefix}${step}`);
      }
      writeSampleRun(sampleDir, path.join(runsRoot, runFolder), {
        jobCode: String(target.job_cd),
        jobName: String(target.job_name ?? target.job_cd),
        difficulty: String(target.difficulty),
        execJobId: String(target.exec_job_id),
        execJobText: String(target.exec_job_text ?? ""),
        runFolder
      });
      await wait(stepDelayMs);
      say(`${clock()} ${prefix}saved`);
      say(`${clock()} run finished - saved=1 failed=0 repair_used=0`);
      return outcome(0, lines);
    },

    async review(runDir, onLine) {
      const summary = readJson(path.join(runDir, "pilot_summary.json"));
      const result = summary.results?.[0] ?? {};
      const missionPath = path.join(runDir, String(result.mission_output_path ?? ""));
      const title = fs.existsSync(missionPath) ? (readJson(missionPath).mission?.title ?? null) : null;
      await wait(stepDelayMs);
      writeSampleReview(sampleDir, runDir, { jobCode: String(result.job_cd), jobName: String(result.job_name ?? result.job_cd), difficulty: String(result.difficulty_code) }, title);
      const line = "미션 1개: 통과 1";
      onLine(line);
      return outcome(0, [line]);
    },

    exportMission(stagingDir, missionsDir) {
      // 표준 라이브러리만 쓰는 스크립트라 키도 패키지도 필요 없다. 가짜로 하지 않는다.
      return createPythonCommands(config).exportMission(stagingDir, missionsDir);
    }
  };
}
