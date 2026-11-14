import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

// 버전 순서대로 한 번씩만 적용한다. 이미 배포된 마이그레이션은 고치지 말고 새 버전을 추가한다.
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  terms_agreed_at TEXT NOT NULL,
  age14_confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (provider, provider_user_id)
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_flows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  anon_id TEXT,
  job_codes TEXT NOT NULL,
  pre_answers TEXT NOT NULL DEFAULT '{}',
  result_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX attempts_user ON attempts(user_id, created_at);
CREATE INDEX attempts_anon ON attempts(anon_id);
CREATE TABLE attempt_missions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 1,
  job_code TEXT NOT NULL,
  mission_key TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  mission_title TEXT NOT NULL,
  mission_hash TEXT NOT NULL,
  answer TEXT NOT NULL,
  evaluation TEXT NOT NULL,
  mission_score TEXT NOT NULL,
  scoring_mode TEXT NOT NULL,
  self_report TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX attempt_missions_attempt ON attempt_missions(attempt_id, created_at);
CREATE TABLE interests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_code TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_code)
);
CREATE TABLE drafts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_key TEXT NOT NULL,
  job_code TEXT NOT NULL,
  answer TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, mission_key)
);
`
  }
];

export function openDatabase(filePath: string): Db {
  if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (filePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 3000;");
  }
  migrate(db);
  return db;
}

export function migrate(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => Number(row.version))
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function currentSchemaVersion(db: Db) {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined;
  return Number(row?.version ?? 0);
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
