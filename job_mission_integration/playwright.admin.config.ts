import { defineConfig, devices } from "@playwright/test";

// 관리자 화면 E2E. 외부 API 없이 돈다:
// 가짜 생성(ADMIN_GENERATION_MODE=fake), 가짜 채점(EVAL_MODE=fake), 고정 공고(POSTINGS_FIXTURE), 메모리 DB,
// 미션 폴더는 test-results/admin-missions(missions/의 복사본)를 쓴다.
export default defineConfig({
  testDir: "./tests/e2e-admin",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8093",
    trace: "on-first-retry",
    acceptDownloads: true,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
  },
  webServer: {
    command: "node scripts/prepare-admin-e2e.mjs && npm run dev",
    url: "http://localhost:8093/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: "8093",
      PUBLIC_BASE_URL: "http://localhost:8093",
      EVAL_MODE: "fake",
      DATABASE_PATH: ":memory:",
      ADMIN_PASSWORD: "pw",
      ADMIN_GENERATION_MODE: "fake",
      MISSIONS_DIR: "test-results/admin-missions",
      POSTINGS_FIXTURE: "1",
      POSTINGS_DATA_DIR: "test-results/admin-postings",
      OPENAI_API_KEY: "",
      KAKAO_LOGIN_CLIENT_ID: ""
    }
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } }
  ]
});
