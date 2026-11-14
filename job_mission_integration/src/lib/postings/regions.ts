// 시도 판정 규칙(명세 2.3). 고용24 strtnmCd(도로명코드) 앞 2자리 → 시도,
// 코드가 없으면 region/basicAddr/카카오 응답의 시도 문자열을 정규화한다.

export const SIDO_NAMES = [
  "서울", "부산", "대구", "인천", "전남광주", "대전", "울산", "세종",
  "경기", "강원", "충북", "충남", "전북", "경북", "경남", "제주"
] as const;

export type Sido = (typeof SIDO_NAMES)[number];

export const METRO_SIDO: ReadonlySet<Sido> = new Set<Sido>(["서울", "인천", "경기"]);

// 도로명코드 앞 2자리 → 시도. 통합·개편 전 코드도 현재 시도로 모은다.
// 12는 2026-07-01 출범한 전남광주통합특별시의 새 코드로 참고 구현이 쓰는 값(공식 확인 필요).
export const SIDO_CODE_MAP: Readonly<Record<string, Sido>> = {
  "11": "서울",
  "26": "부산",
  "27": "대구",
  "28": "인천",
  "29": "전남광주", // 옛 광주광역시
  "30": "대전",
  "31": "울산",
  "36": "세종",
  "41": "경기",
  "42": "강원", // 옛 강원도
  "43": "충북",
  "44": "충남",
  "45": "전북", // 옛 전라북도
  "46": "전남광주", // 옛 전라남도
  "47": "경북",
  "48": "경남",
  "50": "제주",
  "51": "강원",
  "52": "전북",
  "12": "전남광주"
};

// 주소 첫 토큰 → 시도. 정식 명칭, 옛 명칭, 약칭을 모두 담는다.
export const SIDO_ALIASES: Readonly<Record<string, Sido>> = {
  "서울": "서울", "서울시": "서울", "서울특별시": "서울",
  "부산": "부산", "부산시": "부산", "부산광역시": "부산",
  "대구": "대구", "대구시": "대구", "대구광역시": "대구",
  "인천": "인천", "인천시": "인천", "인천광역시": "인천",
  "광주": "전남광주", "광주시": "전남광주", "광주광역시": "전남광주", "광주특별시": "전남광주",
  "전남": "전남광주", "전라남도": "전남광주",
  "전남광주": "전남광주", "전남광주특별시": "전남광주", "전남광주통합특별시": "전남광주",
  "대전": "대전", "대전시": "대전", "대전광역시": "대전",
  "울산": "울산", "울산시": "울산", "울산광역시": "울산",
  "세종": "세종", "세종시": "세종", "세종특별자치시": "세종",
  "경기": "경기", "경기도": "경기",
  "강원": "강원", "강원도": "강원", "강원특별자치도": "강원",
  "충북": "충북", "충청북도": "충북",
  "충남": "충남", "충청남도": "충남",
  "전북": "전북", "전라북도": "전북", "전북특별자치도": "전북",
  "경북": "경북", "경상북도": "경북",
  "경남": "경남", "경상남도": "경남",
  "제주": "제주", "제주도": "제주", "제주특별자치도": "제주"
};

export function sidoFromStrtnmCd(code: string | null | undefined): Sido | null {
  const digits = String(code ?? "").trim();
  if (!/^\d{5,}$/.test(digits)) return null;
  return SIDO_CODE_MAP[digits.slice(0, 2)] ?? null;
}

function tokens(text: string | null | undefined) {
  return String(text ?? "")
    .replace(/[(),]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function normalizeSidoName(text: string | null | undefined): Sido | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (SIDO_ALIASES[raw]) return SIDO_ALIASES[raw];
  const first = tokens(raw)[0];
  return first ? SIDO_ALIASES[first] ?? null : null;
}

// "경기 성남시 분당구" → "성남시 분당구", "서울특별시 강남구 테헤란로 1" → "강남구"
export function sigunguFromText(text: string | null | undefined): string | null {
  const parts = tokens(text);
  if (parts.length < 2 || !SIDO_ALIASES[parts[0]]) return null;
  const first = parts[1];
  if (!/(시|군|구)$/.test(first)) return null;
  const second = parts[2];
  if (/시$/.test(first) && second && /구$/.test(second)) return `${first} ${second}`;
  return first;
}

export function isMetro(sido: Sido | null | undefined): boolean | null {
  if (!sido) return null;
  return METRO_SIDO.has(sido);
}

export type RegionSource = "code" | "region" | "address";

export interface ResolvedRegion {
  sido: Sido | null;
  sigungu: string | null;
  source: RegionSource | null;
}

// 판정 우선순위: strtnmCd → region 텍스트 → basicAddr 텍스트. (카카오는 collector에서 마지막으로 보탠다)
export function resolveRegion(input: {
  strtnmCd?: string | null;
  region?: string | null;
  basicAddr?: string | null;
}): ResolvedRegion {
  const sigungu = sigunguFromText(input.basicAddr) ?? sigunguFromText(input.region);
  const byCode = sidoFromStrtnmCd(input.strtnmCd);
  if (byCode) return { sido: byCode, sigungu, source: "code" };
  const byRegion = normalizeSidoName(input.region);
  if (byRegion) return { sido: byRegion, sigungu, source: "region" };
  const byAddr = normalizeSidoName(input.basicAddr);
  if (byAddr) return { sido: byAddr, sigungu, source: "address" };
  return { sido: null, sigungu: null, source: null };
}
