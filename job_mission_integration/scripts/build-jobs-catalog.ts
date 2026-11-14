// KNOW 직업정보 원천 XML(data/api_raw/{code}/dtlGb_1~7.xml)에서 직무 탐색·상세용 JSON을 만든다.
// 사용법: npm run jobs:build
// 결과: data/jobs/index.json(탐색용 가벼운 목록), data/jobs/details.json(상세), 둘 다 저장소에 커밋한다.
// (Docker 이미지에는 data/api_raw가 없어서 서버는 생성된 JSON만 읽는다.)
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { ROOT_DIR } from "../src/server/config.js";

const API_RAW = path.join(ROOT_DIR, "data/api_raw");
const OUT_DIR = path.join(ROOT_DIR, "data/jobs");
const ACTIVITIES_CSV = path.join(ROOT_DIR, "data/processed/activities.csv");
const JOB_WEIGHTS = path.join(ROOT_DIR, "data/processed/job_weights.json");
const ALIASES = path.join(OUT_DIR, "aliases.json");

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

type Obj = Record<string, any>;

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const text = (value: unknown) => String(value ?? "").replace(/&#xd;|\r/g, "\n").replace(/[ \t]+/g, " ").trim();
const num = (value: unknown) => {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

function readXml(code: string, index: number): Obj {
  const file = path.join(API_RAW, code, `dtlGb_${index}.xml`);
  if (!fs.existsSync(file)) return {};
  const doc = parser.parse(fs.readFileSync(file, "utf8")) as Obj;
  const rootKey = Object.keys(doc).find((key) => key !== "?xml");
  return rootKey ? (doc[rootKey] ?? {}) : {};
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

// 직업 내 비교(그 직업 안에서 중요한 순서, 1~5점)와 직업 간 비교(다른 직업 대비 백분위, 0~100)를 함께 담는다.
function pairList(within: Obj[], between: Obj[], keys: { wName: string; wScore: string; bName: string; bScore: string; desc?: string }, dict: Map<string, string>) {
  const betweenMap = new Map<string, number | null>();
  for (const item of between) betweenMap.set(text(item[keys.bName]), num(item[keys.bScore]));
  return within
    .map((item) => {
      const name = text(item[keys.wName]);
      if (keys.desc && item[keys.desc] && !dict.has(name)) dict.set(name, text(item[keys.desc]));
      return [name, num(item[keys.wScore]), betweenMap.get(name) ?? null] as [string, number | null, number | null];
    })
    .filter(([name]) => name);
}

function parseSalary(raw: string) {
  const year = raw.match(/조사년도\s*:?\s*(\d{4})/)?.[1] ?? null;
  const p25 = raw.match(/하위\(25%\)\s*([\d,]+)\s*만원/)?.[1];
  const p50 = raw.match(/평균\(50%\)\s*([\d,]+)\s*만원/)?.[1] ?? raw.match(/중위[^\d]*([\d,]+)\s*만원/)?.[1];
  const p75 = raw.match(/상위\(25%\)\s*([\d,]+)\s*만원/)?.[1];
  const toNum = (v?: string) => (v ? Number(v.replace(/,/g, "")) : null);
  return { text: raw, year: year ? Number(year) : null, p25: toNum(p25), p50: toNum(p50), p75: toNum(p75) };
}

function parseCsv(content: string) {
  const rows: string[][] = [];
  for (const line of content.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "\"") {
        if (quoted && line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

// 비슷한 일을 하는 직무: 41개 업무활동 중요도 벡터를 직무 평균으로 중심화한 뒤 코사인 유사도로 비교한다.
function buildSimilarity(names: Map<string, string>) {
  if (!fs.existsSync(ACTIVITIES_CSV)) return new Map<string, Obj[]>();
  const rows = parseCsv(fs.readFileSync(ACTIVITIES_CSV, "utf8"));
  const header = rows[0];
  const activities = header.slice(2);
  const vectors = rows.slice(1).map((row) => ({ code: row[0], values: row.slice(2).map((v) => Number(v) || 0) }));
  const mean = activities.map((_, i) => vectors.reduce((sum, v) => sum + v.values[i], 0) / vectors.length);
  const centered = vectors.map((v) => ({ code: v.code, raw: v.values, c: v.values.map((x, i) => x - mean[i]) }));
  const norm = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
  const out = new Map<string, Obj[]>();
  for (const a of centered) {
    const na = norm(a.c);
    const scored = centered
      .filter((b) => b.code !== a.code)
      .map((b) => ({ b, sim: a.c.reduce((s, x, i) => s + x * b.c[i], 0) / (na * norm(b.c)) }))
      .sort((x, y) => y.sim - x.sim)
      .slice(0, 6);
    out.set(a.code, scored.map(({ b, sim }) => {
      const common = activities
        .map((name, i) => ({ name, both: Math.min(a.raw[i], b.raw[i]) }))
        .sort((x, y) => y.both - x.both)
        .slice(0, 3)
        .map((item) => item.name);
      const diff = activities
        .map((name, i) => ({ name, mine: a.raw[i], theirs: b.raw[i], gap: b.raw[i] - a.raw[i] }))
        .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))
        .slice(0, 2)
        .map((item) => ({ name: item.name, mine: item.mine, theirs: item.theirs }));
      return { code: b.code, name: names.get(b.code) ?? b.code, similarity: Number(sim.toFixed(3)), common, diff };
    }));
  }
  return out;
}

function main() {
  const codes = fs.readdirSync(API_RAW).filter((name) => /^K\d{9}$/.test(name)).sort();
  const dictionaries = {
    abilities: new Map<string, string>(),
    knowledge: new Map<string, string>(),
    environment: new Map<string, string>(),
    personality: new Map<string, string>(),
    interests: new Map<string, string>(),
    values: new Map<string, string>(),
    activities: new Map<string, string>()
  };
  const weights = fs.existsSync(JOB_WEIGHTS) ? (JSON.parse(fs.readFileSync(JOB_WEIGHTS, "utf8")) as Obj) : {};
  const aliases = fs.existsSync(ALIASES) ? (JSON.parse(fs.readFileSync(ALIASES, "utf8")) as { aliases: Record<string, string[]> }).aliases ?? {} : {};
  const details: Obj[] = [];

  for (const code of codes) {
    const sum = readXml(code, 1);
    const does = readXml(code, 2);
    const way = readXml(code, 3);
    const sal = readXml(code, 4);
    const ake = readXml(code, 5);
    const civ = readXml(code, 6);
    const act = readXml(code, 7);
    const name = text(sum.jobSmclNm || does.jobSmclNm);
    if (!name) continue;
    const prospectDist = asArray<Obj>(sal.jobSumProspect).map((item) => ({ label: text(item.jobProspectNm), ratio: num(item.jobProspectRatio) }));
    const prospectYear = num(asArray<Obj>(sal.jobSumProspect)[0]?.jobProspectInqYr);
    const salary = parseSalary(text(sal.sal));
    const edu = way.edubg ?? {};
    details.push({
      code,
      name,
      lrcl: text(sum.jobLrclNm),
      mdcl: text(sum.jobMdclNm),
      summary: text(sum.jobSum || does.jobSum),
      duties: text(does.execJob).split(/\n+/).map((line) => line.replace(/^[-·•\s]+/, "").trim()).filter(Boolean).slice(0, 12),
      related_jobs: asArray<Obj>(does.relJobList).map((item) => ({ code: text(item.jobCd), name: text(item.jobNm) })).filter((item) => item.code),
      way: clip(text(way.technKnow), 900),
      majors: asArray<Obj>(way.relMajorList).map((item) => text(item.majorNm)).filter(Boolean),
      certs: text(asArray<Obj>(way.relCertList)[0]?.certNm).split(/\s*,\s*/).filter(Boolean),
      keco: way.kecoList ? { code: text(asArray<Obj>(way.kecoList)[0]?.kecoCd), name: text(asArray<Obj>(way.kecoList)[0]?.kecoNm) } : null,
      education: {
        hs_or_less: num(edu.edubgHgradu),
        college: num(edu.edubgCgraduUndr),
        university: num(edu.edubgUgradu),
        master: num(edu.edubgMgraduUndr),
        doctor: num(edu.edubgDgradu)
      },
      salary,
      satisfaction: num(sal.jobSatis),
      prospect: { text: clip(text(sal.jobProspect), 900), year: prospectYear, distribution: prospectDist },
      abilities: pairList(asArray(ake.jobAbilCmpr), asArray(ake.jobAbil), { wName: "jobAblNmCmpr", wScore: "jobAblStatusCmpr", bName: "jobAblNm", bScore: "jobAblStatus", desc: "jobAblContCmpr" }, dictionaries.abilities),
      knowledge: pairList(asArray(ake.KnwldgCmpr), asArray(ake.Knwldg), { wName: "knwldgNmCmpr", wScore: "knwldgStatusCmpr", bName: "knwldgNm", bScore: "knwldgStatus", desc: "knwldgContCmpr" }, dictionaries.knowledge),
      environment: pairList(asArray(ake.jobsEnvCmpr), asArray(ake.jobsEnv), { wName: "jobEnvNmCmpr", wScore: "jobEnvStatusCmpr", bName: "jobEnvNm", bScore: "jobEnvStatus", desc: "jobEnvContCmpr" }, dictionaries.environment),
      personality: pairList(asArray(civ.jobChrCmpr), asArray(civ.jobChr), { wName: "jobChrNmCmpr", wScore: "jobChrStatusCmpr", bName: "jobChrNm", bScore: "jobChrStatus", desc: "jobChrContCmpr" }, dictionaries.personality),
      interests: pairList(asArray(civ.jobIntrstCmpr), asArray(civ.jobIntrst), { wName: "intrstNmCmpr", wScore: "intrstStatusCmpr", bName: "intrstNm", bScore: "intrstStatus", desc: "intrstContCmpr" }, dictionaries.interests),
      values: pairList(asArray(civ.jobValsCmpr), asArray(civ.jobVals), { wName: "valsNmCmpr", wScore: "valsStatusCmpr", bName: "valsNm", bScore: "valsStatus", desc: "valsContCmpr" }, dictionaries.values),
      activities: pairList(asArray(act.jobActvImprtncCmpr), asArray(act.jobActvImprtnc), { wName: "jobActvImprtncNmCmpr", wScore: "jobActvImprtncStatusCmpr", bName: "jobActvImprtncNm", bScore: "jobActvImprtncStatus", desc: "jobActvImprtncContCmpr" }, dictionaries.activities),
      axis_weights: weights[code]?.weights ?? null,
      cluster_id: weights[code]?.cluster_id ?? null
    });
  }

  // 상세 화면에 필요한 만큼만 남겨 파일 크기를 줄인다(직업 내 중요도 순).
  const caps: Record<string, number> = { abilities: 20, knowledge: 15, environment: 12, personality: 16, interests: 6, values: 13, activities: 15 };
  for (const job of details) {
    for (const [key, cap] of Object.entries(caps)) job[key] = job[key].slice(0, cap);
  }

  const names = new Map(details.map((job) => [job.code, job.name]));
  const similar = buildSimilarity(names);
  for (const job of details) job.similar = similar.get(job.code) ?? [];

  const index = details.map((job) => ({
    code: job.code,
    name: job.name,
    lrcl: job.lrcl,
    mdcl: job.mdcl,
    summary: clip(job.summary, 140),
    salary_p50: job.salary.p50,
    satisfaction: job.satisfaction,
    prospect_up: job.prospect.distribution
      .filter((item: Obj) => item.label === "증가" || item.label === "다소 증가")
      .reduce((s: number, item: Obj) => s + (item.ratio ?? 0), 0) || null,
    top_abilities: job.abilities.slice(0, 3).map((item: [string]) => item[0]),
    aliases: aliases[job.code] ?? []
  }));

  // 같은 원천이면 언제 돌려도 같은 파일이 나오게 생성 시각은 넣지 않는다(CI가 차이를 검사한다).
  const meta = {
    job_count: details.length,
    source: "한국고용정보원 한국직업정보(KNOW) 직업정보 Open API",
    source_url: "https://www.work24.go.kr/cm/e/a/0110/selectOpenApiSvcInfo.do",
    salary_year: mode(details.map((job) => job.salary.year)),
    prospect_year: mode(details.map((job) => job.prospect.year)),
    note: "역량·지식·환경·성격·흥미·가치관·업무활동: 직업 내 비교(1~5점, 그 직업 안에서 중요한 정도)와 직업 간 비교(0~100, 다른 직업 대비 수준)"
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), `${JSON.stringify({ schema_version: "jobs_index.v1", ...meta, jobs: index })}\n`);
  fs.writeFileSync(path.join(OUT_DIR, "details.json"), `${JSON.stringify({
    schema_version: "jobs_details.v1",
    ...meta,
    descriptions: Object.fromEntries(Object.entries(dictionaries).map(([k, map]) => [k, Object.fromEntries(map)])),
    jobs: details
  })}\n`);
  console.log(`직무 ${details.length}개 → data/jobs/index.json, data/jobs/details.json`);
}

function mode(values: Array<number | null>) {
  const counts = new Map<number, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

main();
