// 채용공고 스냅샷 갱신. 사용법: npm run postings:refresh -- [--job K000001080] [--verbose] [--fixture]
//   --fixture  고정 데이터로 스냅샷을 만든다(POSTINGS_DATA_DIR가 없으면 reports/postings-fixture).
import "dotenv/config";
import path from "node:path";
import { PROJECT_ROOT, isCollectable, loadPostingsConfig } from "../src/lib/postings/config.js";
import { PostingsService } from "../src/lib/postings/service.js";
import { qualityRow } from "../src/lib/postings/store.js";
import { maskSecrets } from "../src/lib/postings/work24Client.js";

function argValue(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);
const flagText = (v: boolean | null | undefined) => (v === true ? "적용" : v === false ? "무시됨" : "확인 못 함");

async function main() {
  const fixture = hasFlag("--fixture");
  const verbose = hasFlag("--verbose");
  const config = loadPostingsConfig(process.env, fixture ? { fixture: true } : {});
  const secrets = [config.work24Key, config.kakaoKey];
  if (!isCollectable(config)) {
    console.log("수집할 수 없어: POSTINGS_ENABLED=false 이거나 WORK24_RECRUIT_AUTH_KEY가 없어. (.env에 키를 넣거나 --fixture로 고정 데이터를 써)");
    return;
  }
  console.log(`데이터 위치: ${path.relative(PROJECT_ROOT, config.dataDir) || "."}${config.fixture ? " (고정 데이터 모드)" : ""}`);
  if (!config.fixture && !config.kakaoKey) console.log("KAKAO_REST_API_KEY가 없어 좌표 없이 수집해(지도에는 안 나오고 목록에만 나와).");
  const service = new PostingsService(config);
  const job = argValue("--job");
  const results = await service.refresh(job ? [job] : undefined, (m) => {
    if (verbose || m.startsWith("▶") || m.includes("실패")) console.log(maskSecrets(m, secrets));
  });

  const rows = results.map((r) => {
    if (!r.snapshot) {
      return { 직업: r.job_code, 결과: r.skipped ? `건너뜀(${r.skipped})` : `실패: ${r.error}` };
    }
    const q = qualityRow(r.snapshot);
    const c = r.snapshot.counts;
    return {
      직업: `${r.job_code} ${r.snapshot.job_name}`,
      결과: "성공",
      받은수: q.received,
      "중복/마감/필터": `${q.duplicates_removed}/${q.expired_removed}/${q.filtered_removed}`,
      최종: q.kept,
      "좌표(정확/대략/없음)": `${pct(q.geo_rate.address)}/${pct(q.geo_rate.region)}/${pct(q.geo_rate.none)}`,
      "수도권/비수도권/미상": `${c.metro}/${c.nonmetro}/${c.region_unknown}`,
      시도교차일치: q.sido_cross_check.compared ? `${q.sido_cross_check.agreed}/${q.sido_cross_check.compared}` : "-",
      키워드일치: pct(q.relevance_keyword_hit_rate),
      직종검증: flagText(r.snapshot.checks.occupation_filter_applied),
      등록기간검증: flagText(r.snapshot.checks.regdate_filter_applied),
      기업형태검증: Object.entries(r.snapshot.checks.company_type_filter_applied).map(([k, v]) => `${k}:${flagText(v)}`).join(" ")
    };
  });
  console.table(rows);
  if (verbose) {
    for (const r of results) {
      if (r.snapshot?.errors.length) console.log(`${r.job_code} 경고:`, r.snapshot.errors.map((e) => `[${e.stage}] ${e.message}`).join(" / "));
    }
  }
  console.log(`품질 지표: ${path.relative(PROJECT_ROOT, path.join(config.dataDir, "quality.json"))}`);
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(maskSecrets((error as Error)?.stack ?? String(error), [process.env.WORK24_RECRUIT_AUTH_KEY, process.env.KAKAO_REST_API_KEY]));
  process.exitCode = 1;
});
