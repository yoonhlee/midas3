import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./src/lib/db/database.js";
import { deleteStaleAnonymousAttempts } from "./src/lib/db/repos.js";
import { purgeExpiredAuthData } from "./src/lib/auth/session.js";
import { loadJobsCatalog } from "./src/lib/jobs/catalog.js";
import { loadPostingsConfig } from "./src/lib/postings/config.js";
import { startPostingsScheduler } from "./src/lib/postings/scheduler.js";
import { PostingsService } from "./src/lib/postings/service.js";
import { buildJobWeightCatalog } from "./src/lib/recommendation/engine.js";
import { createApp } from "./src/server/app.js";
import { loadServerConfig } from "./src/server/config.js";
import { MissionStore } from "./src/server/missionStore.js";

// 서버 시작: 설정을 읽고, 앱을 만들고, 주기 작업(공고 갱신·만료 데이터 정리)을 건다.
const config = loadServerConfig();
const db = openDatabase(config.dbPath);
const postingsConfig = loadPostingsConfig();
const postingsService = new PostingsService(postingsConfig);
const jobWeightCatalog = buildJobWeightCatalog(
  JSON.parse(fs.readFileSync(path.join(config.paths.root, "data/processed/job_weights.json"), "utf8")) as unknown
);

const app = createApp({
  config,
  db,
  missionStore: new MissionStore(config.paths.missions),
  jobWeightCatalog,
  jobsCatalog: loadJobsCatalog(config.paths.jobsData),
  postingsConfig,
  postingsService
});

function purgeExpired() {
  try {
    purgeExpiredAuthData(db, { idleDays: config.auth.sessionIdleDays, maxDays: config.auth.sessionMaxDays });
    const before = new Date(Date.now() - config.auth.anonymousRetentionHours * 60 * 60 * 1000).toISOString();
    deleteStaleAnonymousAttempts(db, before);
  } catch (error) {
    console.error("[db] purge failed:", (error as Error).message);
  }
}

app.listen(config.port, () => {
  console.log(`JOBSIM server running at http://localhost:${config.port}`);
  if (config.appEnv === "production" && !config.cookieSecure) {
    console.warn("[auth] 운영 환경인데 쿠키 Secure가 꺼져 있어. PUBLIC_BASE_URL을 https로 두거나 COOKIE_SECURE=true로 설정해.");
  }
  startPostingsScheduler(postingsService);
  purgeExpired();
  setInterval(purgeExpired, 60 * 60 * 1000).unref();
});
