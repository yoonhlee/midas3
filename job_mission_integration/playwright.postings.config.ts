import { defineConfig, devices } from "@playwright/test";

// 채용공고 지도 E2E: 고정 데이터로 스냅샷을 만든 뒤 8091 포트로 서버를 띄운다.
export default defineConfig({
  testDir: "./tests/e2e-postings",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8091",
    trace: "on-first-retry",
    // 설치된 Playwright 브라우저 버전이 다른 환경(CI 컨테이너 등)에서는 PW_CHROMIUM_PATH로 실행 파일을 지정한다.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
  },
  webServer: {
    command: "npm run postings:fixture-snapshots && npm run dev",
    url: "http://localhost:8091/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: "8091",
      POSTINGS_FIXTURE: "1",
      POSTINGS_DATA_DIR: "test-results/postings-data",
      // 채점은 휴리스틱으로(외부 LLM 호출 없음)
      OPENAI_API_KEY: ""
    }
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 740 } } }
  ]
});
