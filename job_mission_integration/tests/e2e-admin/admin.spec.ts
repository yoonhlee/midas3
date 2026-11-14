import { test, expect, type Page } from "@playwright/test";

// 관리자 화면 E2E. 서버는 가짜 생성 · 메모리 DB · 복사한 미션 폴더로 뜬다(playwright.admin.config.ts).
const PASSWORD = "pw";

// 외부 요청(웹폰트)은 네트워크와 무관하게 빈 응답으로 막는다.
async function stubExternal(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => {
    const url = route.request().url();
    if (url.endsWith(".css") || url.includes("fonts.googleapis")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.fulfill({ status: 200, body: "" });
  });
}

async function signIn(page: Page, password: string) {
  await page.getByLabel("암호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "확인" }).click();
}

function menu(page: Page, name: string) {
  return page.locator("aside.side").getByRole("link", { name, exact: true });
}

test.beforeEach(async ({ page }) => {
  await stubExternal(page);
});

test("관리자: 고르기 → 생성 → 근거 → 카탈로그에 추가 → 삭제", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // 암호 "pw"로 들어간다 → 사이드바에 "새 미션 만들기"
  await page.goto("/admin.html");
  await signIn(page, PASSWORD);
  await expect(menu(page, "새 미션 만들기")).toBeVisible();

  // 직업 검색에 "정보보안" → job-item 첫째 → sentence-item 첫째 → start-run
  await page.getByPlaceholder("직업 검색").fill("정보보안");
  const job = page.getByTestId("job-item").first();
  await expect(job).toContainText("정보보안");
  await job.click();
  await page.getByTestId("sentence-item").first().click();
  await expect(page.getByTestId("start-run")).toHaveText("미션 생성");
  await page.getByTestId("start-run").click();

  // 주소가 #/runs/…로 바뀌고 stage가 여섯 개 보인다. 도는 중에 #/runs로 갔다가 history-row 첫째를 눌러 돌아온다
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/);
  const runUrl = page.url();
  await expect(page.getByTestId("stage")).toHaveCount(6);
  await menu(page, "생성 기록").click();
  await expect(page).toHaveURL(/#\/runs$/);
  await page.getByTestId("history-row").first().click();
  await expect(page).toHaveURL(runUrl);

  // run-title이 보일 때까지 기다린다(가짜 모드라 몇 초). preview-part 하나를 누르면 basis-panel의 글이 바뀐다
  await expect(page.getByTestId("run-title")).toBeVisible();
  const basis = page.getByTestId("basis-panel");
  await expect(basis).not.toBeEmpty();
  const before = (await basis.innerText()).trim();
  await page.getByTestId("preview-part").last().click();
  await expect(basis).not.toHaveText(before);

  // add-catalog → "추가됨"이 보인다
  await page.getByTestId("add-catalog").click();
  await expect(page.getByTestId("add-catalog")).toHaveText("추가됨");
  await expect(page.getByTestId("add-catalog")).toBeDisabled();

  // #/catalog → catalog-mission 가운데 "관리자 추가" 표시가 있는 줄이 1개
  await menu(page, "미션 카탈로그").click();
  await expect(page).toHaveURL(/#\/catalog$/);
  const addedRows = page.getByTestId("catalog-mission").filter({ hasText: "관리자 추가" });
  await expect(addedRows).toHaveCount(1);

  // 창을 730×800으로 줄이고 #/runs → history-row의 delete-run 버튼 높이가 40px보다 작다(글자가 세로로 꺾이지 않았다)
  await page.setViewportSize({ width: 730, height: 800 });
  await menu(page, "생성 기록").click();
  const deleteButton = page.getByTestId("history-row").first().getByTestId("delete-run");
  await expect(deleteButton).toHaveText("삭제");
  const box = await deleteButton.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(40);

  // delete-run → 확인 창에 "서비스에서도 빠지고"가 보인다 → confirm-ok
  await deleteButton.click();
  await expect(page.getByRole("alertdialog")).toContainText("서비스에서도 빠지고");
  await page.getByTestId("confirm-ok").click();

  // 목록이 비고("아직 만든 미션이 없습니다."), #/catalog에 "관리자 추가" 줄이 0개
  await expect(page.getByText("아직 만든 미션이 없습니다.")).toBeVisible();
  await expect(page.getByTestId("history-row")).toHaveCount(0);
  await menu(page, "미션 카탈로그").click();
  await expect(page.getByTestId("catalog-mission")).not.toHaveCount(0);
  await expect(addedRows).toHaveCount(0);

  // 처음부터 끝까지 pageerror가 없다
  expect(errors).toEqual([]);
});

test("관리자: 암호가 틀리면 들어가지 못한다", async ({ page }) => {
  // 틀린 암호 → auth-error에 "암호가 올바르지 않습니다." 사이드바가 없다
  await page.goto("/admin.html");
  await signIn(page, "wrong-password");
  await expect(page.getByTestId("auth-error")).toHaveText("암호가 올바르지 않습니다.");
  await expect(page.locator("aside.side")).toHaveCount(0);

  // 맞는 암호 → 사이드바가 보인다. 로그아웃 → 다시 암호 화면
  await signIn(page, PASSWORD);
  await expect(page.locator("aside.side")).toBeVisible();
  await page.locator("aside.side").getByRole("button", { name: "로그아웃" }).click();
  await expect(page.getByLabel("암호", { exact: true })).toBeVisible();
  await expect(page.locator("aside.side")).toHaveCount(0);
});
