import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config";

const dbPath = join(config.dataDir, "aios.db");
export const db: Database.Database = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  repo_full_name TEXT,
  repo_dir      TEXT NOT NULL UNIQUE,
  setup_phase   TEXT NOT NULL DEFAULT 'complete',
  is_default    INTEGER NOT NULL DEFAULT 0,
  webhook_secret TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

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
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_runs_dept ON runs(company_id, department, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  department TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backlog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  department  TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  queued_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_dept ON backlog(company_id, department, id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  department  TEXT,
  endpoint    TEXT NOT NULL,
  source      TEXT,
  payload     TEXT,
  outcome     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL,
  department  TEXT NOT NULL,
  provider    TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_state (
  company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  path       TEXT PRIMARY KEY,
  last_fired INTEGER NOT NULL,
  paused     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goal_state (
  company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  path       TEXT PRIMARY KEY,
  last_fired INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_agent_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_telegram_agent_status ON telegram_agent_messages(company_id, status, id);

CREATE TABLE IF NOT EXISTS owner_notifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
  source_scope      TEXT NOT NULL,
  source_path       TEXT NOT NULL,
  content_hash      TEXT NOT NULL UNIQUE,
  run_id            TEXT,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'info',
  tags              TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL,
  delivery_channel  TEXT NOT NULL DEFAULT 'none',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  delivered_at      INTEGER,
  read_at           INTEGER,
  raw_frontmatter   TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_notifications_created ON owner_notifications(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_notifications_status ON owner_notifications(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_notifications_scope ON owner_notifications(company_id, source_scope, created_at DESC);
`);

migrateCompanySchema();

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

function migrateCompanySchema() {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, created_at, updated_at)
    VALUES('default', 'Default company', NULL, ?, 'complete', 1, ?, ?)
  `).run(config.repoDir, now, now);

  for (const table of ["runs", "backlog", "webhook_deliveries", "usage", "cron_state", "goal_state"]) {
    addColumnIfMissing(table, "company_id", "INTEGER DEFAULT 1");
    db.prepare(`UPDATE ${table} SET company_id = 1 WHERE company_id IS NULL`).run();
  }

  migrateClaimsTable();
  migrateTelegramAgentMessagesTable();
  migrateOwnerNotificationsTable();
}

function tableColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  if (tableColumns(table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateClaimsTable() {
  const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get() as any)?.sql || "");
  if (sql.includes("PRIMARY KEY(company_id, department)") || sql.includes("PRIMARY KEY (company_id, department)")) return;
  addColumnIfMissing("claims", "company_id", "INTEGER DEFAULT 1");
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims_next (
      company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
      department TEXT NOT NULL,
      run_id     TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY(company_id, department)
    );
    INSERT OR REPLACE INTO claims_next(company_id, department, run_id, claimed_at, expires_at)
      SELECT COALESCE(company_id, 1), department, run_id, claimed_at, expires_at FROM claims;
    DROP TABLE claims;
    ALTER TABLE claims_next RENAME TO claims;
  `);
}

function migrateTelegramAgentMessagesTable() {
  const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telegram_agent_messages'").get() as any)?.sql || "");
  if (sql.includes("UNIQUE(company_id, update_id)") || sql.includes("UNIQUE (company_id, update_id)")) return;
  addColumnIfMissing("telegram_agent_messages", "company_id", "INTEGER DEFAULT 1");
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_agent_messages_next (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
      update_id   INTEGER NOT NULL,
      chat_id     TEXT NOT NULL,
      text        TEXT NOT NULL,
      status      TEXT NOT NULL,
      run_id      TEXT,
      provider    TEXT,
      session_id  TEXT,
      received_at INTEGER NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER,
      error       TEXT,
      UNIQUE(company_id, update_id)
    );
    INSERT OR IGNORE INTO telegram_agent_messages_next(
      id, company_id, update_id, chat_id, text, status, run_id, provider, session_id,
      received_at, started_at, finished_at, error
    )
      SELECT id, COALESCE(company_id, 1), update_id, chat_id, text, status, run_id, provider, session_id,
        received_at, started_at, finished_at, error
      FROM telegram_agent_messages;
    DROP TABLE telegram_agent_messages;
    ALTER TABLE telegram_agent_messages_next RENAME TO telegram_agent_messages;
    CREATE INDEX IF NOT EXISTS idx_telegram_agent_status ON telegram_agent_messages(company_id, status, id);
  `);
}

function migrateOwnerNotificationsTable() {
  const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_notifications'").get() as any)?.sql || "");
  if (sql.includes("UNIQUE(company_id, content_hash)") || sql.includes("UNIQUE (company_id, content_hash)")) return;
  addColumnIfMissing("owner_notifications", "company_id", "INTEGER DEFAULT 1");
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_notifications_next (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id        INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE CASCADE,
      source_scope      TEXT NOT NULL,
      source_path       TEXT NOT NULL,
      content_hash      TEXT NOT NULL,
      run_id            TEXT,
      title             TEXT NOT NULL,
      body              TEXT NOT NULL,
      priority          TEXT NOT NULL DEFAULT 'info',
      tags              TEXT NOT NULL DEFAULT '[]',
      status            TEXT NOT NULL,
      delivery_channel  TEXT NOT NULL DEFAULT 'none',
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT,
      created_at        INTEGER NOT NULL,
      delivered_at      INTEGER,
      read_at           INTEGER,
      raw_frontmatter   TEXT,
      UNIQUE(company_id, content_hash)
    );
    INSERT OR IGNORE INTO owner_notifications_next(
      id, company_id, source_scope, source_path, content_hash, run_id, title, body, priority, tags,
      status, delivery_channel, delivery_attempts, last_error, created_at, delivered_at, read_at, raw_frontmatter
    )
      SELECT id, COALESCE(company_id, 1), source_scope, source_path, content_hash, run_id, title, body, priority, tags,
        status, delivery_channel, delivery_attempts, last_error, created_at, delivered_at, read_at, raw_frontmatter
      FROM owner_notifications;
    DROP TABLE owner_notifications;
    ALTER TABLE owner_notifications_next RENAME TO owner_notifications;
    CREATE INDEX IF NOT EXISTS idx_owner_notifications_created ON owner_notifications(company_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_owner_notifications_status ON owner_notifications(company_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_owner_notifications_scope ON owner_notifications(company_id, source_scope, created_at DESC);
  `);
}
