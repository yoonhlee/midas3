import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadJobsCatalog } from "../../src/lib/jobs/catalog.js";
import { currentSchemaVersion, openDatabase } from "../../src/lib/db/database.js";
import {
  addGenerationStart,
  deleteGenerationRun,
  findGenerationRunByCatalogKey,
  getGenerationRun,
  getGenerationStartCount,
  insertGenerationRun,
  listGenerationRuns,
  updateGenerationRun
} from "../../src/lib/db/repos.js";
import { applyProgressLine, initialProgress } from "../../src/lib/adminGeneration/progress.js";
import { readReview, readRunArtifacts, runDirFor } from "../../src/lib/adminGeneration/runFiles.js";
import { createFakeCommands } from "../../src/lib/adminGeneration/fakeCommands.js";
import {
  catalogKeys,
  isAdminMissionKey,
  prepareExportStaging,
  removeCatalogMission,
  restoreCatalog,
  snapshotCatalog
} from "../../src/lib/adminGeneration/catalogFile.js";
import { MissionStore } from "../../src/server/missionStore.js";
import { copySampleRun, FIXTURE_NCS, fixtureDuties, makeAdminWorkspace, sampleRunRow, stubExport } from "./helpers/adminGenerationFixture.js";
import { NcsCatalog } from "../../src/lib/adminGeneration/ncsCatalog.js";
import { loadServerConfig, ROOT_DIR } from "../../src/server/config.js";
import {
  createLineSplitter,
  createPythonCommands,
  exportArgs,
  generateArgs,
  preflightArgs,
  pythonSpawnEnv,
  reviewArgs,
  targetArgs
} from "../../src/lib/adminGeneration/commands.js";

// 관리자 미션 생성(새 방식)의 모듈 테스트. 외부 API를 부르지 않는다.

test("관리자 생성 설정: 기본값, 환경 변수, 운영에서는 가짜 모드가 켜지지 않는다", () => {
  const cfg = (env: Record<string, string>) => loadServerConfig(env as NodeJS.ProcessEnv).adminGeneration;
  assert.deepEqual([cfg({}).mode, cfg({}).dailyLimit, cfg({}).narrow], ["live", 20, true]);
  const custom = cfg({ ADMIN_GENERATION_MODE: "fake", ADMIN_GENERATION_DAILY_LIMIT: "5", ADMIN_GENERATION_NARROW: "false", PYTHON_BIN: "py-x" });
  assert.deepEqual([custom.mode, custom.dailyLimit, custom.narrow, custom.pythonBin], ["fake", 5, false, "py-x"]);
  assert.equal(cfg({ ADMIN_GENERATION_MODE: "fake", APP_ENV: "production" }).mode, "live");
  assert.equal(cfg({ ADMIN_GENERATION_DAILY_LIMIT: "abc" }).dailyLimit, 20);
  // .env.example처럼 빈 값으로 두면 기본값이다(빈 글자를 0으로 읽어 한도 1이 되지 않게).
  assert.equal(cfg({ ADMIN_GENERATION_DAILY_LIMIT: "" }).dailyLimit, 20);
});

test("Python 명령 인자: 관리자 경로는 새 방식의 인자만 쓰고 제공자를 Claude로 못박는다", () => {
  const input = { jobCode: "K000001080", execJobId: "exec_005", unitKey: "20010105:09", difficulty: "normal" as const };
  assert.deepEqual(generateArgs("t.json", "data/ncs/jobs"), ["-u", "-m", "src.mission_generation.pilot_runner", "--ncs-background", "--two-stage-basis", "--ncs-targets", "t.json", "--ncs-root", "data/ncs/jobs", "--concurrency", "1"]);
  assert.deepEqual(targetArgs(input, { narrow: true, outFile: "o.json" }, "data/ncs/jobs"), ["-m", "src.mission_generation.admin_target", "--job", "K000001080", "--exec", "exec_005", "--unit", "20010105:09", "--difficulty", "normal", "--ncs-root", "data/ncs/jobs", "--out", "o.json"]);
  assert.deepEqual(targetArgs(input, { narrow: false }, "data/ncs/jobs").slice(-2), ["--no-narrow", "--print"]);
  assert.deepEqual(reviewArgs("r"), ["-u", "-m", "src.mission_generation.mission_reviewer", "--run-dir", "r"]);
  assert.deepEqual(exportArgs("s", "m"), ["scripts/export_missions.py", "--outputs", "s", "--missions-dir", "m"]);
  assert.deepEqual(preflightArgs(), ["-m", "src.mission_generation.preflight"]);
  const env = pythonSpawnEnv({ MISSION_LLM_PROVIDER: "openai", PATH: "x" });
  assert.deepEqual([env.MISSION_LLM_PROVIDER, env.PYTHONIOENCODING, env.PYTHONUNBUFFERED, env.PATH], ["anthropic", "utf-8", "1", "x"]);
});

test("줄 나누기: 덩어리 경계에서 잘린 줄과 한글을 한 줄로 읽는다", () => {
  const bytes = Buffer.from("[08:00:01] run started - run_id=r1\n미션 1개: 통과 1\r\nlast", "utf8");
  for (const size of [1, 7, 4096]) {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    for (let i = 0; i < bytes.length; i += size) splitter.push(bytes.subarray(i, i + size));
    splitter.flush();
    assert.deepEqual(lines, ["[08:00:01] run started - run_id=r1", "미션 1개: 통과 1", "last"]);
  }
});

test("Python을 띄울 수 없으면 시작 전 확인이 그 이유를 알린다", async () => {
  const config = loadServerConfig({ PYTHON_BIN: "no-such-python-for-test" } as NodeJS.ProcessEnv);
  const result = await createPythonCommands(config).preflight();
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].code, "GENERATION_PYTHON_UNAVAILABLE");
});

test("문장 목록과 고를 수 있는 연결: 문장 구분, 처음에 골라 둘 능력단위, 고를 수 없는 연결", () => {
  const ncs = new NcsCatalog(FIXTURE_NCS, fixtureDuties);
  assert.deepEqual(ncs.jobs().map((job) => [job.jobCode, job.sentenceCount, job.selectableSentenceCount]), [["K900000001", 4, 2]]);
  const sentences = ncs.sentences("K900000001")!;
  assert.deepEqual(sentences.map((s) => [s.execJobId, s.selectable, s.blockedReason]), [["exec_001", true, null], ["exec_002", true, null], ["exec_003", false, "OTHER_LINK_ONLY"], ["exec_004", false, "NO_LINK"]]);
  assert.equal(sentences[3].text, "문장 넷");
  assert.equal(ncs.sentences("K999999999"), null);
  // 능력단위가 둘이면 직접 연결을 먼저, 같으면 재료가 많은 쪽을 처음에 골라 둔다.
  assert.deepEqual(sentences[0].units.map((u) => [u.unitKey, u.linkKind, u.isDefault]), [["90000001:01", "직접", true], ["90000001:02", "분야 한정", false]]);
  assert.deepEqual(sentences[0].units[1].counts, { criteria: 3, documents: 5, considerations: 0 });
  assert.deepEqual(sentences[1].units.map((u) => [u.unitKey, u.isDefault]), [["90000001:05", true], ["90000001:03", false]]);
  // 고른 연결 확인
  assert.deepEqual(ncs.findSelectable("K900000001", "exec_002", "90000001:03"), { jobCode: "K900000001", jobName: "시범 직업 가", execJobId: "exec_002", execJobText: "문장 둘", unitKey: "90000001:03", unitName: "시범 능력단위 셋", linkKind: "분야 한정" });
  assert.deepEqual(ncs.findSelectable("K999999999", "exec_001", "x"), { error: "JOB_NOT_FOUND" });
  assert.deepEqual(ncs.findSelectable("K900000001", "exec_001", "90000001:04"), { error: "LINK_NOT_FOUND" });
  assert.deepEqual(ncs.findSelectable("K900000001", "exec_003", "90000001:04"), { error: "LINK_NOT_SELECTABLE" });
  assert.deepEqual(ncs.findSelectable("K900000002", "exec_001", "90000002:01"), { error: "LINK_NOT_SELECTABLE" });
});

test("실제 자료: 고를 수 있는 직업 74개, 문장 399개, 연결 548개", () => {
  const jobsCatalog = loadJobsCatalog(path.join(ROOT_DIR, "data/jobs"));
  const ncs = new NcsCatalog(path.join(ROOT_DIR, "data/ncs/jobs"), (code) => jobsCatalog.get(code)?.duties ?? null);
  const jobs = ncs.jobs();
  const units = jobs.flatMap((job) => ncs.sentences(job.jobCode)!.flatMap((s) => s.units.filter((u) => u.selectable)));
  assert.deepEqual([jobs.length, jobs.reduce((sum, job) => sum + job.selectableSentenceCount, 0), units.length], [74, 399, 548]);
});

test("생성 기록과 하루 건수: 넣기, 고치기, 지우기, 기록을 지워도 그날 건수는 줄지 않는다", () => {
  const db = openDatabase(":memory:");
  assert.equal(currentSchemaVersion(db), 2);
  const a = insertGenerationRun(db, sampleRunRow({ id: "a" }));
  insertGenerationRun(db, sampleRunRow({ id: "b" }));
  assert.equal(a.status, "running");
  const updated = updateGenerationRun(db, "a", { status: "added", catalog_key: "jobsim_admin_v1__m1", mission_title: "제목" })!;
  assert.deepEqual([updated.status, updated.catalog_key, updated.mission_title], ["added", "jobsim_admin_v1__m1", "제목"]);
  assert.equal(findGenerationRunByCatalogKey(db, "jobsim_admin_v1__m1")!.id, "a");
  assert.equal(listGenerationRuns(db, 10).length, 2);
  assert.throws(() => updateGenerationRun(db, "b", { ["status = 'x'; --" as "error_code"]: "x" }));
  assert.deepEqual([addGenerationStart(db, "2026-01-01"), addGenerationStart(db, "2026-01-01")], [1, 2]);
  assert.equal(deleteGenerationRun(db, "a"), true);
  assert.equal(getGenerationRun(db, "a"), null);
  assert.deepEqual([getGenerationStartCount(db, "2026-01-01"), getGenerationStartCount(db, "2026-01-02")], [2, 0]);
});

const REAL_LINES = [
  "[09:00:00] run started - run_id=pilot_v1_20250101_090000 targets=1 concurrency=1",
  "[09:00:00] [1/1] K000001080 normal - target started",
  "[09:00:00] [1/1] K000001080 normal - blueprint LLM started (attempt 0)",
  "[09:00:16] [1/1] K000001080 normal - blueprint check 0 (pass)",
  "[09:00:16] [1/1] K000001080 normal - draft LLM started",
  "[09:00:30] [1/1] K000001080 normal - draft LLM finished (completed)",
  "[09:00:30] [1/1] K000001080 normal - validator attempt 0 (pass)",
  "[09:00:31] [1/1] K000001080 normal - saved",
  "[09:00:31] run finished - saved=1 failed=0 repair_used=0",
  "D:\\x\\outputs\\pilot\\v1\\runs\\pilot_v1_20250101_090000",
  "saved=1 failed=0 openai_api_called=True"
];

test("진행 메시지: 실제 줄 순서대로 단계가 넘어가고, 다시 쓴 설계서 · 고쳐 쓴 미션 · 실패를 읽는다", () => {
  const stages: string[] = [];
  let state = initialProgress();
  for (const line of REAL_LINES) { state = applyProgressLine(state, line); if (stages.at(-1) !== state.stage) stages.push(state.stage); }
  assert.deepEqual(stages, ["queued", "blueprint", "blueprint_check", "writing", "mission_check"]);
  assert.deepEqual([state.runFolder, state.saved, state.failureCode, state.rewrites], ["pilot_v1_20250101_090000", true, null, { blueprint: 0, mission: 0 }]);

  const run = (lines: string[]) => lines.reduce(applyProgressLine, initialProgress());
  const p = "[09:00:00] [1/1] K1 hard - ";
  assert.deepEqual(run([p + "blueprint check 0 (errors)", p + "blueprint LLM started (attempt 1)"]).rewrites, { blueprint: 1, mission: 0 });
  const repaired = run([p + "validator attempt 0 (repairable)", p + "repair LLM started"]);
  assert.deepEqual([repaired.stage, repaired.rewrites.mission], ["writing", 1]);
  const failed = run([p + "blueprint failed (BLUEPRINT_CHECK_FAILED)", "[09:00:09] run finished - saved=0 failed=1 repair_used=0"]);
  assert.deepEqual([failed.saved, failed.failureCode], [false, "BLUEPRINT_CHECK_FAILED"]);
});

test("실행 폴더 읽기: 저장된 미션 · 근거 · 검수 기록, 빈 폴더, 이상한 폴더 이름", () => {
  const runDir = copySampleRun();
  const artifacts = readRunArtifacts(runDir);
  assert.equal(artifacts.saved, true);
  assert.equal(artifacts.missionId, "mission_K000001080_normal_001");
  assert.ok(artifacts.missionTitle && artifacts.mission && artifacts.basis && artifacts.missionFile);
  assert.equal(readReview(runDir, "K000001080", "normal").verdict, "pass");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "admin-gen-empty-"));
  assert.deepEqual(readRunArtifacts(empty), { saved: false, missionId: null, missionTitle: null, missionFile: null, mission: null, basis: null, failureCode: null });
  assert.deepEqual(readReview(empty, "K000001080", "normal"), { verdict: "review_failed", record: null });
  fs.rmSync(empty, { recursive: true, force: true });
  assert.equal(runDirFor("o", "../x"), null);
  assert.equal(runDirFor("o", ""), null);
  assert.equal(runDirFor("o", "pilot_v1_20250101_090000"), path.join("o", "pilot/v1/runs", "pilot_v1_20250101_090000"));
});

test("가짜 생성: 고른 직업과 난이도로 실행 폴더와 검수 기록이 만들어진다", async () => {
  const ws = makeAdminWorkspace();
  const commands = createFakeCommands(ws.config, ws.ncs, { stepDelayMs: 0 });
  const targetFile = path.join(ws.config.paths.outputs, "admin_targets", "t.json");
  assert.deepEqual(await commands.planTarget({ jobCode: "K900000001", execJobId: "exec_002", unitKey: "90000001:03", difficulty: "hard" }, { narrow: true, outFile: targetFile }), { ok: true, allowedMaterialTypes: ["table", "memo"] });
  let state = initialProgress();
  const outcome = await commands.generate(targetFile, (line) => { state = applyProgressLine(state, line); });
  assert.deepEqual([outcome.exitCode, state.saved, state.stage], [0, true, "mission_check"]);
  const runDir = runDirFor(ws.config.paths.outputs, state.runFolder!)!;
  const artifacts = readRunArtifacts(runDir);
  assert.equal(artifacts.missionId, "mission_K900000001_hard_001");
  assert.equal((artifacts.mission as any).target_exec_job.exec_job_id, "exec_002");
  await commands.review(runDir, () => {});
  assert.equal(readReview(runDir, "K900000001", "hard").verdict, "pass");
  ws.cleanup();
});

test("추가 준비와 카탈로그에서 빼기: 준비 폴더에 미션 하나만, 색인과 미션 파일에서 빠짐, 미리 넣은 미션은 거절", async () => {
  const ws = makeAdminWorkspace();
  const indexPath = path.join(ws.config.paths.missions, "index.json");
  const indexBefore = fs.readFileSync(indexPath, "utf8");
  const missionFile = readRunArtifacts(copySampleRun()).missionFile!;
  const staging = prepareExportStaging(ws.config.paths.outputs, missionFile, "K000001080", "normal");
  fs.writeFileSync(path.join(staging, "leftover.txt"), "x");
  prepareExportStaging(ws.config.paths.outputs, missionFile, "K000001080", "normal");
  const files = fs.readdirSync(staging, { recursive: true }).filter((p) => fs.statSync(path.join(staging, String(p))).isFile()).map((p) => String(p).replace(/\\/g, "/"));
  assert.deepEqual(files, ["runs/jobsim_admin_v1/jobs/K000001080/normal/mission_output.json"]);

  const easyStaging = prepareExportStaging(ws.config.paths.outputs, readRunArtifacts(copySampleRun("K900000001", "easy")).missionFile!, "K900000001", "easy");
  await stubExport()(easyStaging, ws.config.paths.missions);
  const added = catalogKeys(ws.config.paths.missions).find(isAdminMissionKey)!;
  assert.equal(added, "jobsim_admin_v1__mission_K900000001_easy_001");
  assert.equal(new MissionStore(ws.config.paths.missions, () => {}).validateAndRefresh().ok, true);
  assert.equal(removeCatalogMission(ws.config.paths.missions, added), true);
  const index = JSON.parse(fs.readFileSync(path.join(ws.config.paths.missions, "index.json"), "utf8"));
  assert.deepEqual(index.missions.map((m: any) => m.key), [ws.seedMissionKey]);
  assert.equal(index.jobs.some((j: any) => j.job_cd === "K900000001"), false);
  assert.equal(fs.readdirSync(path.join(ws.config.paths.missions, "scenarios")).length, 1);
  assert.equal(removeCatalogMission(ws.config.paths.missions, added), false);
  // 추가했다가 빼면 색인의 글이 처음과 같다(숫자 1.0이 1로 바뀌는 식의 변화도 없다).
  assert.equal(fs.readFileSync(indexPath, "utf8"), indexBefore);

  assert.equal(isAdminMissionKey(ws.seedMissionKey), false);
  assert.throws(() => removeCatalogMission(ws.config.paths.missions, ws.seedMissionKey));
  assert.deepEqual(catalogKeys(ws.config.paths.missions), [ws.seedMissionKey]);
  ws.cleanup();
});

test("되돌리기: 색인과 새로 생긴 파일, 지운 파일이 원래대로다", async () => {
  const ws = makeAdminWorkspace();
  const before = snapshotCatalog(ws.config.paths.missions);
  const staging = prepareExportStaging(ws.config.paths.outputs, readRunArtifacts(copySampleRun("K900000001", "easy")).missionFile!, "K900000001", "easy");
  await stubExport()(staging, ws.config.paths.missions);
  restoreCatalog(ws.config.paths.missions, before);
  assert.deepEqual(catalogKeys(ws.config.paths.missions), [ws.seedMissionKey]);
  assert.equal(fs.readdirSync(path.join(ws.config.paths.missions, "scenarios")).length, 1);
  await stubExport()(staging, ws.config.paths.missions);
  const key = catalogKeys(ws.config.paths.missions).find(isAdminMissionKey)!;
  const withRemoved = snapshotCatalog(ws.config.paths.missions, key);
  removeCatalogMission(ws.config.paths.missions, key);
  restoreCatalog(ws.config.paths.missions, withRemoved);
  assert.equal(catalogKeys(ws.config.paths.missions).includes(key), true);
  assert.equal(fs.readdirSync(path.join(ws.config.paths.missions, "scenarios")).length, 2);
  ws.cleanup();

  // 바꾸기 전 모습을 "없음" 말고 다른 이유로 읽지 못하면 던진다(빈 목록으로 알고 되돌리다 미리 넣은 파일을 지우지 않게).
  const badScenarios = makeAdminWorkspace();
  fs.rmSync(path.join(badScenarios.config.paths.missions, "scenarios"), { recursive: true, force: true });
  fs.writeFileSync(path.join(badScenarios.config.paths.missions, "scenarios"), "not a folder");
  assert.throws(() => snapshotCatalog(badScenarios.config.paths.missions));
  const badIndex = makeAdminWorkspace();
  fs.rmSync(path.join(badIndex.config.paths.missions, "index.json"));
  fs.mkdirSync(path.join(badIndex.config.paths.missions, "index.json"));
  assert.throws(() => snapshotCatalog(badIndex.config.paths.missions));
  badScenarios.cleanup();
  badIndex.cleanup();
});
