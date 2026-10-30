import type express from "express";
import type { Db } from "../lib/db/database.js";
import type { Owner, SessionRow, UserRow } from "../lib/db/repos.js";
import { ANON_COOKIE, SESSION_COOKIE, newToken, resolveSession } from "../lib/auth/session.js";
import type { ServerConfig } from "./config.js";
import { parseCookies, sendApiError, setCookie } from "./http.js";

export interface RequestAuth {
  user: UserRow | null;
  session: SessionRow | null;
  sessionToken: string | null;
  anonId: string | null;
  cookies: Record<string, string>;
}

export function getAuth(res: express.Response): RequestAuth {
  return (res.locals.auth as RequestAuth | undefined) ?? { user: null, session: null, sessionToken: null, anonId: null, cookies: {} };
}

export function ownerOf(res: express.Response): Owner {
  const auth = getAuth(res);
  return { userId: auth.user?.id ?? null, anonId: auth.anonId };
}

// 모든 요청에 로그인 상태와 브라우저 식별자(로그인 전 기록용)를 붙인다.
export function loadAuth(db: Db, config: ServerConfig): express.RequestHandler {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE] || null;
    let resolved = null;
    try {
      resolved = resolveSession(db, token ?? undefined, { idleDays: config.auth.sessionIdleDays, maxDays: config.auth.sessionMaxDays });
    } catch (error) {
      console.error("[auth] session lookup failed:", (error as Error).message);
    }
    const anonRaw = cookies[ANON_COOKIE];
    res.locals.auth = {
      user: resolved?.user ?? null,
      session: resolved?.session ?? null,
      sessionToken: resolved ? token : null,
      anonId: anonRaw && /^[A-Za-z0-9_-]{16,64}$/.test(anonRaw) ? anonRaw : null,
      cookies
    } satisfies RequestAuth;
    next();
  };
}

// 로그인 전 기록을 묶을 브라우저 식별자. 필요할 때만 만든다.
export function ensureAnonId(res: express.Response, config: ServerConfig) {
  const auth = getAuth(res);
  if (auth.anonId) return auth.anonId;
  const anonId = newToken(18);
  setCookie(res, ANON_COOKIE, anonId, {
    secure: config.cookieSecure,
    maxAgeSec: config.auth.anonymousRetentionHours * 60 * 60
  });
  auth.anonId = anonId;
  return anonId;
}

export const requireUser: express.RequestHandler = (_req, res, next) => {
  if (!getAuth(res).user) return sendApiError(res, 401, "LOGIN_REQUIRED", "로그인이 필요해.");
  return next();
};

// 로그인한 사용자의 상태 변경 요청은 세션에 묶인 CSRF 토큰을 헤더로 함께 보내야 한다.
export const requireCsrf: express.RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const auth = getAuth(res);
  if (!auth.session) return next();
  const provided = req.header("x-csrf-token") ?? "";
  if (provided && provided === auth.session.csrf_token) return next();
  return sendApiError(res, 403, "CSRF_TOKEN_INVALID", "보안 토큰이 맞지 않아. 페이지를 새로고침한 뒤 다시 시도해줘.");
};
