import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const OCCUPATION_MAP_PATH = path.join(PROJECT_ROOT, "data/postings/occupation_map.json");
export const FIXTURE_DIR = path.join(PROJECT_ROOT, "tests/fixtures/postings");

// 고정 데이터 모드에서 마감·등록기간을 판정하는 기준 시각. 고정 XML이 시간이 지나도 같은 결과를 내게 한다.
export const FIXTURE_NOW = new Date("2026-10-26T12:00:00+09:00");

export const REG_DATE_VALUES = ["D-0", "D-3", "W-1", "W-2", "M-1"] as const;
export type RegDate = (typeof REG_DATE_VALUES)[number];

export interface PostingsConfig {
  enabled: boolean;
  fixture: boolean;
  work24Key: string;
  kakaoKey: string;
  dataDir: string;
  regDate: RegDate;
  maxPages: number;
  refreshHours: number;
  requestDelayMs: number;
  // 요구역량 분석(U25)을 위해 직업마다 상세 조회할 공고 수
  detailLimit: number;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function flag(raw: string | undefined, fallback: boolean) {
  const v = (raw ?? "").trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return fallback;
}

function positiveInt(raw: string | undefined, fallback: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function positiveIntOrZero(raw: string | undefined, fallback: number, max: number) {
  if ((raw ?? "").trim() === "0") return 0;
  return positiveInt(raw, fallback, max);
}

export function loadPostingsConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { fixture?: boolean } = {}
): PostingsConfig {
  const fixture = overrides.fixture ?? flag(env.POSTINGS_FIXTURE, false);
  const rawDir = (env.POSTINGS_DATA_DIR ?? "").trim();
  // 고정 데이터 스냅샷이 실제 스냅샷 폴더를 덮어쓰지 않도록 기본 위치를 나눈다.
  const defaultDir = fixture ? "reports/postings-fixture" : "reports/postings";
  const regDate = (env.POSTINGS_REG_DATE ?? "").trim();
  return {
    enabled: flag(env.POSTINGS_ENABLED, true),
    fixture,
    work24Key: (env.WORK24_RECRUIT_AUTH_KEY ?? "").trim(),
    kakaoKey: (env.KAKAO_REST_API_KEY ?? "").trim(),
    dataDir: path.resolve(PROJECT_ROOT, rawDir || defaultDir),
    regDate: (REG_DATE_VALUES as readonly string[]).includes(regDate) ? (regDate as RegDate) : "M-1",
    maxPages: positiveInt(env.POSTINGS_MAX_PAGES, 10, 1000),
    refreshHours: positiveInt(env.POSTINGS_REFRESH_HOURS, 24, 24 * 30),
    requestDelayMs: fixture ? 0 : 300,
    detailLimit: positiveIntOrZero(env.POSTINGS_DETAIL_LIMIT, 10, 100)
  };
}

// 수집을 실제로 돌릴 수 있는 상태인지(고정 데이터 모드이거나 고용24 키가 있음)
export function isCollectable(config: PostingsConfig) {
  return config.enabled && (config.fixture || Boolean(config.work24Key));
}
