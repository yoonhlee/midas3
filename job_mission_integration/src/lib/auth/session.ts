import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/database.js";
import {
  deleteExpiredAuthFlows,
  deleteExpiredSessions,
  deleteSession,
  findSession,
  findUserById,
  insertSession,
  touchSession,
  type SessionRow,
  type UserRow
} from "../db/repos.js";

export const SESSION_COOKIE = "jobsim_sid";
export const ANON_COOKIE = "jobsim_anon";
export const SIGNUP_COOKIE = "jobsim_signup";
export const LOGIN_FLOW_COOKIE = "jobsim_login";

const DAY_MS = 24 * 60 * 60 * 1000;
// 마지막 사용 시각은 5분에 한 번만 갱신한다(요청마다 쓰지 않게).
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

// 쿠키에 든 세션 토큰은 DB에 해시로만 저장한다(DB가 새도 세션을 훔쳐 쓸 수 없게).
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionPolicy {
  idleDays: number;
  maxDays: number;
}

export function createSession(db: Db, userId: string, policy: SessionPolicy, now = new Date()) {
  const token = newToken();
  const csrf = newToken(18);
  const expiresAt = new Date(now.getTime() + policy.maxDays * DAY_MS).toISOString();
  insertSession(db, {
    id_hash: hashToken(token),
    user_id: userId,
    csrf_token: csrf,
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: expiresAt
  });
  return { token, csrf, expiresAt, maxAgeSec: policy.maxDays * 24 * 60 * 60 };
}

export interface ResolvedSession {
  user: UserRow;
  session: SessionRow;
}

// 만료(최대 기간)나 오래 쓰지 않은 세션(유휴 기간)은 지우고 null을 돌려준다.
export function resolveSession(db: Db, token: string | undefined, policy: SessionPolicy, now = new Date()): ResolvedSession | null {
  if (!token) return null;
  const idHash = hashToken(token);
  const session = findSession(db, idHash);
  if (!session) return null;
  const idleLimit = Date.parse(session.last_seen_at) + policy.idleDays * DAY_MS;
  if (Date.parse(session.expires_at) <= now.getTime() || idleLimit <= now.getTime()) {
    deleteSession(db, idHash);
    return null;
  }
  const user = findUserById(db, session.user_id);
  if (!user) {
    deleteSession(db, idHash);
    return null;
  }
  if (now.getTime() - Date.parse(session.last_seen_at) > TOUCH_INTERVAL_MS) {
    touchSession(db, idHash, now.toISOString());
  }
  return { user, session };
}

export function destroySession(db: Db, token: string | undefined) {
  if (token) deleteSession(db, hashToken(token));
}

export function purgeExpiredAuthData(db: Db, policy: SessionPolicy, now = new Date()) {
  deleteExpiredSessions(db, now.toISOString(), new Date(now.getTime() - policy.idleDays * DAY_MS).toISOString());
  deleteExpiredAuthFlows(db, now.toISOString());
}

// 로그인 뒤 돌아갈 주소는 같은 사이트의 상대 경로만 허용한다(열린 리다이렉트 방지).
export function safeReturnTo(raw: unknown, fallback = "/me.html") {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return fallback;
  return value.slice(0, 300);
}

export const NICKNAME_RULE = /^[0-9A-Za-z가-힣_\-. ]{2,20}$/;

export function normalizeNickname(raw: unknown) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  return NICKNAME_RULE.test(value) ? value : null;
}

// 카카오 닉네임이 규칙에 맞지 않으면 가입 화면에서 바꿀 수 있게 기본값을 만든다.
export function suggestNickname(raw: unknown) {
  return normalizeNickname(raw) ?? `체험자${Math.floor(1000 + Math.random() * 9000)}`;
}
