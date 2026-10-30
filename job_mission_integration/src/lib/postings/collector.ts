import { analyzeRequirementTexts, type RequirementSummary } from "./requirements.js";
import type { OccupationEntry } from "./occupationMap.js";
import type { ListQuery, RawWanted, Work24Client } from "./work24Client.js";
import { GeocoderConfigError, type Geocoder, type GeoResult } from "./geocoder.js";
import { SIDO_NAMES, isMetro, resolveRegion, type Sido } from "./regions.js";
import {
  applyTitleFilter,
  daysBetween,
  dedupeById,
  isExpired,
  keywordHitRate,
  kstDateString,
  toPublicItem,
  wantedToBaseItem,
  type BaseItem,
  type CompanyType,
  type PostingItem
} from "./parse.js";

export const SNAPSHOT_SCHEMA_VERSION = "job_postings_snapshot.v1";
export const SOURCE_LABEL = "고용24 채용정보 Open API";
export const PAGE_SIZE = 100;
export const REGDATE_WINDOW_DAYS = 32;
export const FILTER_APPLIED_RATIO = 0.95;
export const IGNORED_COTP_MIN_TOTAL = 20;

// coTp 코드 → 화면 기업형태. 03(벤처)·09(청년친화강소기업)는 이번 범위가 아니다.
export const COMPANY_TYPE_CODES: ReadonlyArray<[string, CompanyType]> = [
  ["01", "large"],
  ["04", "public"],
  ["05", "foreign"]
];

export interface SnapshotQuery {
  mode: "code" | "keyword";
  occupation: string[];
  occupation_labels: Array<{ code: string; name: string }>;
  keyword: string | null;
  regDate: string;
  sortOrderBy: "DESC";
  pages_fetched: number;
}

export interface SnapshotChecks {
  // null: 키워드 모드라 검증 대상이 아님
  occupation_filter_applied: boolean | null;
  regdate_filter_applied: boolean;
  // null: 그 기업형태 조회 자체가 실패해 확인하지 못함
  company_type_filter_applied: Record<string, boolean | null>;
}

export interface SnapshotCounts {
  api_total: number;
  received: number;
  duplicates_removed: number;
  occupation_mismatch_removed: number;
  regdate_out_of_range_removed: number;
  expired_removed: number;
  title_filtered_out: number;
  kept: number;
  geo_address: number;
  geo_region: number;
  geo_none: number;
  metro: number;
  nonmetro: number;
  region_unknown: number;
  by_sido: Record<string, number>;
  company_type: Record<CompanyType, number>;
  relevance_keyword_hit_rate: number | null;
  sido_cross_check: { compared: number; agreed: number };
}

export interface SnapshotError {
  stage: string;
  message: string;
}

export interface JobSnapshot {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  job_code: string;
  job_name: string;
  fetched_at: string;
  source: string;
  fixture: boolean;
  query: SnapshotQuery;
  checks: SnapshotChecks;
  counts: SnapshotCounts;
  items: PostingItem[];
  errors: SnapshotError[];
  // 공고 요구역량 집계(U25). 예전 스냅샷에는 없다.
  requirements?: RequirementSummary;
}

// 2026-10-26T05:00:00+09:00 형식
export function toKstIso(date: Date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

async function fetchAllPages(client: Work24Client, query: Omit<ListQuery, "startPage" | "display">, maxPages: number) {
  const wanted: RawWanted[] = [];
  let total = 0;
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await client.list({ ...query, startPage: page, display: PAGE_SIZE });
    if (page === 1) total = res.total;
    pages += 1;
    wanted.push(...res.wanted);
    if (wanted.length >= total || res.wanted.length < PAGE_SIZE) break;
  }
  return { total, wanted, pages };
}

// coTp 조회 결과가 기본 조회와 똑같이 많으면 조건이 무시된 것으로 본다(명세 4.4).
export function isCompanyTypeIgnored(coTpTotal: number, baseTotal: number) {
  return coTpTotal === baseTotal && baseTotal >= IGNORED_COTP_MIN_TOTAL;
}

export function checkOccupationFilter<T extends { jobs_cd: string }>(items: T[], requested: string[]) {
  const allowed = new Set(requested);
  const matching = items.filter((item) => allowed.has(item.jobs_cd));
  const applied = items.length === 0 || matching.length / items.length >= FILTER_APPLIED_RATIO;
  return { applied, items: applied ? items : matching, removed: applied ? 0 : items.length - matching.length };
}

export function checkRegDateFilter<T extends { reg_date: string | null }>(items: T[], todayKst: string) {
  const dated = items.filter((item) => item.reg_date);
  const inWindow = (item: T) => !item.reg_date || daysBetween(item.reg_date, todayKst) <= REGDATE_WINDOW_DAYS;
  const within = dated.filter(inWindow).length;
  const applied = dated.length === 0 || within / dated.length >= FILTER_APPLIED_RATIO;
  if (applied) return { applied, items, removed: 0 };
  const kept = items.filter(inWindow);
  return { applied, items: kept, removed: items.length - kept.length };
}

function sortBySido(counts: Map<string, number>) {
  const order = (name: string) => SIDO_NAMES.indexOf(name as Sido);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0])));
}

export interface CollectOptions {
  jobCode: string;
  entry: OccupationEntry;
  client: Work24Client;
  geocoder: Geocoder | null;
  regDate: string;
  maxPages: number;
  now: Date; // 마감·등록기간 판정 기준
  fetchedAt: Date;
  fixture: boolean;
  // 직무내용을 읽으려고 상세 조회할 최대 공고 수(0이면 제목만 분석)
  detailLimit?: number;
  log?: (message: string) => void;
}

export async function collectJob(options: CollectOptions): Promise<JobSnapshot> {
  const { entry, client, geocoder } = options;
  const log = options.log ?? (() => {});
  if (entry.mode === "tbd") throw new Error("mode=tbd 직업은 수집하지 않아.");
  const errors: SnapshotError[] = [];
  const baseQuery = entry.mode === "code"
    ? { occupation: entry.work24_codes.map((c) => c.code), regDate: options.regDate, sortOrderBy: "DESC" as const }
    : { keyword: entry.keyword, regDate: options.regDate, sortOrderBy: "DESC" as const };

  // 1. 기본 조회
  const base = await fetchAllPages(client, baseQuery, options.maxPages);
  log(`  기본 조회: total ${base.total}, 받은 ${base.wanted.length}건, ${base.pages}페이지`);

  // 2. 기업형태별 조회
  const companyTypeOf = new Map<string, CompanyType>();
  const companyChecks: Record<string, boolean | null> = {};
  for (const [coTp, type] of COMPANY_TYPE_CODES) {
    try {
      const res = await fetchAllPages(client, { ...baseQuery, coTp }, options.maxPages);
      if (isCompanyTypeIgnored(res.total, base.total)) {
        companyChecks[coTp] = false;
        log(`  coTp=${coTp}: total이 기본 조회와 같아(${res.total}) 조건이 무시된 걸로 봐`);
        continue;
      }
      companyChecks[coTp] = true;
      for (const w of res.wanted) {
        if (w.wantedAuthNo && !companyTypeOf.has(w.wantedAuthNo)) companyTypeOf.set(w.wantedAuthNo, type);
      }
      log(`  coTp=${coTp}: ${res.wanted.length}건`);
    } catch (error) {
      companyChecks[coTp] = null;
      errors.push({ stage: `coTp=${coTp}`, message: (error as Error).message });
      log(`  coTp=${coTp} 조회 실패: ${(error as Error).message}`);
    }
  }

  // 3. 정리: 중복 → 조건 검증 → 마감 → 제목 필터
  const todayKst = kstDateString(options.now);
  const deduped = dedupeById(base.wanted.map(wantedToBaseItem));
  let items: BaseItem[] = deduped.items;

  let occupationApplied: boolean | null = null;
  let occupationRemoved = 0;
  if (entry.mode === "code") {
    const check = checkOccupationFilter(items, entry.work24_codes.map((c) => c.code));
    occupationApplied = check.applied;
    occupationRemoved = check.removed;
    items = check.items;
  }
  const regCheck = checkRegDateFilter(items, todayKst);
  items = regCheck.items;

  const beforeExpiry = items.length;
  items = items.filter((item) => !isExpired(item, todayKst));
  const expiredRemoved = beforeExpiry - items.length;

  const titleResult = applyTitleFilter(items, entry.title_include, entry.title_exclude);
  items = titleResult.items;

  // 4. 기업형태, 지역, 좌표
  const crossCheck = { compared: 0, agreed: 0 };
  let geocoderDisabled = !geocoder;
  let geocodeFailures = 0;
  for (const item of items) {
    item.company_type = companyTypeOf.get(item.id) ?? null;
    const region = resolveRegion({ strtnmCd: item.raw_strtnm_cd, region: item.raw_region, basicAddr: item.address });
    item.sido = region.sido;
    item.sigungu = region.sigungu;

    let geo: GeoResult | null = null;
    if (!geocoderDisabled && geocoder) {
      try {
        if (item.address) geo = await geocoder.geocode(item.address);
        if (!geo && item.raw_region) {
          const approx = await geocoder.geocode(item.raw_region);
          geo = approx ? { ...approx, precision: "region" } : null;
        }
      } catch (error) {
        if (error instanceof GeocoderConfigError) {
          geocoderDisabled = true;
          errors.push({ stage: "geocode", message: error.message });
        } else {
          geocodeFailures += 1;
        }
        geo = null;
      }
    }
    if (geo) {
      item.lat = geo.lat;
      item.lng = geo.lng;
      item.geo_precision = geo.precision;
      if (region.source === "code" && geo.sido) {
        crossCheck.compared += 1;
        if (geo.sido === region.sido) crossCheck.agreed += 1;
      }
      if (!item.sido && geo.sido) item.sido = geo.sido;
      if (!item.sigungu && geo.sigungu) item.sigungu = geo.sigungu;
    }
    item.is_metro = isMetro(item.sido);
  }
  if (!geocoder) errors.push({ stage: "geocode", message: "KAKAO_REST_API_KEY가 없어 좌표를 구하지 않았어." });
  if (geocodeFailures) errors.push({ stage: "geocode", message: `지오코딩 요청 ${geocodeFailures}건이 일시 오류로 실패했어.` });

  // 5. 품질 지표
  const bySido = new Map<string, number>();
  const companyTypeCounts: Record<CompanyType, number> = { large: 0, public: 0, foreign: 0 };
  for (const item of items) {
    if (item.sido) bySido.set(item.sido, (bySido.get(item.sido) ?? 0) + 1);
    if (item.company_type) companyTypeCounts[item.company_type] += 1;
  }
  const counts: SnapshotCounts = {
    api_total: base.total,
    received: base.wanted.length,
    duplicates_removed: deduped.removed,
    occupation_mismatch_removed: occupationRemoved,
    regdate_out_of_range_removed: regCheck.removed,
    expired_removed: expiredRemoved,
    title_filtered_out: titleResult.removed,
    kept: items.length,
    geo_address: items.filter((i) => i.geo_precision === "address").length,
    geo_region: items.filter((i) => i.geo_precision === "region").length,
    geo_none: items.filter((i) => i.geo_precision === "none").length,
    metro: items.filter((i) => i.is_metro === true).length,
    nonmetro: items.filter((i) => i.is_metro === false).length,
    region_unknown: items.filter((i) => i.is_metro === null).length,
    by_sido: sortBySido(bySido),
    company_type: companyTypeCounts,
    relevance_keyword_hit_rate: keywordHitRate(items, entry.relevance_keywords),
    sido_cross_check: crossCheck
  };

  // 6. 요구역량(U25): 제목 전체 + 앞쪽 공고 몇 건의 직무내용. 원문은 저장하지 않는다.
  const detailLimit = Math.max(0, Math.min(options.detailLimit ?? 0, items.length));
  const details = new Map<string, string>();
  let detailFailures = 0;
  for (const item of items.slice(0, detailLimit)) {
    try {
      const detail = await client.detail(item.id);
      if (detail?.jobCont) details.set(item.id, detail.jobCont);
    } catch {
      detailFailures += 1;
    }
  }
  if (detailFailures) errors.push({ stage: "detail", message: `상세 조회 ${detailFailures}건이 실패해 제목만 분석했어.` });
  const requirements = analyzeRequirementTexts(items.map((item) => ({ title: item.title, detail: details.get(item.id) ?? null })));
  if (detailLimit) log(`  요구역량: 상세 ${requirements.detail_postings}/${detailLimit}건, 문장 ${requirements.analyzed_sentences}개`);

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    job_code: options.jobCode,
    job_name: entry.job_name,
    fetched_at: toKstIso(options.fetchedAt),
    source: SOURCE_LABEL,
    fixture: options.fixture,
    query: {
      mode: entry.mode,
      occupation: entry.mode === "code" ? entry.work24_codes.map((c) => c.code) : [],
      occupation_labels: entry.mode === "code" ? entry.work24_codes : [],
      keyword: entry.mode === "keyword" ? entry.keyword : null,
      regDate: options.regDate,
      sortOrderBy: "DESC",
      pages_fetched: base.pages
    },
    checks: {
      occupation_filter_applied: occupationApplied,
      regdate_filter_applied: regCheck.applied,
      company_type_filter_applied: companyChecks
    },
    counts,
    items: items.map(toPublicItem),
    errors,
    requirements
  };
}
