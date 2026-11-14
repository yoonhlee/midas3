import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandOutcome, GenerationCommands } from "../../../src/lib/adminGeneration/commands.js";
import { createFakeCommands, writeSampleRun, writeSampleReview } from "../../../src/lib/adminGeneration/fakeCommands.js";
import { AdminGenerationService } from "../../../src/lib/adminGeneration/service.js";
import { openDatabase } from "../../../src/lib/db/database.js";
import { MissionStore } from "../../../src/server/missionStore.js";
import { NcsCatalog } from "../../../src/lib/adminGeneration/ncsCatalog.js";
import type { GenerationRunRow } from "../../../src/lib/db/repos.js";
import { loadServerConfig, ROOT_DIR, type ServerConfig } from "../../../src/server/config.js";

// 관리자 미션 생성 테스트의 도우미. 임시 폴더와 시험용 명령을 만든다(외부 API를 부르지 않는다).

export type NewRunRow = Omit<GenerationRunRow, "created_at" | "updated_at" | "finished_at">;

// 생성 기록 한 줄(고정 직업 K900000001 · exec_001 · 90000001:01 · 보통).
export function sampleRunRow(overrides: Partial<NewRunRow> = {}): NewRunRow {
  return {
    id: randomUUID(),
    status: "running",
    stage: "queued",
    job_code: "K900000001",
    job_name: "시범 직업 가",
    exec_job_id: "exec_001",
    exec_job_text: "문장 하나",
    unit_key: "90000001:01",
    unit_name: "시범 능력단위 하나",
    link_kind: "직접",
    difficulty: "normal",
    review_requested: 1,
    allowed_material_types: null,
    run_folder: null,
    mission_id: null,
    mission_title: null,
    review_verdict: null,
    rewrites: '{"blueprint":0,"mission":0}',
    catalog_key: null,
    error_code: null,
    error_message: null,
    ...overrides
  };
}

export const SAMPLE_DIR = path.join(ROOT_DIR, "tests/fixtures/admin_generation/run_sample");

// 테스트가 만든 임시 폴더는 프로세스가 끝날 때 지운다.
const tempDirs: string[] = [];
process.on("exit", () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
export function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// 임시 폴더에 고정 실행 결과(run_sample)를 실제 실행 폴더 모양으로 놓고 그 폴더를 돌려준다.
// 직업과 난이도를 주면 가짜 생성과 같은 고치기로 그 직업 · 난이도의 실행 폴더를 만든다(문장은 exec_001).
export function copySampleRun(jobCode?: string, difficulty?: string): string {
  const runDir = tempDir("admin-gen-run-");
  if (jobCode && difficulty) {
    const jobName = new NcsCatalog(FIXTURE_NCS, fixtureDuties).jobName(jobCode) ?? jobCode;
    writeSampleRun(SAMPLE_DIR, runDir, { jobCode, jobName, difficulty, execJobId: "exec_001", execJobText: "문장 하나", runFolder: path.basename(runDir) });
    writeSampleReview(SAMPLE_DIR, runDir, { jobCode, jobName, difficulty }, null);
    return runDir;
  }
  const jobDir = path.join(runDir, "jobs", "K000001080", "normal");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, "review"), { recursive: true });
  fs.copyFileSync(path.join(SAMPLE_DIR, "pilot_summary.json"), path.join(runDir, "pilot_summary.json"));
  fs.copyFileSync(path.join(SAMPLE_DIR, "mission_output.json"), path.join(jobDir, "mission_output.json"));
  fs.copyFileSync(path.join(SAMPLE_DIR, "generation_basis.json"), path.join(jobDir, "generation_basis.json"));
  fs.copyFileSync(path.join(SAMPLE_DIR, "review_record.json"), path.join(runDir, "review", "K000001080_normal.json"));
  return runDir;
}

// 숫자를 원래 글자 그대로 두고 읽는다(1.0이 1로 바뀌지 않게). 저장소 색인은 Python이 쓴 모양이다.
function parseKeepingNumbers(text: string) {
  const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && rawJSON && context?.source ? rawJSON(context.source) : value
  );
}

export const FIXTURE_NCS = path.join(ROOT_DIR, "tests/fixtures/admin_generation/ncs_jobs");
export const fixtureDuties = (code: string) =>
  code === "K900000001" ? ["문장 하나", "문장 둘", "문장 셋", "문장 넷"] : code === "K900000002" ? ["문장 하나"] : null;

export interface AdminWorkspace {
  dir: string;
  config: ServerConfig;
  ncs: NcsCatalog;
  seedMissionKey: string;
  cleanup(): void;
}

// 임시 작업 폴더: missions/, outputs/를 임시 폴더 쪽으로 바꾼 설정과 고정 직업 자료(K900000001, K900000002).
// missions/에는 저장소 카탈로그의 첫 미션 하나를 복사해 둔다(미리 넣은 미션 노릇, seedMissionKey).
export function makeAdminWorkspace(): AdminWorkspace {
  const dir = tempDir("admin-gen-ws-");
  const config = loadServerConfig({ APP_ENV: "test" } as NodeJS.ProcessEnv);
  config.paths.missions = path.join(dir, "missions");
  config.paths.outputs = path.join(dir, "outputs");
  config.paths.ncsJobs = FIXTURE_NCS;
  config.admin.password = "pw";
  fs.mkdirSync(config.paths.outputs, { recursive: true });
  fs.mkdirSync(path.join(config.paths.missions, "scenarios"), { recursive: true });

  const repoMissions = path.join(ROOT_DIR, "missions");
  const index = parseKeepingNumbers(fs.readFileSync(path.join(repoMissions, "index.json"), "utf8"));
  const seed = index.missions[0];
  const job = index.jobs.find((item: { job_cd: string }) => item.job_cd === seed.job_cd);
  fs.copyFileSync(path.join(repoMissions, seed.path), path.join(config.paths.missions, seed.path));
  const seedIndex = { ...index, jobs: [{ ...job, mission_keys: [seed.key] }], missions: [seed] };
  fs.writeFileSync(path.join(config.paths.missions, "index.json"), JSON.stringify(seedIndex, null, 2), "utf8");

  return {
    dir,
    config,
    ncs: new NcsCatalog(FIXTURE_NCS, fixtureDuties),
    seedMissionKey: String(seed.key),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

// Python 없이 scripts/export_missions.py를 흉내 낸다: 준비 폴더의 미션을 missions/scenarios/<직업코드>_NN.json으로 쓰고
// 색인에 한 줄과 직업 줄을 더한다. 키는 runs 바로 아래 폴더 이름 + "__" + 미션 번호다. 같은 미션 번호가 있으면 _002로 올린다.
export function stubExport(): GenerationCommands["exportMission"] {
  return async (stagingDir, missionsDir): Promise<CommandOutcome> => {
    const indexPath = path.join(missionsDir, "index.json");
    const index = parseKeepingNumbers(fs.readFileSync(indexPath, "utf8"));
    const scenarios = path.join(missionsDir, "scenarios");
    fs.mkdirSync(scenarios, { recursive: true });
    for (const file of listFiles(stagingDir).filter((name) => path.basename(name) === "mission_output.json")) {
      const parts = path.relative(stagingDir, file).split(path.sep);
      const prefix = parts[parts.indexOf("runs") + 1];
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const ids = new Set(index.missions.map((m: { mission_id: string }) => m.mission_id));
      let missionId = String(data.mission_id);
      if (ids.has(missionId)) missionId = missionId.replace(/_\d+$/, "_002");
      data.mission_id = missionId;
      const jobCd = String(data.job_identity.job_cd);
      let n = 1;
      while (fs.existsSync(path.join(scenarios, `${jobCd}_${String(n).padStart(2, "0")}.json`))) n += 1;
      const rel = `scenarios/${jobCd}_${String(n).padStart(2, "0")}.json`;
      fs.writeFileSync(path.join(missionsDir, rel), JSON.stringify(data, null, 2), "utf8");
      const key = `${prefix}__${missionId}`;
      index.missions.push({
        key,
        path: rel,
        mission_id: missionId,
        job_cd: jobCd,
        job_name: String(data.job_identity.job_smcl_nm ?? ""),
        difficulty: String(data.mission?.difficulty?.level ?? ""),
        title: String(data.mission?.title ?? ""),
        task_type: String(data.mission?.task_type ?? ""),
        estimated_time_minutes: Number(data.mission?.difficulty?.estimated_time_minutes ?? 15),
        axis_signals: { AX1: 0.2, AX2: 0.2, AX3: 0.2, AX4: 0.2, AX5: 0.2 }
      });
      const job = index.jobs.find((item: { job_cd: string }) => item.job_cd === jobCd);
      if (job) job.mission_keys = [...job.mission_keys, key];
      else index.jobs.push({ job_cd: jobCd, job_name: String(data.job_identity.job_smcl_nm ?? ""), icon: "💼", mission_keys: [key] });
    }
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
    return { exitCode: 0, timedOut: false, spawnError: null, lines: [] };
  };
}

export type TestCommands = GenerationCommands & { calls: string[] };

// 시험용 명령: 간격 0의 가짜 명령에 Python 없는 내보내기를 끼우고 overrides로 덮는다. 불린 메서드 이름을 calls에 담는다.
export function testCommands(ws: { config: ServerConfig; ncs: NcsCatalog }, overrides: Partial<GenerationCommands> = {}): TestCommands {
  const base: GenerationCommands = { ...createFakeCommands(ws.config, ws.ncs, { stepDelayMs: 0 }), exportMission: stubExport(), ...overrides };
  const calls: string[] = [];
  const record = <K extends keyof GenerationCommands>(name: K): GenerationCommands[K] =>
    ((...args: unknown[]) => {
      calls.push(name);
      return (base[name] as (...a: unknown[]) => unknown)(...args);
    }) as GenerationCommands[K];
  return {
    preflight: record("preflight"),
    planTarget: record("planTarget"),
    generate: record("generate"),
    review: record("review"),
    exportMission: record("exportMission"),
    calls
  };
}

// 서비스 하나: 메모리 DB, 임시 missions/의 카탈로그, 시험용 명령.
export function makeService(ws: AdminWorkspace, overrides: Partial<GenerationCommands> = {}) {
  const db = openDatabase(":memory:");
  const missionStore = new MissionStore(ws.config.paths.missions, () => {});
  const commands = testCommands(ws, overrides);
  const service = new AdminGenerationService({ config: ws.config, db, missionStore, ncs: ws.ncs, commands });
  return { service, db, commands, missionStore };
}
