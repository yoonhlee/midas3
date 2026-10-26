import fs from "node:fs";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const WORK24_LIST_URL = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do";
export const WORK24_DETAIL_URL = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210D01.do";
const TIMEOUT_MS = 15_000;

export type RawWanted = Record<string, string>;

export interface ListQuery {
  startPage: number;
  display: number;
  occupation?: string[];
  keyword?: string | null;
  regDate?: string;
  sortOrderBy?: "DESC" | "ASC";
  coTp?: string;
}

export interface ListPage {
  total: number;
  startPage: number;
  display: number;
  wanted: RawWanted[];
}

export interface WantedDetail {
  jobsNm: string;
  wantedTitle: string;
}

export interface Work24Client {
  list(query: ListQuery): Promise<ListPage>;
  detail(wantedAuthNo: string): Promise<WantedDetail | null>;
}

export class Work24Error extends Error {
  constructor(message: string, readonly kind: "api" | "http" | "network" | "parse") {
    super(message);
    this.name = "Work24Error";
  }
}

// 로그·오류 메시지에서 인증키를 가린다. 쿼리 파라미터와 Authorization 헤더 형태, 그리고 실제 키 값 자체를 모두 처리한다.
export function maskSecrets(text: string, secrets: Array<string | undefined | null> = []) {
  let out = String(text ?? "")
    .replace(/(authKey=)[^&\s"'<>]+/gi, "$1****")
    .replace(/(KakaoAK\s+)[^\s"'<>]+/g, "$1****");
  for (const secret of secrets) {
    const s = (secret ?? "").trim();
    if (s.length >= 4) out = out.split(s).join("****");
  }
  return out;
}

// 빈 값은 보내지 않는다(고용24는 "전체"를 파라미터 생략으로 표현). URLSearchParams가 '|'를 %7C로 인코딩한다.
export function buildListParams(authKey: string, q: ListQuery) {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    const s = String(value).trim();
    if (s) params.set(key, s);
  };
  put("authKey", authKey);
  put("callTp", "L");
  put("returnType", "XML");
  put("startPage", q.startPage);
  put("display", q.display);
  put("occupation", (q.occupation ?? []).filter(Boolean).join("|"));
  put("keyword", q.keyword ?? "");
  put("regDate", q.regDate ?? "");
  put("sortOrderBy", q.sortOrderBy ?? "");
  put("coTp", q.coTp ?? "");
  return params;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // 앞자리 0 코드(024101) 보존에 필수
  trimValues: true,
  isArray: (name) => name === "wanted"
});

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function rootOf(xml: string): Record<string, unknown> {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new Work24Error(`XML 형식 오류: ${valid.err.msg}`, "parse");
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new Work24Error(`XML 파싱 실패: ${(error as Error).message}`, "parse");
  }
  const rootKey = Object.keys(doc).find((k) => k !== "?xml");
  if (!rootKey) throw new Work24Error("XML 최상위 요소가 없어.", "parse");
  const root = doc[rootKey];
  if (root && typeof root === "object" && "error" in (root as object)) {
    const message = asText((root as Record<string, unknown>).error) || "알 수 없는 고용24 오류";
    throw new Work24Error(message, "api");
  }
  if (!root || typeof root !== "object") {
    // <wantedRoot></wantedRoot> 처럼 비어 있으면 빈 문자열로 파싱된다.
    return {};
  }
  return root as Record<string, unknown>;
}

export function parseListXml(xml: string): ListPage {
  const root = rootOf(xml);
  const rawWanted = root.wanted;
  const list = Array.isArray(rawWanted) ? rawWanted : rawWanted ? [rawWanted] : [];
  const wanted = list
    .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === "object")
    .map((w) => {
      const out: RawWanted = {};
      for (const [k, v] of Object.entries(w)) out[k] = asText(v);
      return out;
    });
  const toInt = (v: unknown, fallback: number) => {
    const n = Number.parseInt(asText(v), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    total: toInt(root.total, wanted.length),
    startPage: toInt(root.startPage, 1),
    display: toInt(root.display, wanted.length),
    wanted
  };
}

export function parseDetailXml(xml: string): WantedDetail | null {
  const root = rootOf(xml);
  const info = (root.wantedInfo ?? {}) as Record<string, unknown>;
  const jobsNm = asText(info.jobsNm).trim();
  const wantedTitle = asText(info.wantedTitle).trim();
  if (!jobsNm && !wantedTitle) return null;
  return { jobsNm, wantedTitle };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLiveWork24Client(options: {
  authKey: string;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Work24Client {
  const { authKey } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = options.delayMs ?? 300;
  const log = options.log ?? (() => {});
  let lastCallAt = 0;

  async function getText(url: string): Promise<string> {
    const masked = maskSecrets(url, [authKey]);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const wait = lastCallAt + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (error) {
        const message = maskSecrets((error as Error)?.message ?? String(error), [authKey]);
        if (attempt === 1) {
          log(`[work24] 네트워크 오류, 1회 재시도: ${message} (${masked})`);
          continue;
        }
        throw new Work24Error(`네트워크 오류: ${message}`, "network");
      }
      if (response.status >= 500 && attempt === 1) {
        log(`[work24] HTTP ${response.status}, 1회 재시도 (${masked})`);
        continue;
      }
      if (!response.ok) {
        throw new Work24Error(`HTTP ${response.status}`, "http");
      }
      // charset이 빠진 응답에 대비해 직접 UTF-8로 디코딩한다.
      const buffer = await response.arrayBuffer();
      return new TextDecoder("utf-8").decode(buffer);
    }
    throw new Work24Error("재시도 후에도 실패", "network");
  }

  return {
    async list(query) {
      const url = `${WORK24_LIST_URL}?${buildListParams(authKey, query).toString()}`;
      log(`[work24] GET ${maskSecrets(url, [authKey])}`);
      return parseListXml(await getText(url));
    },
    async detail(wantedAuthNo) {
      const params = new URLSearchParams({
        authKey,
        callTp: "D",
        returnType: "XML",
        infoSvc: "VALIDATION",
        wantedAuthNo
      });
      const url = `${WORK24_DETAIL_URL}?${params.toString()}`;
      log(`[work24] GET ${maskSecrets(url, [authKey])}`);
      return parseDetailXml(await getText(url));
    }
  };
}

// 고정 데이터 클라이언트: tests/fixtures/postings/work24/routes.json 의 규칙으로 XML 파일을 고른다.
interface FixtureRoute {
  occupation?: string;
  keyword?: string;
  coTp?: string;
  file: string;
}

export function createFixtureWork24Client(fixtureDir: string): Work24Client {
  const baseDir = path.join(fixtureDir, "work24");
  const routes = JSON.parse(fs.readFileSync(path.join(baseDir, "routes.json"), "utf8")) as {
    list: FixtureRoute[];
    detail: Record<string, string>;
    fallback: string;
  };
  const read = (file: string) => fs.readFileSync(path.join(baseDir, file), "utf8");
  return {
    async list(query) {
      const occupation = (query.occupation ?? []).join("|");
      const route = routes.list.find((r) =>
        (r.occupation ?? "") === occupation &&
        (r.keyword ?? "") === (query.keyword ?? "") &&
        (r.coTp ?? "") === (query.coTp ?? "")
      );
      const page = parseListXml(read(route?.file ?? routes.fallback));
      if (query.startPage > 1) return { ...page, startPage: query.startPage, wanted: [] };
      return page;
    },
    async detail(wantedAuthNo) {
      const file = routes.detail[wantedAuthNo];
      return file ? parseDetailXml(read(file)) : null;
    }
  };
}
