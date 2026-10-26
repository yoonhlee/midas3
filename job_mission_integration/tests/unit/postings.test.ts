import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_DIR } from "../../src/lib/postings/config.js";
import {
  Work24Error,
  buildListParams,
  createFixtureWork24Client,
  createLiveWork24Client,
  maskSecrets,
  parseDetailXml,
  parseListXml
} from "../../src/lib/postings/work24Client.js";
import {
  applyTitleFilter,
  dedupeById,
  isExpired,
  keywordHitRate,
  kstDateString,
  parseCloseDt,
  parseYyMmDd,
  wantedToBaseItem
} from "../../src/lib/postings/parse.js";
import os from "node:os";
import {
  GeocodeCache,
  GeocoderConfigError,
  createGeocoder,
  kakaoLookup,
  parseKakaoResponse
} from "../../src/lib/postings/geocoder.js";
import {
  checkOccupationFilter,
  checkRegDateFilter,
  collectJob,
  isCompanyTypeIgnored
} from "../../src/lib/postings/collector.js";
import { FIXTURE_NOW } from "../../src/lib/postings/config.js";
import { fixtureLookup } from "../../src/lib/postings/geocoder.js";
import { loadOccupationMap } from "../../src/lib/postings/occupationMap.js";
import type { ListPage, Work24Client } from "../../src/lib/postings/work24Client.js";
import { decidePostingsStatus } from "../../src/lib/postings/store.js";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, "work24", name), "utf8");

// ── XML 파싱 ─────────────────────────────────────────────
test("XML: wanted 여러 건은 배열, 앞자리 0 직종코드 보존", () => {
  const page = parseListXml(fixture("list_K000000872.xml"));
  assert.equal(page.total, 8);
  assert.equal(page.wanted.length, 8);
  assert.equal(page.wanted[0].jobsCd, "024101");
  assert.equal(page.wanted[0].strtnmCd, "111403000001");
});

test("XML: wanted 1건도 배열로 정규화", () => {
  const page = parseListXml(fixture("list_K000007519.xml"));
  assert.equal(page.total, 1);
  assert.ok(Array.isArray(page.wanted));
  assert.equal(page.wanted.length, 1);
  assert.equal(page.wanted[0].wantedAuthNo, "F7519000000001");
});

test("XML: total=0이면 빈 배열", () => {
  const page = parseListXml(fixture("empty.xml"));
  assert.equal(page.total, 0);
  assert.deepEqual(page.wanted, []);
});

test("XML: GO24/error 응답은 Work24Error(api)", () => {
  assert.throws(() => parseListXml(fixture("error_service.xml")), (error: unknown) => {
    assert.ok(error instanceof Work24Error);
    assert.equal(error.kind, "api");
    assert.match(error.message, /서비스가 존재하지 않습니다/);
    return true;
  });
});

test("XML: 깨진 문서는 parse 오류", () => {
  assert.throws(() => parseListXml("<wantedRoot><total>1</total><wanted>"), Work24Error);
});

test("XML: 상세 응답에서 직종명", () => {
  assert.deepEqual(parseDetailXml(fixture("detail_F1179000000001.xml")), {
    jobsNm: "(가상) 투자 분석가",
    wantedTitle: "리서치센터 애널리스트"
  });
});

// ── 파라미터와 키 마스킹 ──────────────────────────────────
test("목록 파라미터: 빈 값 제외, '|'는 %7C", () => {
  const params = buildListParams("SECRETKEY123", {
    startPage: 1,
    display: 100,
    occupation: ["024101", "024102"],
    keyword: "",
    regDate: "M-1",
    sortOrderBy: "DESC",
    coTp: undefined
  });
  const qs = params.toString();
  assert.match(qs, /occupation=024101%7C024102/);
  assert.ok(!qs.includes("keyword="));
  assert.ok(!qs.includes("coTp="));
  assert.match(qs, /callTp=L/);
  assert.match(qs, /returnType=XML/);
  assert.equal(params.get("keyword"), null);
});

test("키 마스킹: authKey, KakaoAK, 키 값 자체", () => {
  const url = "https://x/y.do?authKey=ABCD-1234&callTp=L";
  assert.equal(maskSecrets(url), "https://x/y.do?authKey=****&callTp=L");
  assert.equal(maskSecrets("Authorization: KakaoAK abcdef123"), "Authorization: KakaoAK ****");
  assert.equal(maskSecrets("오류: key ABCD-1234 거부", ["ABCD-1234"]), "오류: key **** 거부");
  assert.equal(maskSecrets("no secret here", ["", undefined]), "no secret here");
});

test("실제 클라이언트: 5xx는 1회 재시도, 로그에 키가 안 남음", async () => {
  const logs: string[] = [];
  let calls = 0;
  const fakeFetch = (async (input: string | URL | Request) => {
    calls += 1;
    assert.match(String(input), /authKey=REALKEY999/);
    if (calls === 1) return new Response("busy", { status: 503 });
    return new Response(new TextEncoder().encode(fixture("list_K000000872.xml")), { status: 200 });
  }) as typeof fetch;
  const client = createLiveWork24Client({ authKey: "REALKEY999", delayMs: 0, fetchImpl: fakeFetch, log: (m) => logs.push(m) });
  const page = await client.list({ startPage: 1, display: 100, occupation: ["024101"] });
  assert.equal(calls, 2);
  assert.equal(page.wanted.length, 8);
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.includes("REALKEY999"), line);
});

test("실제 클라이언트: 4xx는 재시도 없이 실패, 네트워크 오류 메시지에서도 키를 가림", async () => {
  let calls = 0;
  const client = createLiveWork24Client({
    authKey: "REALKEY999",
    delayMs: 0,
    fetchImpl: (async () => { calls += 1; return new Response("no", { status: 401 }); }) as typeof fetch
  });
  await assert.rejects(client.list({ startPage: 1, display: 10 }), /HTTP 401/);
  assert.equal(calls, 1);

  const failing = createLiveWork24Client({
    authKey: "REALKEY999",
    delayMs: 0,
    fetchImpl: (async () => { throw new Error("connect failed authKey=REALKEY999"); }) as typeof fetch
  });
  await assert.rejects(failing.list({ startPage: 1, display: 10 }), (error: Error) => {
    assert.ok(!error.message.includes("REALKEY999"));
    return true;
  });
});

test("고정 데이터 클라이언트: 조건별 파일 선택과 기본값", async () => {
  const client = createFixtureWork24Client(FIXTURE_DIR);
  assert.equal((await client.list({ startPage: 1, display: 100, occupation: ["135200"] })).wanted.length, 13);
  assert.equal((await client.list({ startPage: 1, display: 100, occupation: ["135200"], coTp: "04" })).wanted.length, 1);
  await assert.rejects(client.list({ startPage: 1, display: 100, occupation: ["135200"], coTp: "05" }), Work24Error);
  assert.equal((await client.list({ startPage: 1, display: 100, occupation: ["999999"] })).total, 0);
  assert.equal((await client.detail("F1179000000001"))?.jobsNm, "(가상) 투자 분석가");
  assert.equal(await client.detail("없음"), null);
});

// ── 날짜와 마감 ───────────────────────────────────────────
test("날짜: yy-MM-dd → 20yy-MM-dd, 잘못된 날짜는 null", () => {
  assert.equal(parseYyMmDd("26-09-28"), "2026-09-28");
  assert.equal(parseYyMmDd("2026-10-01"), "2026-10-01");
  assert.equal(parseYyMmDd("26-02-30"), null);
  assert.equal(parseYyMmDd(""), null);
});

test("closeDt 세 가지 형식", () => {
  assert.deepEqual(parseCloseDt("26-10-31"), { close_type: "date", close_date: "2026-10-31" });
  assert.deepEqual(parseCloseDt("채용시까지  26-10-30"), { close_type: "until_filled", close_date: "2026-10-30" });
  assert.deepEqual(parseCloseDt("채용시까지"), { close_type: "until_filled", close_date: null });
  assert.deepEqual(parseCloseDt(""), { close_type: "unknown", close_date: null });
});

test("한국 시간 기준 오늘: 자정 경계", () => {
  // UTC 14:59 = KST 23:59 (같은 날), UTC 15:00 = KST 다음날 00:00
  assert.equal(kstDateString(new Date("2026-10-25T14:59:59Z")), "2026-10-25");
  assert.equal(kstDateString(new Date("2026-10-25T15:00:00Z")), "2026-10-26");
});

test("마감 판정: 오늘 마감은 남기고 어제 마감은 제외, 날짜 없는 채용시까지는 남김", () => {
  const justBeforeMidnight = kstDateString(new Date("2026-10-26T14:59:00Z")); // KST 10-26 23:59
  const afterMidnight = kstDateString(new Date("2026-10-26T15:00:00Z")); // KST 10-27 00:00
  const item = { close_date: "2026-10-26" };
  assert.equal(isExpired(item, justBeforeMidnight), false);
  assert.equal(isExpired(item, afterMidnight), true);
  assert.equal(isExpired({ close_date: null }, afterMidnight), false);
});

// ── 항목 변환, 중복, 필터 ──────────────────────────────────
test("wanted → 항목: detailAddr는 쓰지 않고 급여·URL 정리", () => {
  const page = parseListXml(fixture("list_K000001080.xml"));
  const item = wantedToBaseItem(page.wanted[0]);
  assert.equal(item.id, "F1080000000001");
  assert.equal(item.address, "서울특별시 강남구 가상로 1");
  assert.ok(!JSON.stringify(item).includes("301호"));
  assert.equal(item.salary_text, "연봉 3000만원 ~ 4000만원");
  assert.equal(item.close_type, "until_filled");
  assert.equal(item.close_date, "2026-11-30");
  assert.equal(item.reg_date, "2026-10-20");
  assert.match(item.url, /^https:\/\//);
  const bad = wantedToBaseItem({ wantedAuthNo: "X", wantedInfoUrl: "javascript:alert(1)" });
  assert.equal(bad.url, "");
  assert.equal(bad.company, "");
});

test("중복 제거: wantedAuthNo 기준", () => {
  const page = parseListXml(fixture("list_K000001080.xml"));
  const result = dedupeById(page.wanted.map(wantedToBaseItem));
  assert.equal(result.removed, 1);
  assert.equal(result.items.length, 12);
});

test("제목 필터: include/exclude", () => {
  const items = [{ title: "투자분석 심사역" }, { title: "보험 영업" }, { title: "투자분석 인턴" }];
  assert.equal(applyTitleFilter(items, [], []).removed, 0);
  assert.deepEqual(applyTitleFilter(items, ["투자"], ["인턴"]).items, [{ title: "투자분석 심사역" }]);
  assert.equal(applyTitleFilter(items, ["투자"], ["인턴"]).removed, 2);
});

test("제목 키워드 일치율", () => {
  assert.equal(keywordHitRate([{ title: "BI 분석" }, { title: "영업" }], ["bi"]), 0.5);
  assert.equal(keywordHitRate([], ["a"]), null);
  assert.equal(keywordHitRate([{ title: "a" }], []), null);
});

// ── 지오코딩 ──────────────────────────────────────────────

const kakaoDoc = (type: string, x: number, y: number, r1 = "서울", r2 = "강남구") => ({
  documents: [{ address_type: type, x: String(x), y: String(y), address: { region_1depth_name: r1, region_2depth_name: r2 }, road_address: null }]
});

test("카카오 응답: address_type으로 정밀도, 시도 정규화, 한국 범위 밖은 버림", () => {
  assert.equal(parseKakaoResponse(kakaoDoc("ROAD_ADDR", 127, 37.5))?.precision, "address");
  assert.equal(parseKakaoResponse(kakaoDoc("REGION_ADDR", 127, 37.5))?.precision, "address");
  assert.equal(parseKakaoResponse(kakaoDoc("ROAD", 127, 37.5))?.precision, "region");
  assert.equal(parseKakaoResponse(kakaoDoc("REGION", 127, 37.5))?.precision, "region");
  assert.equal(parseKakaoResponse(kakaoDoc("REGION", 126.9, 35.1, "전남광주통합특별시", "북구"))?.sido, "전남광주");
  assert.equal(parseKakaoResponse(kakaoDoc("ROAD_ADDR", 139.7, 35.6)), null);
  assert.equal(parseKakaoResponse({ documents: [] }), null);
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postings-test-"));
}

test("지오코딩 캐시: 성공은 재사용, 실패는 7일 동안 다시 묻지 않음", async () => {
  const dir = tempDir();
  const file = path.join(dir, "geocode-cache.json");
  let clock = new Date("2026-10-01T00:00:00Z");
  const asked: string[] = [];
  const lookup = async (q: string) => {
    asked.push(q);
    return q.includes("없는") ? { documents: [] } : kakaoDoc("ROAD_ADDR", 127.05, 37.51);
  };
  const cache = new GeocodeCache(file);
  const geocoder = createGeocoder({ lookup, cache, now: () => clock });
  assert.equal((await geocoder.geocode("서울특별시  강남구 가상로 1"))?.lat, 37.51);
  assert.equal((await geocoder.geocode("서울특별시 강남구 가상로 1"))?.lat, 37.51); // 공백 정규화 후 같은 키
  assert.equal(await geocoder.geocode("없는 주소"), null);
  assert.equal(await geocoder.geocode("없는 주소"), null);
  assert.deepEqual(asked, ["서울특별시 강남구 가상로 1", "없는 주소"]);
  cache.save();

  // 파일에서 다시 읽어도 재사용
  clock = new Date("2026-10-05T00:00:00Z");
  const reloaded = createGeocoder({ lookup, cache: new GeocodeCache(file), now: () => clock });
  await reloaded.geocode("서울특별시 강남구 가상로 1");
  await reloaded.geocode("없는 주소");
  assert.equal(asked.length, 2);

  // 7일이 지나면 실패 항목만 다시 묻는다
  clock = new Date("2026-10-09T00:00:01Z");
  const later = createGeocoder({ lookup, cache: new GeocodeCache(file), now: () => clock });
  await later.geocode("서울특별시 강남구 가상로 1");
  await later.geocode("없는 주소");
  assert.deepEqual(asked, ["서울특별시 강남구 가상로 1", "없는 주소", "없는 주소"]);
});

test("카카오: 카카오맵 사용 설정 꺼짐은 안내 오류, 키는 노출하지 않음", async () => {
  const lookup = kakaoLookup("KAKAOSECRET1", (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "KakaoAK KAKAOSECRET1");
    return new Response('{"errorType":"NotAuthorizedError","message":"App(123) disabled OPEN_MAP_AND_LOCAL service."}', { status: 403 });
  }) as typeof fetch, 0);
  await assert.rejects(lookup("서울"), (error: Error) => {
    assert.ok(error instanceof GeocoderConfigError);
    assert.match(error.message, /카카오맵 사용 설정을 켜야 해/);
    assert.ok(!error.message.includes("KAKAOSECRET1"));
    return true;
  });
});

// ── 조건 적용 검증과 수집 ──────────────────────────────────

test("기업형태: total이 기본 조회와 같고 20건 이상이면 무시된 조건", () => {
  assert.equal(isCompanyTypeIgnored(132, 132), true);
  assert.equal(isCompanyTypeIgnored(20, 20), true);
  assert.equal(isCompanyTypeIgnored(19, 19), false);
  assert.equal(isCompanyTypeIgnored(5, 132), false);
});

test("직종 검증: 95% 미만이면 미적용으로 보고 요청 코드만 남김", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ jobs_cd: i === 0 ? "999999" : "135200" }));
  assert.equal(checkOccupationFilter(items, ["135200"]).applied, true); // 19/20 = 95%
  const worse = [...items, { jobs_cd: "111111" }];
  const result = checkOccupationFilter(worse, ["135200"]);
  assert.equal(result.applied, false);
  assert.equal(result.removed, 2);
  assert.equal(checkOccupationFilter([], ["135200"]).applied, true);
});

test("등록기간 검증: 32일 넘는 공고가 5% 넘으면 미적용으로 보고 제외", () => {
  const recent = Array.from({ length: 19 }, () => ({ reg_date: "2026-10-20" }));
  assert.equal(checkRegDateFilter([...recent, { reg_date: "2026-08-01" }], "2026-10-26").applied, true);
  const result = checkRegDateFilter([...recent, { reg_date: "2026-08-01" }, { reg_date: "2026-07-01" }], "2026-10-26");
  assert.equal(result.applied, false);
  assert.equal(result.removed, 2);
  assert.equal(checkRegDateFilter([{ reg_date: "2026-09-24" }], "2026-10-26").applied, true); // 정확히 32일
});

function pageOf(n: number, total: number, extra: Partial<Record<string, string>> = {}): ListPage {
  return {
    total,
    startPage: 1,
    display: 100,
    wanted: Array.from({ length: n }, (_, i) => ({
      wantedAuthNo: `${extra.prefix ?? "W"}${i}`,
      title: "데이터 분석",
      jobsCd: "135200",
      regDt: "26-10-20",
      closeDt: "채용시까지",
      region: "서울 강남구",
      company: "가상"
    }))
  };
}

test("수집: 페이지 반복은 total에 닿을 때까지, coTp가 무시되면 그 기업형태 표시를 끔", async () => {
  const entry = loadOccupationMap().jobs.K000001080;
  const calls: string[] = [];
  const client: Work24Client = {
    async list(q) {
      calls.push(`${q.coTp ?? "base"}:${q.startPage}`);
      if (!q.coTp) return q.startPage <= 2 ? pageOf(100, 230) : { ...pageOf(30, 230), wanted: pageOf(30, 230).wanted.map((w, i) => ({ ...w, wantedAuthNo: `P3-${i}` })) };
      if (q.coTp === "01") return pageOf(100, 230); // 기본과 total이 같음 → 무시된 조건
      return pageOf(1, 1, { prefix: "W" });
    },
    async detail() { return null; }
  };
  const snapshot = await collectJob({
    jobCode: "K000001080", entry, client, geocoder: null, regDate: "M-1", maxPages: 10,
    now: FIXTURE_NOW, fetchedAt: FIXTURE_NOW, fixture: true
  });
  assert.deepEqual(calls.filter((c) => c.startsWith("base")), ["base:1", "base:2", "base:3"]);
  assert.equal(snapshot.query.pages_fetched, 3);
  assert.equal(snapshot.counts.received, 230);
  assert.equal(snapshot.counts.duplicates_removed, 100); // 1·2페이지 id가 같음
  assert.equal(snapshot.checks.company_type_filter_applied["01"], false);
  assert.equal(snapshot.checks.company_type_filter_applied["04"], true);
  assert.equal(snapshot.counts.company_type.large, 0);
  assert.equal(snapshot.counts.company_type.public, 1);
  assert.equal(snapshot.counts.geo_none, snapshot.counts.kept);
});

test("수집: 고정 데이터 데이터분석가 스냅샷", async () => {
  const entry = loadOccupationMap().jobs.K000001080;
  const dir = tempDir();
  const snapshot = await collectJob({
    jobCode: "K000001080", entry,
    client: createFixtureWork24Client(FIXTURE_DIR),
    geocoder: createGeocoder({ lookup: fixtureLookup(FIXTURE_DIR), cache: new GeocodeCache(path.join(dir, "c.json")) }),
    regDate: "M-1", maxPages: 10, now: FIXTURE_NOW, fetchedAt: FIXTURE_NOW, fixture: true
  });
  const c = snapshot.counts;
  assert.equal(c.received, 13);
  assert.equal(c.duplicates_removed, 1);
  assert.equal(c.expired_removed, 1);
  assert.equal(c.kept, 11);
  assert.deepEqual([c.metro, c.nonmetro, c.region_unknown], [6, 4, 1]);
  assert.deepEqual([c.geo_address, c.geo_region, c.geo_none], [8, 1, 2]);
  assert.deepEqual(c.sido_cross_check, { compared: 8, agreed: 8 });
  assert.equal(c.by_sido["전남광주"], 2);
  assert.equal(snapshot.checks.company_type_filter_applied["05"], null);
  assert.equal(snapshot.fetched_at, "2026-10-26T12:00:00+09:00");
  assert.ok(snapshot.errors.some((e) => e.stage === "coTp=05"));
  assert.ok(!JSON.stringify(snapshot).includes("detailAddr"));
  assert.ok(!JSON.stringify(snapshot).includes("301호"));
});

test("수집: 상품기획자 고정 데이터는 요청하지 않은 직종(024302)이 섞여 직종 검증이 실패", async () => {
  const entry = loadOccupationMap().jobs.K000000997;
  const snapshot = await collectJob({
    jobCode: "K000000997", entry, client: createFixtureWork24Client(FIXTURE_DIR), geocoder: null,
    regDate: "M-1", maxPages: 10, now: FIXTURE_NOW, fetchedAt: FIXTURE_NOW, fixture: true
  });
  assert.equal(snapshot.checks.occupation_filter_applied, false);
  assert.equal(snapshot.counts.occupation_mismatch_removed, 1);
  assert.ok(snapshot.items.every((i) => i.jobs_cd === "024301"));
});

// ── API 상태 결정 ─────────────────────────────────────────

test("API 상태 결정: ok / empty / stale / unmapped / unconfigured / error", () => {
  const snap = (n: number) => ({ fetched_at: "2026-10-26T05:00:00+09:00", itemCount: n });
  const base = { enabled: true, collectable: true, mode: "code" as const, snapshot: snap(3), run: null };
  assert.equal(decidePostingsStatus(base), "ok");
  assert.equal(decidePostingsStatus({ ...base, snapshot: snap(0) }), "empty");
  assert.equal(decidePostingsStatus({ ...base, run: { last_failure_at: "2026-10-26T01:00:00Z" } }), "stale");
  assert.equal(decidePostingsStatus({ ...base, run: { last_failure_at: "2026-10-25T01:00:00Z" } }), "ok");
  assert.equal(decidePostingsStatus({ ...base, mode: "tbd" }), "unmapped");
  assert.equal(decidePostingsStatus({ ...base, mode: null }), "unmapped");
  assert.equal(decidePostingsStatus({ ...base, enabled: false }), "unconfigured");
  assert.equal(decidePostingsStatus({ ...base, snapshot: null, collectable: false }), "unconfigured");
  assert.equal(decidePostingsStatus({ ...base, snapshot: null }), "error");
  assert.equal(decidePostingsStatus({ ...base, snapshotReadError: true }), "error");
  // 키가 없어도 이전 스냅샷이 있으면 보여준다
  assert.equal(decidePostingsStatus({ ...base, collectable: false }), "ok");
});

test("서비스: 실패하면 이전 스냅샷은 두고 stale, 실제 모드는 고정 데이터 스냅샷을 무시", async () => {
  const { PostingsService } = await import("../../src/lib/postings/service.js");
  const dir = tempDir();
  const fixtureService = new PostingsService(
    { enabled: true, fixture: true, work24Key: "", kakaoKey: "", dataDir: dir, regDate: "M-1", maxPages: 10, refreshHours: 24, requestDelayMs: 0 }
  );
  const ok = await fixtureService.refresh(["K000001080"]);
  assert.equal(ok[0].ok, true);
  assert.equal(fixtureService.getJobPostings("K000001080").status, "ok");
  assert.ok(fs.existsSync(path.join(dir, "quality.json")));

  const failing = new PostingsService(
    { enabled: true, fixture: true, work24Key: "", kakaoKey: "", dataDir: dir, regDate: "M-1", maxPages: 10, refreshHours: 24, requestDelayMs: 0 },
    { client: { async list() { throw new Error("boom authKey=SECRETX"); }, async detail() { return null; } } }
  );
  const failed = await failing.refresh(["K000001080"]);
  assert.equal(failed[0].ok, false);
  assert.ok(!failed[0].error?.includes("SECRETX"));
  const res = failing.getJobPostings("K000001080");
  assert.equal(res.status, "stale");
  assert.equal(res.items.length, 11);

  const live = new PostingsService(
    { enabled: true, fixture: false, work24Key: "k", kakaoKey: "", dataDir: dir, regDate: "M-1", maxPages: 10, refreshHours: 24, requestDelayMs: 0 }
  );
  assert.equal(live.getJobPostings("K000001080").status, "error");
  assert.equal(live.getJobPostings("K000001080").items.length, 0);
  assert.equal(live.getJobPostings("K000001179").status, "unmapped");
});
