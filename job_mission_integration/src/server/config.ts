import path from "node:path";
import { fileURLToPath } from "node:url";

// 서버 전역 설정. 환경변수는 여기서 한 번만 읽는다.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const TRUTHY = new Set(["1", "true", "yes", "on"]);
export function envFlag(raw: string | undefined, fallback = false) {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return TRUTHY.has(value);
}

export function positiveIntFromEnv(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export interface ServerConfig {
  port: number;
  appEnv: "production" | "development" | "test";
  publicBaseUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  paths: {
    root: string;
    reports: string;
    missions: string;
    outputs: string;
    apiRaw: string;
    additionalSearch: string;
    app: string;
    jobsData: string;
  };
  dbPath: string;
  openai: { evalModel: string; generationModel: string; preflightTimeoutMs: number };
  admin: { password: string; demoUnlock: boolean };
  compatibilityGamma: number;
  evaluateRateLimit: { windowMs: number; max: number };
  evaluationLogRetentionDays: number;
  auth: {
    devLogin: boolean;
    kakaoClientId: string;
    kakaoClientSecret: string;
    kakaoAdminKey: string;
    kakaoRedirectUri: string;
    sessionIdleDays: number;
    sessionMaxDays: number;
    anonymousRetentionHours: number;
  };
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawEnv = (env.APP_ENV ?? env.NODE_ENV ?? "development").trim().toLowerCase();
  const appEnv = rawEnv === "production" ? "production" : rawEnv === "test" ? "test" : "development";
  const port = Number(env.PORT ?? 8080);
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).trim().replace(/\/+$/, "");
  const reports = path.join(ROOT_DIR, "reports");
  const dbPathRaw = (env.DATABASE_PATH ?? "").trim();
  return {
    port,
    appEnv,
    publicBaseUrl,
    cookieSecure: env.COOKIE_SECURE !== undefined ? envFlag(env.COOKIE_SECURE) : publicBaseUrl.startsWith("https://"),
    trustProxy: envFlag(env.TRUST_PROXY, false),
    paths: {
      root: ROOT_DIR,
      reports,
      missions: path.join(ROOT_DIR, "missions"),
      outputs: path.join(ROOT_DIR, "outputs"),
      apiRaw: path.join(ROOT_DIR, "data/api_raw"),
      additionalSearch: path.join(ROOT_DIR, "data/additional_search"),
      app: path.join(ROOT_DIR, "app"),
      jobsData: path.join(ROOT_DIR, "data/jobs")
    },
    // DB 파일은 쓰기 가능한 reports 볼륨 아래에 둔다(Docker 배포 기준).
    dbPath: dbPathRaw === ":memory:" ? ":memory:" : path.resolve(ROOT_DIR, dbPathRaw || path.join(reports, "jobsim.sqlite")),
    openai: {
      evalModel: env.OPENAI_EVAL_MODEL ?? "gpt-5-nano",
      generationModel: env.OPENAI_GENERATION_MODEL ?? "gpt-5.4-nano",
      preflightTimeoutMs: Math.max(1_000, positiveIntFromEnv(env.OPENAI_PREFLIGHT_TIMEOUT_MS, 15_000))
    },
    admin: {
      password: (env.ADMIN_PASSWORD ?? "").trim(),
      demoUnlock: envFlag(env.ADMIN_DEMO_UNLOCK)
    },
    compatibilityGamma: Number(env.COMPATIBILITY_SCORE_GAMMA ?? 1.5),
    evaluateRateLimit: {
      windowMs: Math.max(1_000, positiveIntFromEnv(env.EVALUATE_RATE_LIMIT_WINDOW_MS, 60_000)),
      // 연속 채점 요청이 정상 사용 흐름을 막지 않도록 기본 허용량을 조금 넉넉하게 둔다.
      max: positiveIntFromEnv(env.EVALUATE_RATE_LIMIT_MAX, 30)
    },
    evaluationLogRetentionDays: positiveIntFromEnv(env.EVALUATION_LOG_RETENTION_DAYS, 14),
    auth: {
      // 개발·테스트용 로그인은 운영(APP_ENV=production)에서는 설정과 상관없이 꺼진다.
      devLogin: envFlag(env.AUTH_DEV_LOGIN) && appEnv !== "production",
      kakaoClientId: (env.KAKAO_LOGIN_CLIENT_ID ?? "").trim(),
      kakaoClientSecret: (env.KAKAO_LOGIN_CLIENT_SECRET ?? "").trim(),
      kakaoAdminKey: (env.KAKAO_ADMIN_KEY ?? "").trim(),
      kakaoRedirectUri: (env.KAKAO_LOGIN_REDIRECT_URI ?? `${publicBaseUrl}/auth/kakao/callback`).trim(),
      sessionIdleDays: positiveIntFromEnv(env.SESSION_IDLE_DAYS, 7),
      sessionMaxDays: positiveIntFromEnv(env.SESSION_MAX_DAYS, 30),
      anonymousRetentionHours: positiveIntFromEnv(env.ANONYMOUS_RESULT_RETENTION_HOURS, 24)
    }
  };
}
