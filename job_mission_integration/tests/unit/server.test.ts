import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startTestServer } from "./helpers/testServer.js";
import { checkIdTokenPayload, KakaoAuthError } from "../../src/lib/auth/kakao.js";
import { hashToken, safeReturnTo } from "../../src/lib/auth/session.js";

const MISSION_KEY = "pilot_v1_20260601_173827__mission_K000001080_easy_001";
const GOOD_ANSWER = "체크리스트에서 기간 필터 항목이 issue로 표시돼 있어서 먼저 고쳐야 합니다. 어제 기간 조건이 빠지면 방문자 수 비교가 틀어지니 데이터부터 다시 확인하겠습니다.";

test("공통: /health에 DB 상태, 없는 API는 같은 오류 형식", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const health = await c.get("/health");
    assert.equal(health.json.database.ok, true);
    assert.ok(health.json.database.schema_version >= 1);
    const missing = await c.get("/api/nothing-here");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "NOT_FOUND");
    const badJson = await c.request("POST", "/api/attempts", undefined, { "Content-Type": "application/json" });
    assert.ok([400].includes(badJson.status));
    const raw = await fetch(`${srv.base}/api/attempts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error.code, "BAD_JSON");
  } finally {
    await srv.close();
  }
});

test("공통: 다른 사이트에서 온 상태 변경 요청은 막는다", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const blocked = await c.post("/api/attempts", { job_codes: ["K000001080"] }, { Origin: "http://evil.example" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, "ORIGIN_NOT_ALLOWED");
    const allowed = await c.post("/api/attempts", { job_codes: ["K000001080"] }, { Origin: srv.base });
    assert.equal(allowed.status, 201);
  } finally {
    await srv.close();
  }
});

test("관리자 API: 암호가 없으면 열리지 않고, 시연 잠금 해제는 조회만 허용", async () => {
  const noPassword = await startTestServer({ configure: (c) => { c.admin.password = ""; c.admin.demoUnlock = false; } });
  try {
    const res = await new Client(noPassword.base).get("/api/admin/mission-generation/jobs");
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "ADMIN_PASSWORD_NOT_SET");
  } finally {
    await noPassword.close();
  }
  const demo = await startTestServer({ configure: (c) => { c.admin.password = "pw"; c.admin.demoUnlock = true; } });
  try {
    const c = new Client(demo.base);
    assert.equal((await c.get("/api/admin/mission-generation/jobs")).status, 200);
    const gen = await c.post("/api/admin/mission-generation/runs", { jobCode: "K000001080", difficulty: "easy" });
    assert.equal(gen.status, 401);
    assert.equal((await c.get("/api/admin/postings/status")).status, 401);
    assert.equal((await c.request("GET", "/api/admin/postings/status", undefined, { "x-api-token": "pw" })).status, 200);
  } finally {
    await demo.close();
  }
});

test("로그인: 개발용 로그인 → 약관 동의 가입 → 세션 → 닉네임 변경(CSRF) → 로그아웃", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const first = await c.post("/api/auth/dev-login", { id: "tester1", nickname: "테스터" });
    assert.equal(first.json.status, "signup_required");
    const pending = await c.get("/api/auth/signup");
    assert.equal(pending.json.nickname, "테스터");
    const noConsent = await c.post("/api/auth/signup", { nickname: "테스터", agreeTerms: true, agreePrivacy: false, confirmAge14: true });
    assert.equal(noConsent.status, 400);
    // 동의 실패로 가입 대기가 사라지지 않았는지
    assert.equal((await c.get("/api/auth/signup")).status, 200);
    const signup = await c.post("/api/auth/signup", { nickname: "테스터", agreeTerms: true, agreePrivacy: true, confirmAge14: true });
    assert.equal(signup.status, 201);
    const session = await c.refreshCsrf();
    assert.equal(session.authenticated, true);
    assert.equal(session.user.nickname, "테스터");

    const savedCsrf = c.csrf;
    c.csrf = null;
    assert.equal((await c.patch("/api/me", { nickname: "새이름" })).status, 403);
    c.csrf = savedCsrf;
    assert.equal((await c.patch("/api/me", { nickname: "!" })).status, 400);
    assert.equal((await c.patch("/api/me", { nickname: "새이름" })).json.user.nickname, "새이름");

    // 다시 로그인하면 가입 없이 바로 로그인
    const again = await new Client(srv.base).post("/api/auth/dev-login", { id: "tester1" });
    assert.equal(again.json.status, "logged_in");

    assert.equal((await c.post("/api/auth/logout")).status, 200);
    assert.equal((await c.refreshCsrf()).authenticated, false);
  } finally {
    await srv.close();
  }
});

test("로그인: 개발용 로그인은 운영 설정에서 꺼진다", async () => {
  const srv = await startTestServer({ env: { APP_ENV: "production", AUTH_DEV_LOGIN: "true" } });
  try {
    const res = await new Client(srv.base).post("/api/auth/dev-login", { id: "x1" });
    assert.equal(res.status, 404);
    assert.equal((await new Client(srv.base).get("/api/auth/session")).json.providers.dev, false);
  } finally {
    await srv.close();
  }
});

test("로그인: 세션은 해시로 저장되고 유휴 기간이 지나면 끊긴다", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    await c.devSignup("idle1");
    const token = c.cookies.get("jobsim_sid")!;
    const row = srv.db.prepare("SELECT id_hash FROM sessions").get() as { id_hash: string };
    assert.equal(row.id_hash, hashToken(token));
    assert.notEqual(row.id_hash, token);
    srv.db.prepare("UPDATE sessions SET last_seen_at = ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
    assert.equal((await c.refreshCsrf()).authenticated, false);
  } finally {
    await srv.close();
  }
});

function kakaoFetch(record: string[], overrides: { nonce?: () => string; sub?: string } = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    record.push(url);
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (url.endsWith("/oauth/token")) {
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.ok(body.get("code_verifier"));
      return new Response(JSON.stringify({ id_token: "fake.id.token", access_token: "at" }), { status: 200 });
    }
    if (url.endsWith("/oauth/tokeninfo")) {
      return new Response(JSON.stringify({
        iss: "https://kauth.kakao.com",
        aud: "kakao-client",
        sub: overrides.sub ?? "12345",
        exp: Math.floor(Date.now() / 1000) + 600,
        nonce: overrides.nonce?.() ?? "",
        nickname: "카카오친구"
      }), { status: 200 });
    }
    if (url.endsWith("/v1/user/unlink")) {
      assert.equal((init?.headers as Record<string, string>).Authorization, "KakaoAK admin-key");
      return new Response(JSON.stringify({ id: 12345 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("카카오 로그인: 시작 → 콜백 → 가입 → 재로그인, 취소·만료 안내, 탈퇴 시 연결 끊기", async () => {
  const calls: string[] = [];
  let nonce = "";
  const srv = await startTestServer({
    env: { KAKAO_LOGIN_CLIENT_ID: "kakao-client", KAKAO_ADMIN_KEY: "admin-key" },
    fetchImpl: kakaoFetch(calls, { nonce: () => nonce })
  });
  try {
    const c = new Client(srv.base);
    assert.equal((await c.get("/api/auth/session")).json.providers.kakao, true);

    const start = await c.get("/auth/kakao/start?return=/jobs.html");
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(authorize.host, "kauth.kakao.com");
    assert.equal(authorize.searchParams.get("client_id"), "kakao-client");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    nonce = authorize.searchParams.get("nonce")!;
    const state = authorize.searchParams.get("state")!;

    const callback = await c.get(`/auth/kakao/callback?code=abc&state=${state}`);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/login.html?step=signup");
    assert.equal((await c.get("/api/auth/signup")).json.nickname, "카카오친구");
    await c.post("/api/auth/signup", { nickname: "카카오친구", agreeTerms: true, agreePrivacy: true, confirmAge14: true });
    assert.equal((await c.refreshCsrf()).user.provider, "kakao");

    // 같은 계정으로 다시 로그인: 가입 없이 원래 페이지로
    const c2 = new Client(srv.base);
    const start2 = await c2.get("/auth/kakao/start?return=/jobs.html");
    const auth2 = new URL(start2.headers.get("location")!);
    nonce = auth2.searchParams.get("nonce")!;
    const cb2 = await c2.get(`/auth/kakao/callback?code=abc&state=${auth2.searchParams.get("state")}`);
    assert.equal(cb2.headers.get("location"), "/jobs.html");

    // 동의 화면에서 취소
    const c3 = new Client(srv.base);
    await c3.get("/auth/kakao/start?return=/me.html");
    const cancelled = await c3.get("/auth/kakao/callback?error=access_denied&state=x");
    assert.match(cancelled.headers.get("location")!, /error=cancelled/);
    // state가 맞지 않음
    const c4 = new Client(srv.base);
    await c4.get("/auth/kakao/start");
    const expired = await c4.get("/auth/kakao/callback?code=abc&state=wrong");
    assert.match(expired.headers.get("location")!, /error=expired/);

    // 탈퇴: 확인 문구가 필요하고, 카카오 연결 끊기 후 기록 삭제
    await c.put("/api/me/interests/K000001080", { memo: "궁금" });
    assert.equal((await c.del("/api/me", {})).status, 400);
    const withdraw = await c.del("/api/me", { confirm: "탈퇴" });
    assert.equal(withdraw.json.kakao_unlink, "done");
    assert.ok(calls.some((u) => u.endsWith("/v1/user/unlink")));
    assert.equal((srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE provider = 'kakao'").get() as { n: number }).n, 0);
    assert.equal((srv.db.prepare("SELECT COUNT(*) AS n FROM interests").get() as { n: number }).n, 0);
    assert.equal((await c.refreshCsrf()).authenticated, false);
  } finally {
    await srv.close();
  }
});

test("카카오 ID 토큰 확인: 발급자·대상·nonce·만료", () => {
  const ok = { iss: "https://kauth.kakao.com", aud: "app", sub: "1", nonce: "n", exp: Date.now() / 1000 + 60 };
  assert.equal(checkIdTokenPayload(ok, { clientId: "app", nonce: "n" }).sub, "1");
  assert.throws(() => checkIdTokenPayload({ ...ok, iss: "x" }, { clientId: "app", nonce: "n" }), KakaoAuthError);
  assert.throws(() => checkIdTokenPayload({ ...ok, aud: "other" }, { clientId: "app", nonce: "n" }), KakaoAuthError);
  assert.throws(() => checkIdTokenPayload({ ...ok, nonce: "m" }, { clientId: "app", nonce: "n" }), KakaoAuthError);
  assert.throws(() => checkIdTokenPayload({ ...ok, exp: 1 }, { clientId: "app", nonce: "n" }), KakaoAuthError);
});

test("돌아갈 주소는 같은 사이트 상대 경로만", () => {
  assert.equal(safeReturnTo("/jobs.html?q=1"), "/jobs.html?q=1");
  assert.equal(safeReturnTo("https://evil.example"), "/me.html");
  assert.equal(safeReturnTo("//evil.example"), "/me.html");
  assert.equal(safeReturnTo(undefined, "/"), "/");
});

test("체험 기록: 로그인 전 결과는 브라우저에 묶였다가 로그인하면 내 기록으로 옮겨진다", async () => {
  const srv = await startTestServer();
  const anon = new Client(srv.base);
  try {
    const attempt = (await anon.post("/api/attempts", { job_codes: ["K000001080"], pre_answers: { K000001080: { q1: "데이터 정리" } } })).json.attempt;
    assert.equal(attempt.saved_to_account, false);
    const evaluated = await anon.post("/api/evaluate", { mission_key: MISSION_KEY, answer: GOOD_ANSWER, attempt_id: attempt.id });
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.json.scoring.mode, "fake");
    assert.equal(evaluated.json.scoring.server_mission, true);
    assert.ok(evaluated.json.attempt_mission_id);
    assert.equal(evaluated.json.evaluation.source, "fake");
    const quotes = Object.values(evaluated.json.evaluation.axes).flatMap((axis: any) => axis.evidence.map((e: any) => e.quote));
    assert.ok(quotes.every((q: string) => GOOD_ANSWER.includes(q)));

    const snapshot = { selectedJobs: ["K000001080"], preqAnswers: {}, missionScores: { K000001080: [evaluated.json.missionScore] }, evaluationLogs: [], resultSummary: null };
    assert.equal((await anon.post(`/api/attempts/${attempt.id}/complete`, { snapshot })).status, 200);
    const got = await anon.get(`/api/attempts/${attempt.id}`);
    assert.equal(got.json.missions.length, 1);
    assert.equal(got.json.missions[0].mission_outdated, false);
    assert.deepEqual(got.json.attempt.result_snapshot.selectedJobs, ["K000001080"]);

    // 다른 사람은 볼 수 없다
    assert.equal((await new Client(srv.base).get(`/api/attempts/${attempt.id}`)).status, 404);
    assert.equal((await anon.get("/api/auth/session")).json.anonymous_results, 1);

    // 같은 브라우저에서 로그인하면 옮겨진다
    await anon.devSignup("mover");
    const summary = await anon.get("/api/me/summary");
    assert.equal(summary.json.counts.attempts, 1);
    assert.equal(summary.json.attempts[0].jobs[0].name, "데이터분석가(빅데이터분석가)");
    assert.deepEqual(summary.json.attempts[0].scoring_modes, ["fake"]);

    // 기록 하나 지우기
    assert.equal((await anon.del(`/api/attempts/${attempt.id}`)).status, 200);
    assert.equal((await anon.get("/api/me/summary")).json.counts.attempts, 0);
  } finally {
    await srv.close();
  }
});

test("채점: 서버에 없는 미션은 거절하고, 남의 기록에는 저장하지 않는다", async () => {
  const srv = await startTestServer();
  try {
    const a = new Client(srv.base);
    const b = new Client(srv.base);
    assert.equal((await a.post("/api/evaluate", { mission_key: "nope", answer: GOOD_ANSWER })).status, 404);
    const attempt = (await a.post("/api/attempts", { job_codes: ["K000001080"] })).json.attempt;
    const stolen = await b.post("/api/evaluate", { mission_key: MISSION_KEY, answer: GOOD_ANSWER, attempt_id: attempt.id });
    assert.equal(stolen.status, 404);
  } finally {
    await srv.close();
  }
});

test("관심 직무·쓰던 답안: 로그인이 필요하고 메모는 100자까지", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    assert.equal((await c.put("/api/me/interests/K000001080", {})).status, 401);
    await c.devSignup("fan");
    assert.equal((await c.put("/api/me/interests/K000001080", { memo: "데이터가 좋아" })).json.interest.memo, "데이터가 좋아");
    assert.equal((await c.put("/api/me/interests/K000001080", { memo: "x".repeat(101) })).status, 400);
    assert.equal((await c.put("/api/me/interests/K999999999", {})).status, 404);
    const summary = await c.get("/api/me/summary");
    assert.equal(summary.json.interests[0].experienceable, true);
    assert.equal((await c.del("/api/me/interests/K000001080")).status, 200);

    assert.equal((await c.put(`/api/me/drafts/${MISSION_KEY}`, { answer: "쓰다 만 답" })).status, 200);
    assert.equal((await c.get(`/api/me/drafts/${MISSION_KEY}`)).json.draft.answer, "쓰다 만 답");
    assert.equal((await c.get("/api/me/summary")).json.drafts[0].mission_available, true);
  } finally {
    await srv.close();
  }
});

test("직무 API: 537개 목록, 상세의 비슷한 직무와 체험 가능 여부, 비교, 강점 축", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const list = await c.get("/api/jobs");
    assert.equal(list.json.total, 537);
    assert.equal(list.json.fields.length, 10);
    assert.equal(list.json.experienceable.length, 5);
    const detail = await c.get("/api/jobs/K000001080");
    assert.equal(detail.json.job.experienceable, true);
    assert.ok(detail.json.job.missions.length >= 1);
    assert.equal(detail.json.job.similar.length, 6);
    assert.ok(detail.json.job.similar[0].common.length > 0);
    // 고정 데이터 모드인데 스냅샷을 아직 만들지 않아 error
    assert.equal(detail.json.job.postings_status, "error");
    assert.equal((await c.get("/api/jobs/K000000824")).json.job.experienceable, false);
    assert.equal((await c.get("/api/jobs/K12")).status, 400);
    assert.equal((await c.get("/api/jobs/K999999999")).status, 404);
    const compare = await c.get("/api/jobs/compare?codes=K000001080,K000000872");
    assert.equal(compare.json.jobs.length, 2);
    assert.equal((await c.get("/api/jobs/compare?codes=K000001080,K000000872,K000000997,K000001179")).status, 400);
    const byAxis = await c.get("/api/jobs/by-axis/AX1");
    assert.ok(byAxis.json.jobs.length > 0);
    assert.equal((await c.get("/api/jobs/by-axis/AX9")).status, 400);
  } finally {
    await srv.close();
  }
});
