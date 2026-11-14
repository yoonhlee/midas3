import { defineConfig, devices } from "@playwright/test";

// 기능 지도 E2E(탐색·상세·비교·로그인·기록·재도전·결과 카드). 외부 API 없이 돈다:
// 가짜 채점(EVAL_MODE=fake), 개발용 로그인(AUTH_DEV_LOGIN), 고정 공고(POSTINGS_FIXTURE), 메모리 DB.
export default defineConfig({
  testDir: "./tests/e2e-features",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8092",
    trace: "on-first-retry",
    acceptDownloads: true,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
  },
  webServer: {
    command: "npm run postings:fixture-snapshots && npm run dev",
    url: "http://localhost:8092/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: "8092",
      PUBLIC_BASE_URL: "http://localhost:8092",
      EVAL_MODE: "fake",
      AUTH_DEV_LOGIN: "true",
      DATABASE_PATH: ":memory:",
      POSTINGS_FIXTURE: "1",
      POSTINGS_DATA_DIR: "test-results/features-postings",
      OPENAI_API_KEY: "",
      KAKAO_LOGIN_CLIENT_ID: "",
      ADMIN_PASSWORD: ""
    }
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } }
  ]
});
