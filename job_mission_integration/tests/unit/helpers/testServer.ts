import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../../../src/lib/db/database.js";
import { loadJobsCatalog } from "../../../src/lib/jobs/catalog.js";
import { loadPostingsConfig } from "../../../src/lib/postings/config.js";
import { PostingsService } from "../../../src/lib/postings/service.js";
import { buildJobWeightCatalog } from "../../../src/lib/recommendation/engine.js";
import { createApp } from "../../../src/server/app.js";
import { loadServerConfig, ROOT_DIR, type ServerConfig } from "../../../src/server/config.js";
import { MissionStore } from "../../../src/server/missionStore.js";

// 테스트용 서버: 메모리 DB, 고정 데이터 공고, 가짜 외부 호출(fetchImpl)을 쓴다.
export async function startTestServer(options: { env?: Record<string, string>; fetchImpl?: typeof fetch; configure?: (c: ServerConfig) => void } = {}) {
  process.env.EVAL_MODE = "fake";
  const env = { ...process.env, DATABASE_PATH: ":memory:", AUTH_DEV_LOGIN: "true", APP_ENV: "test", ...options.env } as NodeJS.ProcessEnv;
  const config = loadServerConfig(env);
  options.configure?.(config);
  const db = openDatabase(":memory:");
  const postingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "postings-srv-"));
  const postingsConfig = { ...loadPostingsConfig({ POSTINGS_FIXTURE: "1" }), dataDir: postingsDir };
  const app = createApp({
    config,
    db,
    missionStore: new MissionStore(config.paths.missions, () => {}),
    jobWeightCatalog: buildJobWeightCatalog(JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "data/processed/job_weights.json"), "utf8"))),
    jobsCatalog: loadJobsCatalog(config.paths.jobsData),
    postingsConfig,
    postingsService: new PostingsService(postingsConfig),
    fetchImpl: options.fetchImpl
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    db,
    config,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

// 쿠키를 기억하는 아주 작은 클라이언트
export class Client {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  constructor(readonly base: string) {}

  private absorb(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (expired || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${this.base}${url}`, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") } : {}),
        ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    this.absorb(response);
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers, text };
  }

  get(url: string) { return this.request("GET", url); }
  post(url: string, body?: unknown, headers?: Record<string, string>) { return this.request("POST", url, body ?? {}, headers); }
  put(url: string, body?: unknown) { return this.request("PUT", url, body ?? {}); }
  patch(url: string, body?: unknown) { return this.request("PATCH", url, body ?? {}); }
  del(url: string, body?: unknown) { return this.request("DELETE", url, body); }

  async refreshCsrf() {
    const session = await this.get("/api/auth/session");
    this.csrf = session.json?.csrf_token ?? null;
    return session.json;
  }

  // 개발용 로그인 → (처음이면) 약관 동의 가입까지
  async devSignup(id: string, nickname = id) {
    const login = await this.post("/api/auth/dev-login", { id, nickname });
    if (login.json?.status === "signup_required") {
      await this.post("/api/auth/signup", { nickname, agreeTerms: true, agreePrivacy: true, confirmAge14: true });
    }
    return this.refreshCsrf();
  }
}
