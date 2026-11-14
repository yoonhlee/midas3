import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { catalogKeys } from "../../src/lib/adminGeneration/catalogFile.js";
import type { GenerationCommands } from "../../src/lib/adminGeneration/commands.js";
import { createFakeCommands } from "../../src/lib/adminGeneration/fakeCommands.js";
import { RUNS_SUBDIR } from "../../src/lib/adminGeneration/runFiles.js";
import { AdminGenerationService, seoulDay, type StartInput } from "../../src/lib/adminGeneration/service.js";
import type { NcsCatalog } from "../../src/lib/adminGeneration/ncsCatalog.js";
import { AdminGenerationRunViewSchema } from "../../src/lib/api/contracts.js";
import { insertGenerationRun, updateGenerationRun } from "../../src/lib/db/repos.js";
import type { ServerConfig } from "../../src/server/config.js";
import { makeAdminWorkspace, makeService, sampleRunRow, stubExport, testCommands } from "./helpers/adminGenerationFixture.js";
import { Client, startTestServer } from "./helpers/testServer.js";

// 관리자 미션 생성(새 방식)의 서비스와 경로 테스트. 외부 API를 부르지 않는다.

const PICK = { jobCode: "K900000001", execJobId: "exec_001", unitKey: "90000001:01", difficulty: "normal" as const, review: true };

test("생성 한 건: 시작부터 검토 대기까지, 검수를 끄면 검수 단계를 건너뛰고 나중에 검수할 수 있다", async () => {
  const { service, commands } = makeService(makeAdminWorkspace());
  const started = await service.start(PICK);
  assert.deepEqual([started.status, started.selection.jobName, started.selection.linkKind], ["running", "시범 직업 가", "직접"]);
  await service.settled();
  const run = service.get(started.runId)!;
  assert.deepEqual([run.status, run.stage, run.reviewVerdict, run.missionId], ["ready", "done", "pass", "mission_K900000001_normal_001"]);
  assert.deepEqual(run.stages.map((s) => s.state), ["done", "done", "done", "done", "done", "active"]);
  assert.ok(run.mission && run.basis && run.reviewRecord && run.logs.length > 0);
  assert.deepEqual([run.catalog.canAdd, run.catalog.canReview, run.selection.allowedMaterialTypes], [true, false, ["table", "memo"]]);
  assert.equal((await service.status()).today.started, 1);
  assert.equal(service.list()[0].runId, started.runId);

  const noReview = await service.start({ ...PICK, review: false });
  await service.settled();
  const skipped = service.get(noReview.runId)!;
  assert.deepEqual([skipped.status, skipped.reviewVerdict, skipped.stages[4].state, skipped.catalog.canReview], ["ready", null, "skipped", true]);
  assert.equal(commands.calls.filter((c) => c === "review").length, 1);
});

test("거의 동시에 두 번 시작하면 한 건만 돈다", async () => {
  const { service, commands } = makeService(makeAdminWorkspace());
  const results = await Promise.allSettled([service.start(PICK), service.start(PICK)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "GENERATION_ALREADY_RUNNING");
  await service.settled();
  assert.equal(commands.calls.filter((c) => c === "generate").length, 1);
  assert.equal((await service.status()).today.started, 1);
});

test("하루 한도를 넘으면 시작하지 않고, 한도의 날짜는 한국 시간으로 넘어간다", async () => {
  const ws = makeAdminWorkspace();
  ws.config.adminGeneration.dailyLimit = 1;
  const { service, commands } = makeService(ws);
  await service.start(PICK); await service.settled();
  await assert.rejects(service.start(PICK), (e: any) => e.status === 429 && e.code === "GENERATION_DAILY_LIMIT" && e.details.limit === 1);
  assert.equal(commands.calls.filter((c) => c === "generate").length, 1);
  assert.deepEqual([seoulDay(new Date("2026-01-01T14:59:00Z")), seoulDay(new Date("2026-01-01T15:00:00Z"))], ["2026-01-01", "2026-01-02"]);
});

test("시작하지 않는 경우: 시작 전 확인 실패, 없는 직업, 고를 수 없는 연결, 없는 연결", async () => {
  const failing = { ok: false, mode: "live" as const, model: null, reasoning_effort: null, speed: null, checks: [{ name: "api_key", ok: false, code: "LLM_API_KEY_MISSING", message: "x" }] };
  const blocked = makeService(makeAdminWorkspace(), { preflight: async () => failing });
  await assert.rejects(blocked.service.start(PICK), (e: any) => e.status === 503 && e.code === "LLM_API_KEY_MISSING");
  assert.deepEqual([blocked.commands.calls.includes("generate"), blocked.service.list().length, (await blocked.service.status()).today.started, (await blocked.service.status()).activeRunId], [false, 0, 0, null]);

  const { service, commands } = makeService(makeAdminWorkspace());
  await assert.rejects(service.start({ ...PICK, jobCode: "K999999999" }), (e: any) => e.status === 404 && e.code === "GENERATION_JOB_NOT_FOUND");
  await assert.rejects(service.start({ ...PICK, execJobId: "exec_003", unitKey: "90000001:04" }), (e: any) => e.status === 400 && e.code === "GENERATION_LINK_NOT_SELECTABLE");
  await assert.rejects(service.start({ ...PICK, unitKey: "90000001:09" }), (e: any) => e.status === 404 && e.code === "GENERATION_LINK_NOT_FOUND");
  assert.equal(commands.calls.length, 0);
});

test("저장에 실패하거나 시간을 넘긴 실행은 실패로 남고 잠금이 풀려 다음 생성이 시작된다", async () => {
  const ws = makeAdminWorkspace();
  let mode: "fail" | "timeout" | "ok" = "fail";
  const fake = createFakeCommands(ws.config, ws.ncs, { stepDelayMs: 0 });
  const { service } = makeService(ws, { generate: async (file, onLine) => {
    if (mode === "ok") return fake.generate(file, onLine);
    if (mode === "timeout") return { exitCode: null, timedOut: true, spawnError: null, lines: [] };
    onLine("[09:00:00] run started - run_id=failed_run_1 targets=1 concurrency=1");
    onLine("[09:00:01] [1/1] K900000001 normal - blueprint failed (BLUEPRINT_CHECK_FAILED)");
    onLine("[09:00:01] run finished - saved=0 failed=1 repair_used=0");
    return { exitCode: 0, timedOut: false, spawnError: null, lines: [] };
  } });
  const first = await service.start(PICK); await service.settled();
  const run = service.get(first.runId)!;
  assert.deepEqual([run.status, run.error?.code, run.catalog.canAdd, run.stages[0].state], ["failed", "BLUEPRINT_CHECK_FAILED", false, "failed"]);

  mode = "timeout";
  const timed = await service.start(PICK); await service.settled();
  assert.deepEqual([service.get(timed.runId)!.status, service.get(timed.runId)!.error?.code, (await service.status()).activeRunId], ["failed", "GENERATION_TIMEOUT", null]);

  mode = "ok";
  const second = await service.start(PICK); await service.settled();
  assert.equal(service.get(second.runId)!.status, "ready");

  // 뒤에서 도는 일에서 DB 오류가 나도 처리되지 않은 거절로 서버 프로세스가 죽지 않는다.
  const broken = makeService(makeAdminWorkspace(), {
    generate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      broken.db.close();
      throw new Error("db gone");
    }
  });
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await broken.service.start(PICK);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
});

test("검수가 죽거나 시간이 넘어도 미션은 검토 대기로 남는다", async () => {
  const { service } = makeService(makeAdminWorkspace(), { review: async () => ({ exitCode: null, timedOut: true, spawnError: null, lines: [] }) });
  const started = await service.start(PICK); await service.settled();
  const run = service.get(started.runId)!;
  assert.deepEqual([run.status, run.reviewVerdict, run.stages[4].state, run.catalog.canAdd, run.catalog.canReview], ["ready", "review_failed", "failed", true, true]);
});

test("서버를 다시 켜면 돌던 실행은 중단됨으로 보이고 새 생성이 시작된다", async () => {
  const ws = makeAdminWorkspace();
  const first = makeService(ws);
  insertGenerationRun(first.db, sampleRunRow({ id: "11111111-1111-4111-8111-111111111111", status: "running", stage: "writing", run_folder: "pilot_v1_interrupted" }));
  // 미션을 저장하고 검수하던 실행은 다시 켜면 "검토 대기 + 검수 실패"로 돌아온다(추가와 검수 다시 돌리기가 된다).
  insertGenerationRun(first.db, sampleRunRow({ id: "33333333-3333-4333-8333-333333333333", status: "running", stage: "review", mission_id: "mission_K900000001_normal_001", mission_title: "제목" }));
  const folder = path.join(ws.config.paths.outputs, RUNS_SUBDIR, "pilot_v1_interrupted");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "partial.json"), "{}");
  const again = new AdminGenerationService({ config: ws.config, db: first.db, missionStore: first.missionStore, ncs: ws.ncs, commands: testCommands(ws) });
  const old = again.get("11111111-1111-4111-8111-111111111111")!;
  assert.deepEqual([old.status, old.stages.map((s) => s.state)], ["interrupted", ["done", "done", "failed", "pending", "pending", "pending"]]);
  assert.ok(old.finishedAt);
  const reviewing = again.get("33333333-3333-4333-8333-333333333333")!;
  assert.deepEqual([reviewing.status, reviewing.reviewVerdict, reviewing.catalog.canAdd, reviewing.catalog.canReview], ["ready", "review_failed", true, true]);
  // 중단된 실행을 지우면 실행 폴더도 지워진다.
  await again.deleteRun("11111111-1111-4111-8111-111111111111");
  assert.equal(fs.existsSync(folder), false);
  const started = await again.start(PICK); await again.settled();
  assert.equal(again.get(started.runId)!.status, "ready");
});

// 검토 대기(ready)인 실행 하나를 만들고 그 번호를 돌려준다.
async function readyRun(ctx: ReturnType<typeof makeService>, input: StartInput = PICK) {
  const started = await ctx.service.start(input);
  await ctx.service.settled();
  return started.runId;
}

test("카탈로그에 추가: 키에 날짜가 없고 서비스에 바로 보이며, 판정이 문제면 추가할 수 없다", async () => {
  const ctx = makeService(makeAdminWorkspace());
  const run = await ctx.service.addToCatalog(await readyRun(ctx));
  assert.deepEqual([run.status, run.catalog.key, run.stages[5].state], ["added", "jobsim_admin_v1__mission_K900000001_normal_001", "done"]);
  assert.ok(ctx.missionStore.findByKey(run.catalog.key));
  const job = ctx.service.catalog().jobs.find((j) => j.jobCode === "K900000001")!;
  assert.deepEqual([job.addedByAdminOnly, job.counts.normal, job.missions[0].runId, job.missions[0].execJobId], [true, 1, run.runId, "exec_001"]);
  assert.equal((await ctx.service.addToCatalog(run.runId)).catalog.key, run.catalog.key);
  assert.equal(ctx.commands.calls.filter((c) => c === "exportMission").length, 1);

  for (const [verdict, allowed] of [["fail", false], ["doubt", true], ["review_failed", true]] as const) {
    const each = makeService(makeAdminWorkspace());
    const runId = await readyRun(each);
    updateGenerationRun(each.db, runId, { review_verdict: verdict });
    if (allowed) assert.equal((await each.service.addToCatalog(runId)).status, "added");
    else await assert.rejects(each.service.addToCatalog(runId), (e: any) => e.status === 409 && e.code === "CATALOG_ADD_NOT_ALLOWED" && e.details.reason === "REVIEW_VERDICT_FAIL");
  }
});

test("추가가 중간에 실패하면 카탈로그와 기록이 원래대로다", async () => {
  const ws = makeAdminWorkspace();
  const broken: GenerationCommands["exportMission"] = async (staging, missionsDir) => {
    await stubExport()(staging, missionsDir);
    const indexPath = path.join(missionsDir, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.missions.at(-1).path = "scenarios/없는_파일.json";
    fs.writeFileSync(indexPath, JSON.stringify(index));
    return { exitCode: 0, timedOut: false, spawnError: null, lines: [] };
  };
  for (const [exportMission, code] of [[broken, "MISSION_EXPORT_VALIDATION_FAILED"], [async () => ({ exitCode: 1, timedOut: false, spawnError: null, lines: ["boom"] }), "MISSION_EXPORT_FAILED"]] as const) {
    const ctx = makeService(ws, { exportMission });
    const runId = await readyRun(ctx);
    await assert.rejects(ctx.service.addToCatalog(runId), (e: any) => e.status === 500 && e.code === code);
    assert.deepEqual(catalogKeys(ws.config.paths.missions), [ws.seedMissionKey]);
    assert.equal(fs.readdirSync(path.join(ws.config.paths.missions, "scenarios")).length, 1);
    assert.ok(ctx.missionStore.findByKey(ws.seedMissionKey));
    assert.deepEqual([ctx.service.get(runId)!.status, ctx.service.get(runId)!.catalog.key], ["ready", null]);
  }
});

test("삭제 두 가지: 카탈로그에서 빼면 기록은 검토 대기로 돌아오고, 생성 기록에서 지우면 실행 폴더와 기록이 지워진다", async () => {
  const ws = makeAdminWorkspace();
  const ctx = makeService(ws);
  const added = await ctx.service.addToCatalog(await readyRun(ctx));
  assert.deepEqual(await ctx.service.removeFromCatalog(added.catalog.key!), { missionKey: added.catalog.key, runId: added.runId });
  assert.equal(ctx.missionStore.findByKey(added.catalog.key), null);
  assert.equal(ctx.service.catalog().jobs.some((j) => j.jobCode === "K900000001"), false);
  assert.deepEqual([ctx.service.get(added.runId)!.status, ctx.service.get(added.runId)!.catalog.canAdd], ["ready", true]);

  const readded = await ctx.service.addToCatalog(added.runId);
  assert.equal(readded.status, "added");
  const runsRoot = path.join(ws.config.paths.outputs, RUNS_SUBDIR);
  assert.equal(fs.readdirSync(runsRoot).length, 1);
  await ctx.service.deleteRun(added.runId);
  assert.deepEqual([ctx.service.get(added.runId), fs.readdirSync(runsRoot).length, ctx.missionStore.findByKey(readded.catalog.key)], [null, 0, null]);
  assert.deepEqual(catalogKeys(ws.config.paths.missions), [ws.seedMissionKey]);
  assert.equal((await ctx.service.status()).today.started, 1);
  await assert.rejects(ctx.service.deleteRun(added.runId), (e: any) => e.status === 404 && e.code === "GENERATION_RUN_NOT_FOUND");
});

test("미리 넣은 미션과 이상한 값은 지우지 않는다", async () => {
  const ws = makeAdminWorkspace();
  const ctx = makeService(ws);
  await assert.rejects(ctx.service.removeFromCatalog(ws.seedMissionKey), (e: any) => e.status === 403 && e.code === "CATALOG_MISSION_PROTECTED");
  for (const key of ["../index", "jobsim_admin_v1__없는_미션", ""]) {
    await assert.rejects(ctx.service.removeFromCatalog(key), (e: any) => e.status === 404 && e.code === "CATALOG_MISSION_NOT_FOUND");
  }
  insertGenerationRun(ctx.db, sampleRunRow({ id: "22222222-2222-4222-8222-222222222222", status: "interrupted", run_folder: "../../missions" }));
  await ctx.service.deleteRun("22222222-2222-4222-8222-222222222222");
  assert.deepEqual(catalogKeys(ws.config.paths.missions), [ws.seedMissionKey]);
  assert.ok(ctx.missionStore.findByKey(ws.seedMissionKey));
});

test("검수만 다시 돌리기: 실패했거나 검수 없이 만든 미션만", async () => {
  const ctx = makeService(makeAdminWorkspace());
  const runId = await readyRun(ctx, { ...PICK, review: false });
  const rerun = await ctx.service.rerunReview(runId);
  assert.deepEqual([rerun.status, rerun.stage], ["running", "review"]);
  await ctx.service.settled();
  assert.deepEqual([ctx.service.get(runId)!.status, ctx.service.get(runId)!.reviewVerdict], ["ready", "pass"]);
  await assert.rejects(ctx.service.rerunReview(runId), (e: any) => e.status === 409 && e.code === "REVIEW_NOT_ALLOWED");
  assert.equal((await ctx.service.status()).today.started, 1);

  // 도는 중이거나 카탈로그에 추가하는 중이면 검수만 다시 돌리기를 받지 않는다(같은 미션이 두 번 들어가지 않게).
  const ws = makeAdminWorkspace();
  const fake = createFakeCommands(ws.config, ws.ncs, { stepDelayMs: 0 });
  let releaseReview!: () => void;
  let releaseExport!: () => void;
  const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
  const exportGate = new Promise<void>((resolve) => { releaseExport = resolve; });
  const gated = makeService(ws, {
    review: async (dir, onLine) => { await reviewGate; return fake.review(dir, onLine); },
    exportMission: async (staging, dir) => { await exportGate; return stubExport()(staging, dir); }
  });
  const first = await readyRun(gated, { ...PICK, review: false });
  await gated.service.rerunReview(first);
  await assert.rejects(gated.service.rerunReview(first), (e: any) => e.status === 409 && e.code === "GENERATION_STILL_RUNNING");
  releaseReview();
  await gated.service.settled();
  const second = await readyRun(gated, { ...PICK, review: false });
  const adding = gated.service.addToCatalog(second);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(gated.service.rerunReview(second), (e: any) => e.status === 409 && e.code === "GENERATION_STILL_RUNNING");
  releaseExport();
  assert.equal((await adding).status, "added");
  await gated.service.settled();
  assert.equal(gated.service.get(second)!.status, "added");
});

// ── 경로 ───────────────────────────────────────────────
const BASE = "/api/admin/mission-generation";
const TOKEN = { "x-api-token": "pw" };

function useWorkspace(c: ServerConfig, ws: ReturnType<typeof makeAdminWorkspace>, demoUnlock = false) {
  c.paths.missions = ws.config.paths.missions;
  c.paths.outputs = ws.config.paths.outputs;
  c.paths.ncsJobs = ws.config.paths.ncsJobs;
  c.admin.password = "pw";
  c.admin.demoUnlock = demoUnlock;
}

async function waitForRun(c: Client, runId: string) {
  for (let i = 0; i < 400; i += 1) {
    const res = await c.request("GET", `${BASE}/runs/${runId}`, undefined, TOKEN);
    if (res.json?.run?.status !== "running") return res.json.run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not finish");
}

test("관리자 생성 경로: 직업 → 문장 → 형태 → 생성 → 기록 → 추가 → 삭제", async () => {
  const ws = makeAdminWorkspace();
  const srv = await startTestServer({ configure: (c) => useWorkspace(c, ws), generationCommands: (config, ncs) => testCommands({ config, ncs }) });
  try {
    const c = new Client(srv.base);
    const get = (url: string) => c.request("GET", `${BASE}${url}`, undefined, TOKEN);
    const status = (await get("/status")).json;
    assert.deepEqual([status.mode, status.today.started, status.today.limit, status.narrowing, status.estimates.hard.generate.seconds], ["fake", 0, 20, true, 125]);
    const jobs = (await get("/jobs")).json;
    assert.deepEqual([jobs.jobs[0].jobCode, jobs.jobs[0].selectableSentenceCount, jobs.jobs[0].catalog], ["K900000001", 2, { missionCount: 0, addedByAdminCount: 0 }]);
    const sentences = (await get("/jobs/K900000001/sentences")).json;
    assert.deepEqual([sentences.sentences.length, sentences.sentences[0].units[0].isDefault, sentences.sentences[0].existingDifficulties], [3, true, []]);
    assert.deepEqual((await get("/material-types?jobCode=K900000001&execJobId=exec_001&unitKey=90000001:01&difficulty=easy")).json, { narrowing: true, allowedMaterialTypes: ["table", "memo"] });

    const started = await c.request("POST", `${BASE}/runs`, PICK, TOKEN);
    assert.deepEqual([started.status, started.json.run.status], [202, "running"]);
    const runId = started.json.run.runId;
    const ready = await waitForRun(c, runId);
    assert.equal(ready.status, "ready");
    assert.equal(AdminGenerationRunViewSchema.safeParse(ready).success, true);
    const listed = (await get("/runs")).json.runs[0];
    assert.deepEqual([listed.runId, "mission" in listed, "basis" in listed, "logs" in listed], [runId, false, false, false]);

    const added = await c.request("POST", `${BASE}/runs/${runId}/catalog`, {}, TOKEN);
    const key = added.json.run.catalog.key;
    assert.equal(key, "jobsim_admin_v1__mission_K900000001_normal_001");
    assert.deepEqual((await get("/jobs/K900000001/sentences")).json.sentences[0].existingDifficulties, ["normal"]);
    assert.equal((await get("/jobs")).json.jobs[0].catalog.addedByAdminCount, 1);
    assert.equal((await c.get("/api/bootstrap")).json.allMissions.some((m: any) => m.key === key), true);
    assert.equal((await get("/catalog")).json.total.addedByAdmin, 1);

    const removed = await c.request("DELETE", `${BASE}/catalog/${key}`, undefined, TOKEN);
    assert.deepEqual([removed.status, removed.json], [200, { ok: true, missionKey: key, runId }]);
    assert.equal((await get(`/runs/${runId}`)).json.run.status, "ready");
    assert.equal((await c.get("/api/bootstrap")).json.allMissions.some((m: any) => m.key === key), false);

    assert.equal((await c.request("DELETE", `${BASE}/runs/${runId}`, undefined, TOKEN)).status, 200);
    const gone = await get(`/runs/${runId}`);
    assert.deepEqual([gone.status, gone.json.error.code], [404, "GENERATION_RUN_NOT_FOUND"]);
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("관리자 생성 경로: 조회 전용 열기는 읽기만 열고, 잘못된 요청은 같은 오류 형식으로 거절한다", async () => {
  const ws = makeAdminWorkspace();
  const commands = (config: ServerConfig, ncs: NcsCatalog) => testCommands({ config, ncs });
  const demo = await startTestServer({ configure: (c) => useWorkspace(c, ws, true), generationCommands: commands });
  try {
    const c = new Client(demo.base);
    for (const url of ["/status", "/jobs", "/runs", "/catalog"]) assert.equal((await c.get(`${BASE}${url}`)).status, 200, url);
    for (const [method, url] of [["POST", "/runs"], ["POST", "/runs/x/catalog"], ["POST", "/runs/x/review"], ["DELETE", "/runs/x"], ["DELETE", "/catalog/x"]]) {
      const res = await c.request(method, `${BASE}${url}`, method === "POST" ? PICK : undefined);
      assert.deepEqual([res.status, res.json.error.code], [401, "AUTH_REQUIRED"], `${method} ${url}`);
    }
    // 암호 없이 볼 때는 기대 답 · 채점 기준(evaluation)과 풀어 본 답을 빼고 준다. 암호가 있으면 그대로 준다.
    const started = await c.request("POST", `${BASE}/runs`, PICK, TOKEN);
    const withToken = await waitForRun(c, started.json.run.runId);
    const open = (await c.get(`${BASE}/runs/${withToken.runId}`)).json.run;
    assert.deepEqual(
      ["evaluation" in open.mission, "answers" in open.reviewRecord.solver_result, "evaluation" in withToken.mission, "answers" in withToken.reviewRecord.solver_result],
      [false, false, true, true]
    );
  } finally {
    await demo.close();
  }

  const locked = await startTestServer({ configure: (c) => useWorkspace(c, ws, false), generationCommands: commands });
  try {
    const c = new Client(locked.base);
    assert.equal((await c.get(`${BASE}/jobs`)).status, 401);
    const cases: Array<[string, string, unknown, number, string | null]> = [
      ["POST", "/runs", { jobCode: "K900000001", difficulty: "easy" }, 400, "GENERATION_BAD_REQUEST"],
      ["POST", "/runs", { ...PICK, allowedMaterialTypes: ["chart"] }, 400, "GENERATION_BAD_REQUEST"],
      ["POST", "/runs", { ...PICK, unitKey: "../x" }, 400, "GENERATION_BAD_REQUEST"],
      ["GET", "/material-types?jobCode=K900000001", undefined, 400, "GENERATION_BAD_REQUEST"],
      ["GET", "/jobs/K999999999/sentences", undefined, 404, "GENERATION_JOB_NOT_FOUND"],
      ["GET", "/runs/not-a-uuid", undefined, 404, "GENERATION_RUN_NOT_FOUND"],
      ["DELETE", "/runs/not-a-uuid", undefined, 404, "GENERATION_RUN_NOT_FOUND"],
      ["DELETE", `/catalog/${ws.seedMissionKey}`, undefined, 403, "CATALOG_MISSION_PROTECTED"]
    ];
    for (const [method, url, body, statusCode, code] of cases) {
      const res = await c.request(method, `${BASE}${url}`, body, TOKEN);
      assert.deepEqual([res.status, res.json.error.code], [statusCode, code], `${method} ${url}`);
      assert.ok(res.json.error.message, `${method} ${url} message`);
    }
  } finally {
    await locked.close();
    ws.cleanup();
  }
});
