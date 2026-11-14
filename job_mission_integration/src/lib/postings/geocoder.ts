import fs from "node:fs";
import path from "node:path";
import { maskSecrets } from "./work24Client.js";
import { normalizeSidoName, type Sido } from "./regions.js";

export const KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json";
const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export interface GeoResult {
  lat: number;
  lng: number;
  precision: "address" | "region";
  sido: Sido | null;
  sigungu: string | null;
}

type CacheEntry =
  | (GeoResult & { cached_at: string })
  | { failed: true; cached_at: string };

export class GeocoderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeocoderConfigError";
  }
}

export function normalizeAddressKey(address: string) {
  return String(address ?? "").replace(/\s+/g, " ").trim();
}

export function inKoreaBounds(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132;
}

// 카카오 주소 검색 응답 → 좌표. ROAD_ADDR/REGION_ADDR = 정확 주소, ROAD/REGION = 대략 위치.
export function parseKakaoResponse(json: unknown): GeoResult | null {
  const doc = (json as { documents?: unknown[] })?.documents?.[0] as Record<string, any> | undefined;
  if (!doc) return null;
  const lat = Number(doc.y);
  const lng = Number(doc.x);
  if (!inKoreaBounds(lat, lng)) return null;
  const type = String(doc.address_type ?? "");
  const precision: GeoResult["precision"] = type === "ROAD_ADDR" || type === "REGION_ADDR" ? "address" : "region";
  const area = doc.road_address ?? doc.address ?? {};
  const sigungu = String(area.region_2depth_name ?? doc.address?.region_2depth_name ?? "").trim() || null;
  return {
    lat,
    lng,
    precision,
    sido: normalizeSidoName(area.region_1depth_name ?? doc.address?.region_1depth_name),
    sigungu
  };
}

export class GeocodeCache {
  private entries: Record<string, CacheEntry> = {};
  private dirty = false;

  constructor(private readonly filePath: string | null) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        this.entries = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        this.entries = {};
      }
    }
  }

  // hit: 성공 캐시, failed: 7일 안의 실패 캐시(다시 묻지 않음), miss: 조회 필요
  lookup(key: string, now: Date): { kind: "hit"; value: GeoResult } | { kind: "failed" } | { kind: "miss" } {
    const entry = this.entries[key];
    if (!entry) return { kind: "miss" };
    if ("failed" in entry) {
      const age = now.getTime() - Date.parse(entry.cached_at);
      return Number.isFinite(age) && age < FAILED_RETRY_MS ? { kind: "failed" } : { kind: "miss" };
    }
    const { cached_at: _cachedAt, ...value } = entry;
    return { kind: "hit", value };
  }

  set(key: string, value: GeoResult | null, now: Date) {
    this.entries[key] = value ? { ...value, cached_at: now.toISOString() } : { failed: true, cached_at: now.toISOString() };
    this.dirty = true;
  }

  save() {
    if (!this.filePath || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 1), "utf8");
    fs.renameSync(tmp, this.filePath);
    this.dirty = false;
  }
}

export type GeocodeLookup = (query: string) => Promise<unknown>;

export interface Geocoder {
  // 결과 없음이면 null. 설정 오류(키·카카오맵 사용 설정)는 GeocoderConfigError를 던진다.
  geocode(query: string): Promise<GeoResult | null>;
  stats: { requests: number; cacheHits: number };
}

export function createGeocoder(options: { lookup: GeocodeLookup; cache: GeocodeCache; now?: () => Date }): Geocoder {
  const now = options.now ?? (() => new Date());
  const stats = { requests: 0, cacheHits: 0 };
  return {
    stats,
    async geocode(query) {
      const key = normalizeAddressKey(query);
      if (!key) return null;
      const cached = options.cache.lookup(key, now());
      if (cached.kind === "hit") {
        stats.cacheHits += 1;
        return cached.value;
      }
      if (cached.kind === "failed") {
        stats.cacheHits += 1;
        return null;
      }
      stats.requests += 1;
      const result = parseKakaoResponse(await options.lookup(key));
      options.cache.set(key, result, now());
      return result;
    }
  };
}

export function kakaoLookup(apiKey: string, fetchImpl: typeof fetch = fetch, delayMs = 50): GeocodeLookup {
  let lastCallAt = 0;
  return async (query) => {
    const wait = lastCallAt + delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    const url = `${KAKAO_ADDRESS_URL}?${new URLSearchParams({ query }).toString()}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `KakaoAK ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(maskSecrets(`카카오 네트워크 오류: ${(error as Error).message}`, [apiKey]));
    }
    const text = await response.text();
    if (!response.ok) {
      if (/OPEN_MAP_AND_LOCAL/.test(text)) {
        throw new GeocoderConfigError("카카오 개발자 앱 설정에서 카카오맵 사용 설정을 켜야 해");
      }
      if (response.status === 401 || response.status === 403) {
        throw new GeocoderConfigError(`카카오 REST API 키가 거부됐어(HTTP ${response.status}). 키를 확인해.`);
      }
      throw new Error(maskSecrets(`카카오 HTTP ${response.status}: ${text.slice(0, 200)}`, [apiKey]));
    }
    return JSON.parse(text);
  };
}

// 고정 데이터: tests/fixtures/postings/kakao/geocode.json (키 = 정규화 주소)
export function fixtureLookup(fixtureDir: string): GeocodeLookup {
  const table = JSON.parse(fs.readFileSync(path.join(fixtureDir, "kakao", "geocode.json"), "utf8")) as Record<string, unknown>;
  return async (query) => table[normalizeAddressKey(query)] ?? { documents: [], meta: { total_count: 0 } };
}
