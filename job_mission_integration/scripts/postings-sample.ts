// 사람 검토용 표본 만들기와 집계(명세 6장).
//   npm run postings:sample                  직업별 무작위 20건을 docs/postings_sample_review.md로 내보내
//   npm run postings:sample -- --tally       체크한 문서를 읽어 직업별 직종 연결 정확도를 집계해
//   옵션: --size 20, --seed 문자열, --fixture(고정 데이터, 결과는 고정 데이터 폴더에 써)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, loadPostingsConfig } from "../src/lib/postings/config.js";
import { loadOccupationMap } from "../src/lib/postings/occupationMap.js";
import { readSnapshot } from "../src/lib/postings/store.js";

function argValue(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

// 같은 seed면 같은 표본이 나오게(재현 가능)
function seededRandom(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clean = (s: string) => s.replace(/\|/g, "／").replace(/\s+/g, " ").trim();

export function tally(markdown: string) {
  const result: Array<{ job: string; relevant: number; notRelevant: number; unchecked: number }> = [];
  let current: (typeof result)[number] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { job: heading[1].trim(), relevant: 0, notRelevant: 0, unchecked: 0 };
      result.push(current);
      continue;
    }
    const mark = line.match(/^\s*-\s*\[([^\]]*)\]/);
    if (!current || !mark) continue;
    const v = mark[1].trim().toUpperCase();
    if (v === "O") current.relevant += 1;
    else if (v === "X") current.notRelevant += 1;
    else current.unchecked += 1;
  }
  return result;
}

function main() {
  const fixture = hasFlag("--fixture");
  const config = loadPostingsConfig(process.env, fixture ? { fixture: true } : {});
  const outPath = fixture
    ? path.join(config.dataDir, "postings_sample_review.md")
    : path.join(PROJECT_ROOT, "docs/postings_sample_review.md");

  if (hasFlag("--tally")) {
    if (!fs.existsSync(outPath)) {
      console.log(`${path.relative(PROJECT_ROOT, outPath)}이 없어. 먼저 npm run postings:sample로 만들어.`);
      return;
    }
    const rows = tally(fs.readFileSync(outPath, "utf8")).map((r) => ({
      직업: r.job,
      "관련 있음(O)": r.relevant,
      "관련 없음(X)": r.notRelevant,
      미체크: r.unchecked,
      정확도: r.relevant + r.notRelevant ? `${Math.round((r.relevant / (r.relevant + r.notRelevant)) * 100)}%` : "-"
    }));
    console.table(rows);
    return;
  }

  const size = Math.max(1, Number(argValue("--size") ?? 20) || 20);
  const seed = argValue("--seed") ?? new Date().toISOString().slice(0, 10);
  const random = seededRandom(seed);
  const map = loadOccupationMap();
  const lines = [
    "# 채용공고 직종 연결 표본 검토",
    "",
    `- 만든 날: ${new Date().toISOString().slice(0, 10)} · seed: \`${seed}\` · 직업별 최대 ${size}건 무작위${config.fixture ? " · **고정 데이터(가짜)**" : ""}`,
    "- 각 줄의 대괄호 안에 `O`(이 직업 공고가 맞음) 또는 `X`(아님)를 적어. 회사·제목·직종코드만 보고 판단해.",
    "- 다 적었으면 `npm run postings:sample -- --tally`로 직업별 정확도(O ÷ (O+X))를 집계해.",
    ""
  ];
  let total = 0;
  for (const [jobCode, entry] of Object.entries(map.jobs)) {
    let snapshot = null;
    try {
      snapshot = readSnapshot(config.dataDir, jobCode);
    } catch {
      snapshot = null;
    }
    if (snapshot?.fixture && !config.fixture) snapshot = null;
    lines.push(`## ${jobCode} ${entry.job_name}`, "");
    if (!snapshot) {
      lines.push(`_스냅샷 없음 (mode=${entry.mode})_`, "");
      continue;
    }
    const pool = [...snapshot.items];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, size);
    total += picked.length;
    lines.push(`조회: ${snapshot.query.mode === "code" ? `직종 ${snapshot.query.occupation.join(", ")}` : `키워드 '${snapshot.query.keyword}'`} · 기준 ${snapshot.fetched_at} · 전체 ${snapshot.items.length}건 중 ${picked.length}건`, "");
    for (const item of picked) {
      lines.push(`- [ ] ${clean(item.company || "(회사명 없음)")} · ${clean(item.title)} · ${item.jobs_cd || "-"}`);
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`표본 ${total}건을 ${path.relative(PROJECT_ROOT, outPath)}에 썼어.`);
}

main();
