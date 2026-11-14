import { test, expect, type Page } from "@playwright/test";

// 고정 데이터(tests/fixtures/postings) 기준 데이터분석가 기대값
const EXPECTED = { total: 11, metro: 6, nonmetro: 4, unknown: 1 };
const JOB = "K000001080";

// 외부 요청(OSM 타일, 웹폰트)은 네트워크와 무관하게 테스트하도록 빈 응답으로 가로챈다.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
async function stubExternal(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => {
    const url = route.request().url();
    if (url.includes("tile.openstreetmap.org")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX });
    if (url.endsWith(".css") || url.includes("fonts.googleapis")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.fulfill({ status: 200, body: "" });
  });
}

async function playToResult(page: Page) {
  await page.locator(`.jc[data-jc="${JOB}"]`).click();
  await page.locator("#btn-start").click();
  await page.locator("#btn-pnext").click();
  await page.locator(".mc").first().click();
  await page.locator("#btn-ml-start").click();
  await page.locator("#m-ans").fill("고객 데이터를 기간별로 나눠 비교하고 이상치의 원인을 가설로 세워 검증하겠습니다.");
  await page.locator("#btn-mnext").click();
  await expect(page.locator("#btn-restart")).toBeVisible({ timeout: 30_000 });
}

test("결과 화면에 채용공고 지도·요약·필터·목록이 보인다", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await stubExternal(page);
  await page.goto("/");

  await playToResult(page);
  const section = page.locator("#postings-section");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("지금 이 일을 뽑는 곳")).toBeVisible();

  const summary = section.locator(".pst-summary");
  await expect(summary).toContainText(`지금 지원할 수 있는 건 ${EXPECTED.total}건`);
  await expect(summary).toContainText(`수도권 ${EXPECTED.metro}건(55%), 비수도권 ${EXPECTED.nonmetro}건`);
  await expect(summary).toContainText(`지역을 알 수 없는 공고는 ${EXPECTED.unknown}건`);
  await expect(summary).toContainText("전남광주(2건)");
  await expect(section.locator(".pst-types")).toHaveText("대기업 2건 · 공공기관 1건");

  await expect(section.locator(".leaflet-container")).toBeVisible();
  await expect(section.locator(".pst-marker, .marker-cluster").first()).toBeVisible();
  await expect(section.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");

  const count = section.locator(".pst-count");
  await expect(count).toHaveAttribute("data-count", String(EXPECTED.total));
  await expect(section.locator(".pst-item")).toHaveCount(10);
  await section.locator(".pst-more").click();
  await expect(section.locator(".pst-item")).toHaveCount(EXPECTED.total);

  await section.locator('[data-pst-region="nonmetro"]').click();
  await expect(count).toHaveAttribute("data-count", String(EXPECTED.nonmetro));
  await expect(section.locator(".pst-item")).toHaveCount(EXPECTED.nonmetro);
  await section.locator('[data-pst-region="metro"]').click();
  await expect(count).toHaveAttribute("data-count", String(EXPECTED.metro));
  await section.locator('[data-pst-ctype="large"]').click();
  await expect(count).toHaveAttribute("data-count", "1");
  await section.locator('[data-pst-region="all"]').click();
  await expect(count).toHaveAttribute("data-count", "2");
  await section.locator('[data-pst-ctype="all"]').click();

  const links = section.locator("a.pst-link");
  expect(await links.count()).toBeGreaterThan(0);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(await link.getAttribute("href")).toMatch(/^https?:\/\//);
  }
  await expect(section.locator(".pst-source")).toContainText("135200 데이터 분석가(빅데이터 분석가)");

  if (testInfo.project.name === "mobile") {
    // 문서 전체 기준(scrollWidth <= clientWidth)은 기존 레이더 차트(resultDashboard.js의 고정 폭 370px SVG) 때문에
    // 360px에서 6px 넘친다. 기존 섹션은 바꾸지 않기로 했으므로, 새 섹션이 가로 스크롤을 만들지 않는지를 검사한다.
    const overflow = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const root = document.getElementById("postings-section")!;
      let maxRight = root.getBoundingClientRect().right;
      root.querySelectorAll("*").forEach((el) => {
        if (el.closest(".leaflet-pane")) return; // 지도 타일은 overflow:hidden 컨테이너 안에서 잘린다
        maxRight = Math.max(maxRight, el.getBoundingClientRect().right);
      });
      return { maxRight, viewport, scroll: root.scrollWidth - root.clientWidth };
    });
    expect(overflow.maxRight).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.scroll).toBeLessThanOrEqual(0);
    const filterHeight = await section.locator(".pst-filter").first().evaluate((el) => el.getBoundingClientRect().height);
    expect(filterHeight).toBeGreaterThanOrEqual(40);
  }
  await section.screenshot({ path: testInfo.outputPath("postings-section.png") });

  // 다시 하기 → 다시 결과까지 가도 지도 오류가 없어야 한다
  await page.locator("#btn-restart").click();
  await playToResult(page);
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator(".leaflet-container")).toBeVisible();
  await expect(section.locator(".pst-count")).toHaveAttribute("data-count", String(EXPECTED.total));
  expect(consoleErrors).toEqual([]);
});

test("직종 미정 직업은 준비 중 안내가 나온다", async ({ page }) => {
  await stubExternal(page);
  const res = await page.request.get("/api/jobs/K000001179/postings");
  expect((await res.json()).status).toBe("unmapped");
  const bad = await page.request.get("/api/jobs/abc/postings");
  expect(bad.status()).toBe(400);
});

test("API 응답에 인증키나 상세주소가 없다", async ({ page }) => {
  const body = await (await page.request.get(`/api/jobs/${JOB}/postings`)).text();
  expect(body).not.toMatch(/authKey|KakaoAK|detailAddr|301호/);
  const health = await (await page.request.get("/health")).json();
  expect(health.postings.fixture).toBe(true);
  expect(typeof health.postings.work24_key_configured).toBe("boolean");
});
