import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config";

const dbPath = join(config.dataDir, "aios.db");
export const db: Database.Database = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k     TEXT PRIMARY KEY,
  v     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  department TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  provider   TEXT,
  prompt     TEXT,
  status     TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  exit_code  INTEGER,
  error      TEXT,
  log_path   TEXT,
  commit_sha TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_dept ON runs(department, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  department TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backlog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  department  TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  queued_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_dept ON backlog(department, id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  department  TEXT,
  endpoint    TEXT NOT NULL,
  source      TEXT,
  payload     TEXT,
  outcome     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  department  TEXT NOT NULL,
  provider    TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_state (
  path       TEXT PRIMARY KEY,
  last_fired INTEGER NOT NULL,
  paused     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goal_state (
  path       TEXT PRIMARY KEY,
  last_fired INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_agent_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id   INTEGER NOT NULL UNIQUE,
  chat_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL,
  run_id      TEXT,
  provider    TEXT,
  session_id  TEXT,
  received_at INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_agent_status ON telegram_agent_messages(status, id);
`);

export function kvGet(k: string): string | null {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(k: string, v: string) {
  db.prepare(`INSERT INTO kv(k, v, updated_at) VALUES(?, ?, ?)
              ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`)
    .run(k, v, Date.now());
}

export function kvDel(k: string) {
  db.prepare("DELETE FROM kv WHERE k = ?").run(k);
}
