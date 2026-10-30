// 직종코드 탐색: mode가 tbd인 직업의 고용24 직종코드 후보를 찾는다(명세 4.2).
// 사용법: npm run postings:discover -- [--job K000001179] [--fixture] [--apply]
//   --apply  제안을 data/postings/occupation_map.json에 기록(실제 모드에서만). 기본은 문서만 만든다.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_DIR, PROJECT_ROOT, loadPostingsConfig } from "../src/lib/postings/config.js";
import { loadOccupationMap, saveOccupationMap, type OccupationEntry } from "../src/lib/postings/occupationMap.js";
import {
  createFixtureWork24Client,
  createLiveWork24Client,
  maskSecrets,
  type RawWanted,
  type Work24Client
} from "../src/lib/postings/work24Client.js";

const DISCOVERY_MAX_PAGES = 3;
const TOP_CODES = 5;

function argValue(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

function readKnowKeco(jobCode: string) {
  const file = path.join(PROJECT_ROOT, "data/api_raw", jobCode, "dtlGb_3.xml");
  if (!fs.existsSync(file)) return null;
  const xml = fs.readFileSync(file, "utf8");
  const cd = xml.match(/<kecoCd>([^<]*)<\/kecoCd>/)?.[1]?.trim();
  const nm = xml.match(/<kecoNm>([^<]*)<\/kecoNm>/)?.[1]?.trim();
  return cd ? `${cd} ${nm ?? ""}`.trim() : null;
}

// KNOW 직업명(KECO 이름)과 고용24 직종명이 같은 일을 가리키는지 판단하는 보조 규칙. 최종 판단은 사람이 한다.
function targetTerms(kecoName: string) {
  return kecoName
    .replace(/^\d+\s*/, "")
    .split(/[·,\s]+/)
    .map((t) => (t.length >= 3 ? t.replace(/(가|자|원)$/, "") : t))
    .filter((t) => t.length >= 2);
}

// 핵심어 2개 이상(핵심어가 1개면 그 1개)이 직종명에 들어 있으면 같은 일로 본다.
function matchesTarget(jobsNm: string, terms: string[]) {
  const name = jobsNm.replace(/\s+/g, "");
  const hits = terms.filter((t) => name.includes(t)).length;
  return terms.length > 0 && hits >= Math.min(2, terms.length);
}

interface CodeStat {
  code: string;
  count: number;
  titles: string[];
  validationId: string | null;
  jobsNm: string | null;
  suggested: boolean;
}

async function collectByKeyword(client: Work24Client, keyword: string, regDate: string) {
  const out: RawWanted[] = [];
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page += 1) {
    const res = await client.list({ startPage: page, display: 100, keyword, regDate, sortOrderBy: "DESC" });
    out.push(...res.wanted);
    if (res.wanted.length < 100 || out.length >= res.total) break;
  }
  return out;
}

async function discoverJob(client: Work24Client, jobCode: string, entry: OccupationEntry, regDate: string) {
  const keywords = entry.discovery_keywords?.length ? entry.discovery_keywords : [entry.job_name];
  const seen = new Map<string, RawWanted>();
  for (const keyword of keywords) {
    for (const w of await collectByKeyword(client, keyword, regDate)) {
      if (w.wantedAuthNo && !seen.has(w.wantedAuthNo)) seen.set(w.wantedAuthNo, w);
    }
  }
  const stats = new Map<string, CodeStat>();
  for (const w of seen.values()) {
    const code = (w.jobsCd ?? "").trim() || "(없음)";
    const stat = stats.get(code) ?? { code, count: 0, titles: [], validationId: null, jobsNm: null, suggested: false };
    stat.count += 1;
    if (stat.titles.length < 5 && w.title) stat.titles.push(w.title.trim());
    if (!stat.validationId && w.infoSvc === "VALIDATION") stat.validationId = w.wantedAuthNo;
    stats.set(code, stat);
  }
  const ranked = [...stats.values()].sort((a, b) => b.count - a.count);
  const terms = targetTerms(entry.know_keco || entry.job_name);
  for (const stat of ranked.slice(0, TOP_CODES)) {
    if (!stat.validationId) continue;
    try {
      stat.jobsNm = (await client.detail(stat.validationId))?.jobsNm ?? null;
    } catch (error) {
      console.warn(`  상세 조회 실패(${stat.code}): ${(error as Error).message}`);
    }
    stat.suggested = /^\d{6}$/.test(stat.code) && matchesTarget(stat.jobsNm ?? "", terms);
  }
  return { keywords, total: seen.size, ranked, terms };
}

async function main() {
  const fixture = hasFlag("--fixture");
  const apply = hasFlag("--apply");
  const config = loadPostingsConfig(process.env, fixture ? { fixture: true } : {});
  if (!config.fixture && !config.work24Key) {
    console.log("WORK24_RECRUIT_AUTH_KEY가 없어서 직종코드 탐색을 건너뛰어. 투자분석가·보험상품개발자는 tbd로 남아.");
    return;
  }
  if (apply && config.fixture) {
    console.error("--apply는 고정 데이터 모드에서 쓸 수 없어(가짜 직종코드가 매핑 파일에 들어가지 않게).");
    process.exitCode = 1;
    return;
  }
  const map = loadOccupationMap();
  const onlyJob = argValue("--job");
  const targets = Object.entries(map.jobs).filter(([code, entry]) => onlyJob ? code === onlyJob : entry.mode === "tbd");
  if (!targets.length) {
    console.log(onlyJob ? `${onlyJob}은 매핑 파일에 없어.` : "tbd 상태인 직업이 없어.");
    return;
  }
  const client = config.fixture
    ? createFixtureWork24Client(FIXTURE_DIR)
    : createLiveWork24Client({ authKey: config.work24Key, delayMs: config.requestDelayMs, log: () => {} });

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "# 고용24 직종코드 탐색 결과",
    "",
    `- 실행일: ${today}${config.fixture ? " (고정 데이터 모드: 가짜 데이터야)" : ""}`,
    `- 조회 조건: keyword(후보 키워드별), regDate=${config.regDate}, 키워드당 최대 ${DISCOVERY_MAX_PAGES}페이지`,
    "- '제안'은 고용24 직종명이 KNOW 직업명(KECO)의 핵심어를 포함하는지로만 판단한 보조 표시야. 최종 결정은 사람이 해.",
    ""
  ];
  for (const [jobCode, entry] of targets) {
    console.log(`\n▶ ${jobCode} ${entry.job_name}`);
    const knowKeco = readKnowKeco(jobCode);
    if (knowKeco) console.log(`  KNOW KECO(data/api_raw): ${knowKeco}`);
    let result: Awaited<ReturnType<typeof discoverJob>>;
    try {
      result = await discoverJob(client, jobCode, entry, config.regDate);
    } catch (error) {
      const message = maskSecrets((error as Error).message, [config.work24Key]);
      console.error(`  실패: ${message}`);
      lines.push(`## ${jobCode} ${entry.job_name}`, "", `탐색 실패: ${message}`, "");
      continue;
    }
    const suggested = result.ranked.filter((s) => s.suggested);
    const decision = suggested.length
      ? `mode=code, 직종코드 ${suggested.map((s) => `${s.code}(${s.jobsNm})`).join(", ")}`
      : `깔끔한 코드 없음 → mode=keyword("${result.keywords[0]}") 제안`;
    lines.push(
      `## ${jobCode} ${entry.job_name}`,
      "",
      `- KNOW KECO: ${knowKeco ?? entry.know_keco}`,
      `- 후보 키워드: ${result.keywords.join(", ")} · 고유 공고 ${result.total}건`,
      `- 직종명 비교 핵심어: ${result.terms.join(", ")}`,
      `- 제안: ${decision}`,
      "",
      "| 직종코드 | 직종명(상세 API) | 빈도 | 대표 제목 | 결정 |",
      "|---|---|---|---|---|",
      ...result.ranked.map((s) =>
        `| ${s.code} | ${s.jobsNm ?? (s.validationId ? "상세 없음" : "VALIDATION 공고 없음")} | ${s.count} | ${s.titles.join(" / ").replace(/\|/g, "／")} | ${s.suggested ? "채택 제안" : "제외"} |`
      ),
      ""
    );
    for (const s of result.ranked.slice(0, TOP_CODES)) {
      console.log(`  ${s.code}  ${String(s.count).padStart(4)}건  ${s.jobsNm ?? "-"}  ${s.suggested ? "← 제안" : ""}`);
    }
    console.log(`  제안: ${decision}`);

    if (apply) {
      const evidenceBase = `고용24 직종코드 탐색(${today}, 키워드 ${result.keywords.join("/")}, 고유 공고 ${result.total}건)`;
      if (suggested.length) {
        map.jobs[jobCode] = {
          ...entry,
          mode: "code",
          work24_codes: suggested.map((s) => ({ code: s.code, name: s.jobsNm ?? s.code })),
          keyword: null,
          evidence: `${evidenceBase}에서 상세 API 직종명이 KNOW ${entry.know_keco}와 같은 일을 가리키는 코드를 채택. 자세한 표는 docs/postings_occupation_discovery.md.`
        };
      } else {
        map.jobs[jobCode] = {
          ...entry,
          mode: "keyword",
          work24_codes: [],
          keyword: result.keywords[0],
          title_include: result.keywords,
          evidence: `${evidenceBase}에서 같은 일을 가리키는 직종코드를 찾지 못해 키워드 검색 + 제목 필터로 조회.`
        };
      }
    }
  }

  const outPath = config.fixture
    ? path.join(config.dataDir, "postings_occupation_discovery.md")
    : path.join(PROJECT_ROOT, "docs/postings_occupation_discovery.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`\n결과 문서: ${path.relative(PROJECT_ROOT, outPath)}`);
  if (apply) {
    map.updated_at = today;
    saveOccupationMap(map);
    console.log("매핑 파일에 제안을 기록했어: data/postings/occupation_map.json (커밋 전에 꼭 검토해)");
  }
}

main().catch((error) => {
  console.error(maskSecrets((error as Error)?.stack ?? String(error), [process.env.WORK24_RECRUIT_AUTH_KEY]));
  process.exitCode = 1;
});
