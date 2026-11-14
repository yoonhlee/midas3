import type express from "express";

// 모든 API 오류는 { error: { code, message, details? } } 한 가지 형식으로 응답한다.
export function sendApiError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// async 라우트의 예외를 공통 오류 처리기로 넘긴다.
export function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function apiNotFound(): express.RequestHandler {
  return (req, res) => sendApiError(res, 404, "NOT_FOUND", `No API route for ${req.method} ${req.path}.`);
}

export function apiErrorHandler(log: (message: string) => void = (m) => console.error(m)): express.ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) {
      return sendApiError(res, error.status, error.code, error.message, error.details);
    }
    // express.json() 파싱 오류
    if ((error as { type?: string })?.type === "entity.parse.failed") {
      return sendApiError(res, 400, "BAD_JSON", "Request body is not valid JSON.");
    }
    if ((error as { type?: string })?.type === "entity.too.large") {
      return sendApiError(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`[api] ${req.method} ${req.path} ${message}`);
    return sendApiError(res, 500, "INTERNAL_ERROR", "서버에서 오류가 났어. 잠시 후 다시 시도해줘.");
  };
}

export function getClientIp(req: express.Request) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]?.trim() ?? req.ip;
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function extractApiToken(req: express.Request) {
  const headerToken = req.header("x-api-token");
  if (headerToken?.trim()) return headerToken.trim();
  const authorization = req.header("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict";
  path?: string;
}

export function setCookie(res: express.Response, name: string, value: string, options: CookieOptions) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, `SameSite=${options.sameSite ?? "Lax"}`];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  res.append("Set-Cookie", parts.join("; "));
}

export function clearCookie(res: express.Response, name: string, secure: boolean) {
  setCookie(res, name, "", { maxAgeSec: 0, secure });
}

// 다른 사이트에서 보낸 상태 변경 요청을 막는다(SameSite=Lax 쿠키와 함께 쓰는 1차 방어).
export function sameOriginGuard(allowedOrigins: () => string[]): express.RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    const origin = req.header("origin");
    if (!origin) return next();
    const host = req.header("host");
    const allowed = new Set(allowedOrigins());
    if (host) {
      allowed.add(`http://${host}`);
      allowed.add(`https://${host}`);
    }
    if (allowed.has(origin)) return next();
    return sendApiError(res, 403, "ORIGIN_NOT_ALLOWED", "Cross-site request was blocked.");
  };
}
