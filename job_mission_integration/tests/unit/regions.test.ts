import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDO_ALIASES,
  SIDO_CODE_MAP,
  SIDO_NAMES,
  isMetro,
  normalizeSidoName,
  resolveRegion,
  sidoFromStrtnmCd,
  sigunguFromText
} from "../../src/lib/postings/regions.js";

test("시도 코드 정규화: 그대로 쓰는 코드와 통합·개편 코드", () => {
  const expected: Record<string, string> = {
    "11": "서울", "26": "부산", "27": "대구", "28": "인천", "30": "대전", "31": "울산", "36": "세종",
    "41": "경기", "43": "충북", "44": "충남", "47": "경북", "48": "경남", "50": "제주",
    "42": "강원", "51": "강원", "45": "전북", "52": "전북",
    "29": "전남광주", "46": "전남광주", "12": "전남광주"
  };
  for (const [prefix, sido] of Object.entries(expected)) {
    assert.equal(sidoFromStrtnmCd(`${prefix}0000000000`), sido, prefix);
  }
  assert.equal(Object.keys(SIDO_CODE_MAP).length, Object.keys(expected).length);
});

test("도로명코드 예외 입력", () => {
  assert.equal(sidoFromStrtnmCd("116804166040"), "서울");
  assert.equal(sidoFromStrtnmCd(""), null);
  assert.equal(sidoFromStrtnmCd(null), null);
  assert.equal(sidoFromStrtnmCd("99000000000"), null);
  assert.equal(sidoFromStrtnmCd("11a80"), null);
});

test("주소 문자열 정규화 전체 표가 16개 시도로만 모인다", () => {
  const names = new Set<string>(SIDO_NAMES);
  for (const [alias, sido] of Object.entries(SIDO_ALIASES)) {
    assert.ok(names.has(sido), `${alias} → ${sido}`);
    assert.equal(normalizeSidoName(alias), sido);
  }
  assert.equal(new Set(Object.values(SIDO_ALIASES)).size, 16);
});

test("명세 예시 대응표", () => {
  const cases: Array<[string, string]> = [
    ["서울", "서울"], ["서울특별시", "서울"], ["서울시", "서울"],
    ["광주", "전남광주"], ["광주광역시", "전남광주"], ["광주특별시", "전남광주"], ["전남", "전남광주"],
    ["전라남도", "전남광주"], ["전남광주", "전남광주"], ["전남광주통합특별시", "전남광주"],
    ["강원도", "강원"], ["강원특별자치도", "강원"], ["전라북도", "전북"], ["전북특별자치도", "전북"],
    ["세종특별자치시", "세종"], ["제주특별자치도", "제주"]
  ];
  for (const [input, sido] of cases) assert.equal(normalizeSidoName(input), sido, input);
  assert.equal(normalizeSidoName("광주 북구"), "전남광주");
  assert.equal(normalizeSidoName("전남광주통합특별시 동구"), "전남광주");
  assert.equal(normalizeSidoName("광주특별시 서구"), "전남광주");
  assert.equal(normalizeSidoName("경기 광주시"), "경기");
  assert.equal(normalizeSidoName("해외"), null);
  assert.equal(normalizeSidoName(""), null);
});

test("시군구 추출", () => {
  assert.equal(sigunguFromText("서울특별시 강남구 가상로 1"), "강남구");
  assert.equal(sigunguFromText("경기 성남시 분당구"), "성남시 분당구");
  assert.equal(sigunguFromText("전라남도 나주시 가상길 10"), "나주시");
  assert.equal(sigunguFromText("세종특별자치시 한누리대로 1"), null);
  assert.equal(sigunguFromText(""), null);
});

test("수도권 판정", () => {
  for (const sido of SIDO_NAMES) {
    assert.equal(isMetro(sido), ["서울", "인천", "경기"].includes(sido), sido);
  }
  assert.equal(isMetro(null), null);
});

test("판정 우선순위: 도로명코드 → region → basicAddr", () => {
  assert.deepEqual(resolveRegion({ strtnmCd: "421103000001", region: "서울 강남구", basicAddr: "" }).sido, "강원");
  assert.equal(resolveRegion({ strtnmCd: "421103000001" }).source, "code");
  const byRegion = resolveRegion({ strtnmCd: "", region: "광주 북구", basicAddr: "" });
  assert.equal(byRegion.sido, "전남광주");
  assert.equal(byRegion.source, "region");
  assert.equal(byRegion.sigungu, "북구");
  const byAddr = resolveRegion({ strtnmCd: "", region: "", basicAddr: "제주특별자치도 제주시 테스트로 7" });
  assert.equal(byAddr.sido, "제주");
  assert.equal(byAddr.source, "address");
  assert.deepEqual(resolveRegion({}), { sido: null, sigungu: null, source: null });
});
