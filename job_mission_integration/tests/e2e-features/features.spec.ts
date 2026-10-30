import { test, expect, type Page } from "@playwright/test";

// 고정 데이터 기준: 데이터분석가(체험 가능, 고정 공고 11건·상세 직무내용 3건)
const JOB = "K000001080";
const ANSWER = "먼저 지난 4주 방문자 수 데이터를 요일별로 비교하겠습니다. 어제 수치가 평균보다 30% 낮은 원인을 가설로 세우고, 집계 기간 조건이 맞는지 확인하겠습니다. 팀에는 우선순위를 정해 보고하겠습니다.";

// 외부 요청(웹폰트·지도 타일)은 네트워크와 무관하게 빈 응답으로 막는다.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
async function stubExternal(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => {
    const url = route.request().url();
    if (url.includes("tile.openstreetmap.org")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX });
    if (url.endsWith(".css") || url.includes("fonts.googleapis")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.fulfill({ status: 200, body: "" });
  });
}

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    // 로그인 전 /api/me 401, 저장된 답안 없음 404 같은 의도된 응답은 빼고 본다.
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  return errors;
}

async function devSignup(page: Page, id: string, nickname: string, returnTo = "/me.html") {
  await page.goto(`/login.html?return=${encodeURIComponent(returnTo)}`);
  await page.locator("#dev-id").fill(id);
  await page.locator("#dev-form button[type=submit]").click();
  await page.waitForURL(/step=signup/);
  await page.locator("#nickname").fill(nickname);
  await page.locator("#agree-terms").check();
  await page.locator("#agree-privacy").check();
  await page.locator("#confirm-age").check();
  await page.locator("#signup-form button[type=submit]").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login.html"));
}

async function playToResult(page: Page, { fromJobLink = false } = {}) {
  if (!fromJobLink) {
    await page.goto("/");
    await page.locator(`.jc[data-jc="${JOB}"]`).click();
    await page.locator("#btn-start").click();
  }
  await page.locator('input[name="pq-interest"][value="2"]').check();
  await page.locator("#btn-pnext").click();
  await page.locator(".mc").first().click();
  await page.locator("#btn-ml-start").click();
  await expect(page.locator("#work-request")).toContainText("업무 요청서");
  await page.locator("#m-ans").fill(ANSWER);
  await page.locator("#btn-mnext").click();
  await expect(page.locator("#btn-restart")).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await stubExternal(page);
});

test("직무 탐색: 537개 목록, 이름·일상어 검색, 분야 필터, 상태 유지, 결과 없음 안내, 최근 본 직무", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/jobs.html");
  await expect(page.locator("#total")).toHaveText("537");
  await page.locator("#q").fill("데이터분석");
  await expect(page.locator(".job-card").first()).toContainText("데이터분석가");
  // 일상어 검색(U04-3): "숫자 다루는"처럼 직업명에 없는 말
  await page.locator("#q").fill("그림");
  await expect(page.locator("#count")).not.toHaveText("0개 직무");
  // 결과 없음 안내
  await page.locator("#q").fill("zzqqxx없는말");
  await expect(page.locator(".empty")).toContainText("이런 말로도 찾아봐");
  // 상태 유지: 검색어·체험 가능 필터가 URL에 남고, 상세에서 돌아와도 그대로
  await page.locator("#q").fill("분석");
  await page.locator("#exp").check();
  await expect(page).toHaveURL(/q=%EB%B6%84%EC%84%9D|q=분석/);
  await page.locator(".job-card a.name").first().click();
  await expect(page.locator("h1.page-h")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#q")).toHaveValue("분석");
  await expect(page.locator("#exp")).toBeChecked();
  await expect(page.locator("#recent")).toContainText("최근 본 직무");
  expect(errors).toEqual([]);
});

test("직무 상세: 하는 일·역량·환경·임금·전망·출처, 비슷한 직무, 체험 불가 안내, 대표 이미지", async ({ page }) => {
  await page.goto(`/job.html?code=${JOB}`);
  for (const heading of ["하는 일", "필요한 역량", "근무 환경", "임금·만족도·전망", "비슷한 일을 하는 직무"]) {
    await expect(page.locator("h2.sec-h", { hasText: heading })).toBeVisible();
  }
  await expect(page.locator(".source")).toContainText("출처");
  await expect(page.locator("svg.job-img").first()).toBeVisible();
  await expect(page.locator("#similar a").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "이 직무 체험하기" })).toHaveAttribute("href", `/index.html?job=${JOB}#simulation`);
  // 역량 탭: 직업 내 중요도 순 ↔ 다른 직업과 비교
  await page.locator('[data-tab="knowledge"]').click();
  await expect(page.locator('[data-tab="knowledge"]')).toHaveAttribute("aria-selected", "true");

  // U11 새 체험 직무(인사·교육·훈련사무원): 체험 링크 → 업무 요청서 형식 미션
  await page.goto("/job.html?code=K000001196");
  await page.getByRole("link", { name: "이 직무 체험하기" }).click();
  await page.locator("#btn-pnext").click();
  await expect(page.locator(".mc")).toHaveCount(3);
  await page.locator(".mc").first().click();
  await page.locator("#btn-ml-start").click();
  await expect(page.locator("#work-request")).toContainText("인사팀");

  // U05-1 체험 미션이 없는 직무(항공기정비원)
  await page.goto("/job.html?code=K000000822");
  await expect(page.locator("h1.page-h")).toHaveText("항공기정비원");
  await expect(page.locator("#no-experience")).toBeVisible();
  await expect(page.getByRole("link", { name: "이 직무 체험하기" })).toHaveCount(0);
});

test("비교: 최대 3개, 브라우저에 유지, 적합도 점수 없음", async ({ page }) => {
  await page.goto("/jobs.html?q=%EB%B6%84%EC%84%9D");
  const buttons = page.locator("[data-compare]");
  await buttons.nth(0).click();
  await buttons.nth(1).click();
  await page.goto("/compare.html");
  await expect(page.locator("table.compare thead th")).toHaveCount(3);
  await expect(page.locator("table.compare")).not.toContainText("적합도");
  await page.reload();
  await expect(page.locator("table.compare thead th")).toHaveCount(3);
  await page.locator("[data-remove]").first().click();
  await expect(page.locator("table.compare thead th")).toHaveCount(2);
});

test("로그인 전 체험 → 결과 확장(해석·근거·흥미 변화·재도전·다음 미션·요구역량·강점·카드) → 로그인하면 내 기록으로", async ({ page }) => {
  const errors = trackErrors(page);
  await playToResult(page);

  await expect(page.locator("#save-status")).toContainText("로그인하면 이 결과를 내 기록에 저장");
  await expect(page.getByText("가짜 채점 모드")).toBeVisible();

  // U17 결과 해석
  const interp = page.locator("#interpretation");
  await expect(interp).toContainText("수행 수준");
  await expect(interp).toContainText("직무 유사도");
  await expect(interp).toContainText("측정 범위");

  // U19 근거 문장 강조
  const highlight = page.locator("#evidence-highlight");
  await expect(highlight.locator("mark").first()).toBeVisible();
  const second = highlight.locator(".hl-btn").nth(1);
  if (await second.count()) {
    await second.click();
    await expect(second).toHaveAttribute("aria-pressed", "true");
  }

  // U22 체험 후 질문 → 흥미 변화
  await page.locator('#post-survey input[name="sr-interest"][value="4"]').check();
  await page.locator('#post-survey input[name="sr-difficulty"][value="3"]').check();
  await page.locator('#post-survey input[name="sr-again"][value="yes"]').check();
  await page.locator("#btn-survey-save").click();
  await expect(page.locator("#interest-change")).toContainText("체험 전 2");
  await expect(page.locator("#interest-change")).toContainText("+2");

  // U20 다음 미션, U25 요구역량, U24 강점 직무
  await expect(page.locator("#next-missions .next-card").first()).toBeVisible();
  await expect(page.locator("#req-compare")).toContainText("직무내용(3건)");
  await expect(page.locator("#req-compare .req-row")).toHaveCount(5);
  await expect(page.locator("#strength-jobs .next-card").first()).toBeVisible();

  // U03 PNG 결과 카드
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#btn-card-png").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^jobsim-result-\d{8}\.png$/);

  // U21 해설 보고 재도전
  await page.locator("#btn-retry-open").click();
  await expect(page.locator("#retry-ans")).toBeVisible();
  await expect(page.getByText("기대 답안 방향")).toBeVisible();
  await page.locator("#retry-ans").fill(`${ANSWER} 고객 불만 데이터도 함께 관찰해서 원인을 좁히고, 담당자별 역할을 나눠 일정을 조율하겠습니다.`);
  await page.locator("#btn-retry-submit").click();
  await expect(page.locator("#retry-result")).toContainText("재도전 점수 변화");
  await expect(page.locator("#retry-result svg#retry-radar")).toBeVisible();

  // 로그인하고 저장하기 → 개발용 로그인·가입 → 결과 다시 보기
  const saveLink = page.locator("#save-status a");
  const href = await saveLink.getAttribute("href");
  expect(href).toContain("/login.html?return=");
  await page.goto(href!);
  await page.locator("#dev-id").fill("anon-claim");
  await page.locator("#dev-form button[type=submit]").click();
  await page.waitForURL(/step=signup/);
  await page.locator("#nickname").fill("옮김테스트");
  await page.locator("#agree-terms").check();
  await page.locator("#agree-privacy").check();
  await page.locator("#confirm-age").check();
  await page.locator("#signup-form button[type=submit]").click();
  await expect(page.locator("#result-status")).toContainText("저장된 결과를 다시 보는 중", { timeout: 20_000 });
  await expect(page.locator("#retry-result")).toContainText("재도전 점수 변화");
  await expect(page.locator("#interest-change")).toContainText("+2");

  await page.goto("/me.html");
  await expect(page.locator(".card.record").first()).toContainText("결과 다시 보기");
  expect(errors).toEqual([]);
});

test("로그인 후 체험: 관심 저장·메모, 답안 자동 저장과 이어 쓰기, 내 기록, 기록 지우기, 탈퇴", async ({ page }) => {
  await devSignup(page, "member1", "체험회원");

  // U06 관심 저장 + 메모
  await page.goto(`/job.html?code=${JOB}`);
  await page.locator('#interest [data-action="save"]').click();
  await page.locator("#memo").fill("데이터로 문제 푸는 게 재밌어 보여");
  await page.locator('#interest [data-action="memo"]').click();
  await page.goto("/me.html");
  await expect(page.locator(".card.interest")).toContainText("데이터분석가");

  // U02-2 쓰던 답안 이어 하기
  await page.goto(`/index.html?job=${JOB}`);
  await page.locator("#btn-pnext").click();
  await page.locator(".mc").first().click();
  await page.locator("#btn-ml-start").click();
  await page.locator("#m-ans").fill("쓰다가 멈춘 답안이야. 나중에 이어서 쓸게.");
  await expect(page.locator("#draft-status")).toContainText("자동 저장됨", { timeout: 10_000 });
  await page.goto("/me.html");
  await page.getByRole("link", { name: "이어 쓰기" }).click();
  await expect(page.locator("#m-ans")).toHaveValue("쓰다가 멈춘 답안이야. 나중에 이어서 쓸게.", { timeout: 10_000 });

  // 제출 → 내 기록에 저장
  await page.locator("#m-ans").fill(ANSWER);
  await page.locator("#btn-mnext").click();
  await expect(page.locator("#save-status")).toContainText("내 기록에 저장됐어", { timeout: 30_000 });

  await page.goto("/me.html");
  await expect(page.getByRole("heading", { name: "쓰던 답안 이어 하기" })).toHaveCount(0);
  const record = page.locator(".card.record").first();
  await expect(record).toContainText("데이터분석가");
  await record.getByRole("link", { name: "결과 다시 보기" }).click();
  await expect(page.locator("#result-status")).toContainText("저장된 결과를 다시 보는 중");
  await expect(page.locator("#interpretation")).toBeVisible();

  // U01-11 기록 개별 삭제
  await page.goto("/me.html");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-del-attempt]").first().click();
  await expect(page.locator("[data-del-attempt]")).toHaveCount(0);

  // 탈퇴
  await page.locator("#withdraw-confirm").fill("탈퇴");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#withdraw-form button[type=submit]").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/me.html") || url.search.includes("withdrawn"));
  const session = await page.request.get("/api/auth/session");
  expect((await session.json()).authenticated).toBe(false);
});

test("해설은 제출 전에는 잠겨 있고, 부팅 카탈로그에도 기대 답안이 없다", async ({ page, request }) => {
  const boot = await (await request.get("/api/bootstrap")).json();
  expect(JSON.stringify(boot)).not.toContain("expected_insights");
  const key = boot.allMissions.find((m: { job_code: string }) => m.job_code === JOB).key;
  const noAttempt = await request.get(`/api/missions/${encodeURIComponent(key)}/explanation`);
  expect(noAttempt.status()).toBe(404);
  const created = await request.post("/api/attempts", { data: { job_codes: [JOB] } });
  const attemptId = (await created.json()).attempt.id;
  const locked = await request.get(`/api/missions/${encodeURIComponent(key)}/explanation?attempt_id=${attemptId}`);
  expect(locked.status()).toBe(403);
  expect((await locked.json()).error.code).toBe("EXPLANATION_LOCKED");
  const missionsStatic = await request.get("/missions/index.json");
  expect(missionsStatic.status()).toBe(404);
  await page.goto("/");
});
