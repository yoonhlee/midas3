import type { RawWanted } from "./work24Client.js";
import type { Sido } from "./regions.js";

export type CloseType = "date" | "until_filled" | "unknown";
export type GeoPrecision = "address" | "region" | "none";
export type CompanyType = "large" | "public" | "foreign";

export interface PostingItem {
  id: string;
  company: string;
  title: string;
  jobs_cd: string;
  sido: Sido | null;
  sigungu: string | null;
  is_metro: boolean | null;
  address: string;
  lat: number | null;
  lng: number | null;
  geo_precision: GeoPrecision;
  reg_date: string | null;
  close_date: string | null;
  close_type: CloseType;
  salary_text: string;
  company_type: CompanyType | null;
  info_svc: string;
  url: string;
  mobile_url: string;
}

// 지역·좌표를 붙이기 전 단계. collector가 원본 필드(region/strtnmCd)를 참고한다.
export interface BaseItem extends PostingItem {
  raw_region: string;
  raw_strtnm_cd: string;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 한국 시간 기준 날짜(YYYY-MM-DD)
export function kstDateString(now: Date) {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// "26-09-28" → "2026-09-28", "2026-09-28"도 허용
export function parseYyMmDd(value: string | null | undefined): string | null {
  const s = String(value ?? "").trim();
  const m = s.match(/(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// closeDt: "26-10-31" / "채용시까지  26-10-30" / "채용시까지"
export function parseCloseDt(value: string | null | undefined): { close_type: CloseType; close_date: string | null } {
  const s = String(value ?? "").trim();
  const date = parseYyMmDd(s);
  if (s.includes("채용시")) return { close_type: "until_filled", close_date: date };
  if (date) return { close_type: "date", close_date: date };
  return { close_type: "unknown", close_date: null };
}

// 한국 시간 오늘보다 마감일이 이르면 마감. 날짜 없는 공고는 남긴다.
export function isExpired(item: Pick<PostingItem, "close_date">, todayKst: string) {
  return Boolean(item.close_date) && (item.close_date as string) < todayKst;
}

export function daysBetween(fromDate: string, toDate: string) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

function safeUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function salaryText(w: RawWanted) {
  return [w.salTpNm, w.sal].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
}

export function wantedToBaseItem(w: RawWanted): BaseItem {
  const close = parseCloseDt(w.closeDt);
  return {
    id: (w.wantedAuthNo ?? "").trim(),
    company: (w.company ?? "").trim(),
    title: (w.title ?? "").trim(),
    jobs_cd: (w.jobsCd ?? "").trim(),
    sido: null,
    sigungu: null,
    is_metro: null,
    // 근무지 기본 주소만 쓴다. detailAddr(층·호수)는 표시·지오코딩 모두 쓰지 않는다.
    address: (w.basicAddr ?? "").trim(),
    lat: null,
    lng: null,
    geo_precision: "none",
    reg_date: parseYyMmDd(w.regDt),
    close_date: close.close_date,
    close_type: close.close_type,
    salary_text: salaryText(w),
    company_type: null,
    info_svc: (w.infoSvc ?? "").trim(),
    url: safeUrl(w.wantedInfoUrl ?? ""),
    mobile_url: safeUrl(w.wantedMobileInfoUrl ?? ""),
    raw_region: (w.region ?? "").trim(),
    raw_strtnm_cd: (w.strtnmCd ?? "").trim()
  };
}

export function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    kept.push(item);
  }
  return { items: kept, removed: items.length - kept.length };
}

// title_include가 있으면 그중 하나라도 들어간 제목만, title_exclude에 걸리면 제외
export function applyTitleFilter<T extends { title: string }>(items: T[], include: string[], exclude: string[]) {
  const inc = include.map((s) => s.toLowerCase()).filter(Boolean);
  const exc = exclude.map((s) => s.toLowerCase()).filter(Boolean);
  const kept = items.filter((item) => {
    const title = item.title.toLowerCase();
    if (inc.length && !inc.some((k) => title.includes(k))) return false;
    if (exc.some((k) => title.includes(k))) return false;
    return true;
  });
  return { items: kept, removed: items.length - kept.length };
}

export function keywordHitRate(items: Array<{ title: string }>, keywords: string[]): number | null {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (!kws.length || !items.length) return null;
  const hits = items.filter((item) => kws.some((k) => item.title.toLowerCase().includes(k))).length;
  return Math.round((hits / items.length) * 1000) / 1000;
}

export function toPublicItem(item: BaseItem): PostingItem {
  const { raw_region: _region, raw_strtnm_cd: _code, ...rest } = item;
  return rest;
}
