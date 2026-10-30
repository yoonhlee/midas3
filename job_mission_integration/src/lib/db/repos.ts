import { randomUUID } from "node:crypto";
import { transaction, type Db } from "./database.js";

// DB 접근은 이 파일의 함수로만 한다. 라우트에서 SQL을 직접 쓰지 않는다.

const nowIso = () => new Date().toISOString();

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── 사용자 ─────────────────────────────────────────────
export interface UserRow {
  id: string;
  provider: string;
  provider_user_id: string;
  nickname: string;
  terms_version: string;
  terms_agreed_at: string;
  age14_confirmed_at: string;
  created_at: string;
  last_login_at: string | null;
}

export function findUserByProvider(db: Db, provider: string, providerUserId: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE provider = ? AND provider_user_id = ?").get(provider, providerUserId) as UserRow | undefined) ?? null;
}

export function findUserById(db: Db, id: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

export function createUser(db: Db, input: { provider: string; providerUserId: string; nickname: string; termsVersion: string }): UserRow {
  const id = randomUUID();
  const at = nowIso();
  db.prepare(`INSERT INTO users (id, provider, provider_user_id, nickname, terms_version, terms_agreed_at, age14_confirmed_at, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.provider, input.providerUserId, input.nickname, input.termsVersion, at, at, at, at);
  return findUserById(db, id) as UserRow;
}

export function touchUserLogin(db: Db, userId: string) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), userId);
}

export function updateNickname(db: Db, userId: string, nickname: string) {
  db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickname, userId);
}

// 탈퇴: 사용자와 연결된 기록(세션·체험·관심·임시 답안)을 한 번에 지운다(ON DELETE CASCADE).
export function deleteUser(db: Db, userId: string) {
  transaction(db, () => {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
}

// ── 세션 ───────────────────────────────────────────────
export interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export function insertSession(db: Db, row: SessionRow) {
  db.prepare("INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id_hash, row.user_id, row.csrf_token, row.created_at, row.last_seen_at, row.expires_at);
}

export function findSession(db: Db, idHash: string): SessionRow | null {
  return (db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as SessionRow | undefined) ?? null;
}

export function touchSession(db: Db, idHash: string, lastSeenAt: string) {
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(lastSeenAt, idHash);
}

export function deleteSession(db: Db, idHash: string) {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
}

export function deleteExpiredSessions(db: Db, now: string, idleBefore: string) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?").run(now, idleBefore);
}

// ── 로그인 진행 상태(state·nonce·PKCE, 첫 가입 대기) ─────────
export function insertAuthFlow(db: Db, kind: "login" | "signup", payload: Record<string, unknown>, ttlMs: number) {
  const id = randomUUID();
  const created = new Date();
  db.prepare("INSERT INTO auth_flows (id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, kind, JSON.stringify(payload), created.toISOString(), new Date(created.getTime() + ttlMs).toISOString());
  return id;
}

// 한 번 쓰면 지운다(재사용 방지).
export function takeAuthFlow(db: Db, id: string, kind: "login" | "signup"): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM auth_flows WHERE id = ? AND kind = ?").get(id, kind) as
    | { payload: string; expires_at: string }
    | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM auth_flows WHERE id = ?").run(id);
  if (row.expires_at <= nowIso()) return null;
  return parseJson<Record<string, unknown>>(row.payload, {});
}

export function peekAuthFlow(db: Db, id: string, kind: "login" | "signup"): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM auth_flows WHERE id = ? AND kind = ?").get(id, kind) as
    | { payload: string; expires_at: string }
    | undefined;
  if (!row || row.expires_at <= nowIso()) return null;
  return parseJson<Record<string, unknown>>(row.payload, {});
}

export function deleteExpiredAuthFlows(db: Db, now: string) {
  db.prepare("DELETE FROM auth_flows WHERE expires_at <= ?").run(now);
}

// ── 체험(시도) 기록 ─────────────────────────────────────
export interface Owner {
  userId: string | null;
  anonId: string | null;
}

export interface AttemptRow {
  id: string;
  user_id: string | null;
  anon_id: string | null;
  job_codes: string[];
  pre_answers: Record<string, unknown>;
  result_snapshot: Record<string, unknown> | null;
  status: "in_progress" | "completed";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function toAttempt(raw: Record<string, unknown> | undefined): AttemptRow | null {
  if (!raw) return null;
  return {
    id: String(raw.id),
    user_id: (raw.user_id as string | null) ?? null,
    anon_id: (raw.anon_id as string | null) ?? null,
    job_codes: parseJson<string[]>(raw.job_codes, []),
    pre_answers: parseJson<Record<string, unknown>>(raw.pre_answers, {}),
    result_snapshot: parseJson<Record<string, unknown> | null>(raw.result_snapshot, null),
    status: raw.status === "completed" ? "completed" : "in_progress",
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    completed_at: (raw.completed_at as string | null) ?? null
  };
}

export function createAttempt(db: Db, owner: Owner, input: { jobCodes: string[]; preAnswers?: Record<string, unknown> }): AttemptRow {
  const id = randomUUID();
  const at = nowIso();
  db.prepare(`INSERT INTO attempts (id, user_id, anon_id, job_codes, pre_answers, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`)
    .run(id, owner.userId, owner.userId ? null : owner.anonId, JSON.stringify(input.jobCodes), JSON.stringify(input.preAnswers ?? {}), at, at);
  return getAttempt(db, id) as AttemptRow;
}

export function getAttempt(db: Db, id: string): AttemptRow | null {
  return toAttempt(db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}

export function isAttemptOwner(attempt: AttemptRow, owner: Owner) {
  if (attempt.user_id) return Boolean(owner.userId) && attempt.user_id === owner.userId;
  return Boolean(owner.anonId) && attempt.anon_id === owner.anonId;
}

export function updateAttemptPreAnswers(db: Db, id: string, preAnswers: Record<string, unknown>) {
  db.prepare("UPDATE attempts SET pre_answers = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(preAnswers), nowIso(), id);
}

export function completeAttempt(db: Db, id: string, snapshot: Record<string, unknown>) {
  const at = nowIso();
  db.prepare("UPDATE attempts SET result_snapshot = ?, status = 'completed', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
    .run(JSON.stringify(snapshot), at, at, id);
}

export function listUserAttempts(db: Db, userId: string): AttemptRow[] {
  return (db.prepare("SELECT * FROM attempts WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Array<Record<string, unknown>>)
    .map((row) => toAttempt(row) as AttemptRow);
}

export function deleteAttempt(db: Db, id: string) {
  db.prepare("DELETE FROM attempts WHERE id = ?").run(id);
}

// 로그인 전(같은 브라우저) 기록을 로그인한 사용자 기록으로 옮긴다. 옮긴 수를 돌려준다.
export function claimAnonymousAttempts(db: Db, anonId: string, userId: string) {
  const result = db.prepare("UPDATE attempts SET user_id = ?, anon_id = NULL, updated_at = ? WHERE anon_id = ? AND user_id IS NULL")
    .run(userId, nowIso(), anonId);
  return Number(result.changes ?? 0);
}

export function countAnonymousAttempts(db: Db, anonId: string) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE anon_id = ? AND user_id IS NULL AND status = 'completed'").get(anonId) as { n: number };
  return Number(row?.n ?? 0);
}

// 로그인하지 않은 기록은 보관 기간이 지나면 지운다.
export function deleteStaleAnonymousAttempts(db: Db, before: string) {
  const result = db.prepare("DELETE FROM attempts WHERE user_id IS NULL AND updated_at <= ?").run(before);
  return Number(result.changes ?? 0);
}

export interface AttemptMissionRow {
  id: string;
  attempt_id: string;
  round: number;
  job_code: string;
  mission_key: string;
  mission_id: string;
  mission_title: string;
  mission_hash: string;
  answer: string;
  evaluation: Record<string, unknown>;
  mission_score: Record<string, number>;
  scoring_mode: string;
  self_report: Record<string, unknown>;
  created_at: string;
}

export function insertAttemptMission(db: Db, row: Omit<AttemptMissionRow, "id" | "created_at">): AttemptMissionRow {
  const id = randomUUID();
  const at = nowIso();
  db.prepare(`INSERT INTO attempt_missions (id, attempt_id, round, job_code, mission_key, mission_id, mission_title, mission_hash, answer, evaluation, mission_score, scoring_mode, self_report, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, row.attempt_id, row.round, row.job_code, row.mission_key, row.mission_id, row.mission_title, row.mission_hash, row.answer,
      JSON.stringify(row.evaluation), JSON.stringify(row.mission_score), row.scoring_mode, JSON.stringify(row.self_report), at);
  db.prepare("UPDATE attempts SET updated_at = ? WHERE id = ?").run(at, row.attempt_id);
  return { ...row, id, created_at: at };
}

export function listAttemptMissions(db: Db, attemptId: string): AttemptMissionRow[] {
  return (db.prepare("SELECT * FROM attempt_missions WHERE attempt_id = ? ORDER BY created_at ASC").all(attemptId) as Array<Record<string, unknown>>)
    .map((raw) => ({
      id: String(raw.id),
      attempt_id: String(raw.attempt_id),
      round: Number(raw.round),
      job_code: String(raw.job_code),
      mission_key: String(raw.mission_key),
      mission_id: String(raw.mission_id),
      mission_title: String(raw.mission_title),
      mission_hash: String(raw.mission_hash),
      answer: String(raw.answer),
      evaluation: parseJson<Record<string, unknown>>(raw.evaluation, {}),
      mission_score: parseJson<Record<string, number>>(raw.mission_score, {}),
      scoring_mode: String(raw.scoring_mode),
      self_report: parseJson<Record<string, unknown>>(raw.self_report, {}),
      created_at: String(raw.created_at)
    }));
}

export function updateAttemptMissionSelfReport(db: Db, id: string, selfReport: Record<string, unknown>) {
  db.prepare("UPDATE attempt_missions SET self_report = ? WHERE id = ?").run(JSON.stringify(selfReport), id);
}

export function countUserMissions(db: Db, userId: string) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM attempt_missions m JOIN attempts a ON a.id = m.attempt_id WHERE a.user_id = ?`).get(userId) as { n: number };
  return Number(row?.n ?? 0);
}

// ── 관심 직무 ───────────────────────────────────────────
export interface InterestRow {
  job_code: string;
  memo: string;
  created_at: string;
  updated_at: string;
}

export function listInterests(db: Db, userId: string): InterestRow[] {
  return db.prepare("SELECT job_code, memo, created_at, updated_at FROM interests WHERE user_id = ? ORDER BY created_at DESC").all(userId) as unknown as InterestRow[];
}

export function upsertInterest(db: Db, userId: string, jobCode: string, memo: string | undefined) {
  const at = nowIso();
  const existing = db.prepare("SELECT memo FROM interests WHERE user_id = ? AND job_code = ?").get(userId, jobCode) as { memo: string } | undefined;
  if (existing) {
    if (memo !== undefined) db.prepare("UPDATE interests SET memo = ?, updated_at = ? WHERE user_id = ? AND job_code = ?").run(memo, at, userId, jobCode);
  } else {
    db.prepare("INSERT INTO interests (user_id, job_code, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(userId, jobCode, memo ?? "", at, at);
  }
  return db.prepare("SELECT job_code, memo, created_at, updated_at FROM interests WHERE user_id = ? AND job_code = ?").get(userId, jobCode) as unknown as InterestRow;
}

export function deleteInterest(db: Db, userId: string, jobCode: string) {
  const result = db.prepare("DELETE FROM interests WHERE user_id = ? AND job_code = ?").run(userId, jobCode);
  return Number(result.changes ?? 0) > 0;
}

// ── 쓰던 답안 ───────────────────────────────────────────
export interface DraftRow {
  mission_key: string;
  job_code: string;
  answer: string;
  updated_at: string;
}

export function upsertDraft(db: Db, userId: string, missionKey: string, jobCode: string, answer: string) {
  const at = nowIso();
  db.prepare(`INSERT INTO drafts (user_id, mission_key, job_code, answer, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, mission_key) DO UPDATE SET answer = excluded.answer, job_code = excluded.job_code, updated_at = excluded.updated_at`)
    .run(userId, missionKey, jobCode, answer, at);
  return { mission_key: missionKey, job_code: jobCode, answer, updated_at: at };
}

export function listDrafts(db: Db, userId: string): DraftRow[] {
  return db.prepare("SELECT mission_key, job_code, answer, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as unknown as DraftRow[];
}

export function getDraft(db: Db, userId: string, missionKey: string): DraftRow | null {
  return (db.prepare("SELECT mission_key, job_code, answer, updated_at FROM drafts WHERE user_id = ? AND mission_key = ?").get(userId, missionKey) as unknown as DraftRow | undefined) ?? null;
}

export function deleteDraft(db: Db, userId: string, missionKey: string) {
  db.prepare("DELETE FROM drafts WHERE user_id = ? AND mission_key = ?").run(userId, missionKey);
}
