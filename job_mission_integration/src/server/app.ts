import express from "express";
import path from "node:path";
import type { Db } from "../lib/db/database.js";
import type { PostingsConfig } from "../lib/postings/config.js";
import type { PostingsService } from "../lib/postings/service.js";
import type { buildJobWeightCatalog } from "../lib/recommendation/engine.js";
import type { JobsCatalog } from "../lib/jobs/catalog.js";
import type { ServerConfig } from "./config.js";
import { apiErrorHandler, apiNotFound, sameOriginGuard } from "./http.js";
import { loadAuth } from "./authContext.js";
import type { MissionStore } from "./missionStore.js";
import { adminGenerationRouter } from "./routes/adminGeneration.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { meRouter } from "./routes/me.js";
import { missionsRouter } from "./routes/missions.js";
import { postingsRouter } from "./routes/postings.js";

export interface AppContext {
  config: ServerConfig;
  db: Db;
  missionStore: MissionStore;
  jobWeightCatalog: ReturnType<typeof buildJobWeightCatalog>;
  jobsCatalog: JobsCatalog;
  postingsConfig: PostingsConfig;
  postingsService: PostingsService;
  fetchImpl?: typeof fetch;
}

// 라우트 연결만 한다. 기능 코드는 routes/와 src/lib/ 아래에 둔다.
export function createApp(ctx: AppContext) {
  const { config } = ctx;
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(sameOriginGuard(() => [config.publicBaseUrl]));
  app.use(loadAuth(ctx.db, config));

  app.use(express.static(config.paths.app));
  // 미션 JSON 정적 제공 — app/index.html 이 ../missions/* 경로로 fetch 함
  app.use("/missions", express.static(config.paths.missions));
  // 지도 라이브러리는 CDN 없이 node_modules에서 직접 제공한다(발표장 네트워크 대비).
  app.use("/vendor/leaflet", express.static(path.join(config.paths.root, "node_modules/leaflet/dist")));
  app.use("/vendor/leaflet.markercluster", express.static(path.join(config.paths.root, "node_modules/leaflet.markercluster/dist")));

  app.use(healthRouter(config, ctx.db, ctx.postingsService));
  app.use(authRouter({ db: ctx.db, config, fetchImpl: ctx.fetchImpl }));
  app.use(meRouter({ db: ctx.db, config, missionStore: ctx.missionStore, jobsCatalog: ctx.jobsCatalog }));
  app.use(jobsRouter({ jobsCatalog: ctx.jobsCatalog, missionStore: ctx.missionStore, jobWeightCatalog: ctx.jobWeightCatalog, postingsService: ctx.postingsService }));
  app.use(postingsRouter(config, ctx.postingsConfig, ctx.postingsService));
  app.use(missionsRouter({ config, db: ctx.db, missionStore: ctx.missionStore, jobWeightCatalog: ctx.jobWeightCatalog }));
  app.use(adminGenerationRouter(config, ctx.missionStore));

  app.use("/api", apiNotFound());
  app.use(apiErrorHandler());
  return app;
}
