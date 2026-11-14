import type express from "express";
import type { ServerConfig } from "./config.js";
import { extractApiToken, getClientIp, sendApiError } from "./http.js";

// 관리자 API 인증.
// - ADMIN_PASSWORD가 없으면 관리자 API는 열리지 않는다(예전에는 암호가 없으면 전부 통과했다).
// - ADMIN_DEMO_UNLOCK=true는 조회(GET)만 암호 없이 허용한다. 생성·내보내기·삭제는 항상 암호가 필요하다.
export function requireAdmin(config: ServerConfig, options: { allowDemoRead?: boolean } = {}): express.RequestHandler {
  return (req, res, next) => {
    const { password, demoUnlock } = config.admin;
    if (options.allowDemoRead && demoUnlock && (req.method === "GET" || req.method === "HEAD")) return next();
    if (!password) {
      return sendApiError(res, 503, "ADMIN_PASSWORD_NOT_SET", "ADMIN_PASSWORD is not configured on this server.");
    }
    const provided = extractApiToken(req);
    if (provided && provided === password) return next();
    return sendApiError(res, 401, "AUTH_REQUIRED", "Missing or invalid API token.");
  };
}

type RateLimitBucket = { count: number; resetAt: number };

export function rateLimit(options: { windowMs: number; max: number; code?: string; message?: string }): express.RequestHandler {
  const buckets = new Map<string, RateLimitBucket>();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    const key = getClientIp(req);
    const existing = buckets.get(key);
    const bucket = (!existing || existing.resetAt <= now)
      ? { count: 0, resetAt: now + options.windowMs }
      : existing;
    if (bucket.count >= options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return sendApiError(
        res,
        429,
        options.code ?? "RATE_LIMITED",
        options.message ?? "Too many requests. Please retry later.",
        { retry_after_sec: retryAfterSec }
      );
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    return next();
  };
}
