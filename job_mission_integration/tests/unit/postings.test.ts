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
