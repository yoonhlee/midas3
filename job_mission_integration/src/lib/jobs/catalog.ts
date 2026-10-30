import fs from "node:fs";
import path from "node:path";

// 직무 탐색·상세 데이터(data/jobs/*.json, npm run jobs:build로 생성)를 읽는다.

export interface JobIndexItem {
  code: string;
  name: string;
  lrcl: string;
  mdcl: string;
  summary: string;
  salary_p50: number | null;
  satisfaction: number | null;
  prospect_up: number | null;
  top_abilities: string[];
  aliases: string[];
}

export type ScorePair = [name: string, within: number | null, between: number | null];

export interface JobDetail {
  code: string;
  name: string;
  lrcl: string;
  mdcl: string;
  summary: string;
  duties: string[];
  related_jobs: Array<{ code: string; name: string }>;
  way: string;
  majors: string[];
  certs: string[];
  keco: { code: string; name: string } | null;
  education: Record<string, number | null>;
  salary: { text: string; year: number | null; p25: number | null; p50: number | null; p75: number | null };
  satisfaction: number | null;
  prospect: { text: string; year: number | null; distribution: Array<{ label: string; ratio: number | null }> };
  abilities: ScorePair[];
  knowledge: ScorePair[];
  environment: ScorePair[];
  personality: ScorePair[];
  interests: ScorePair[];
  values: ScorePair[];
  activities: ScorePair[];
  axis_weights: Record<string, number> | null;
  cluster_id: string | null;
  similar: Array<{ code: string; name: string; similarity: number; common: string[]; diff: Array<{ name: string; mine: number; theirs: number }> }>;
}

export interface CatalogMeta {
  job_count: number;
  source: string;
  source_url: string;
  salary_year: number | null;
  prospect_year: number | null;
  note: string;
}

export interface JobsCatalog {
  meta: CatalogMeta;
  index: JobIndexItem[];
  descriptions: Record<string, Record<string, string>>;
  get(code: string): JobDetail | null;
  has(code: string): boolean;
  name(code: string): string | null;
}

export function loadJobsCatalog(dir: string): JobsCatalog {
  const indexFile = path.join(dir, "index.json");
  const detailsFile = path.join(dir, "details.json");
  if (!fs.existsSync(indexFile) || !fs.existsSync(detailsFile)) {
    console.warn(`[jobs] ${dir}에 직무 데이터가 없어. npm run jobs:build로 만들어.`);
    return emptyCatalog();
  }
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as CatalogMeta & { jobs: JobIndexItem[] };
  const details = JSON.parse(fs.readFileSync(detailsFile, "utf8")) as CatalogMeta & {
    descriptions: Record<string, Record<string, string>>;
    jobs: JobDetail[];
  };
  const byCode = new Map(details.jobs.map((job) => [job.code, job]));
  const { jobs: _jobs, ...meta } = index;
  return {
    meta,
    index: index.jobs,
    descriptions: details.descriptions ?? {},
    get: (code) => byCode.get(code) ?? null,
    has: (code) => byCode.has(code),
    name: (code) => byCode.get(code)?.name ?? null
  };
}

function emptyCatalog(): JobsCatalog {
  return {
    meta: { job_count: 0, source: "", source_url: "", salary_year: null, prospect_year: null, note: "" },
    index: [],
    descriptions: {},
    get: () => null,
    has: () => false,
    name: () => null
  };
}

const AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"] as const;

// 강점 역량(축)으로 직무 찾기: 그 축 비중이 큰 직무 순서
export function jobsByAxisStrength(catalog: JobsCatalog, axis: string, limit = 10) {
  if (!(AXES as readonly string[]).includes(axis)) return [];
  return catalog.index
    .map((item) => ({ item, weight: catalog.get(item.code)?.axis_weights?.[axis] ?? 0 }))
    .filter((row) => row.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((row) => ({ code: row.item.code, name: row.item.name, lrcl: row.item.lrcl, weight: Number(row.weight.toFixed(3)) }));
}
