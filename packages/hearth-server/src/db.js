// node:sqlite（Node ≥22.13）：零原生依赖，不踩 better-sqlite3 编译坑。
// API 与 better-sqlite3 基本同形：prepare().get()/.all()/.run()。
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.HEARTH_DB_PATH || 'hearth.db';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS hearth_entries (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK(type IN ('rule','letter','event','project','stream')),
  keys          TEXT NOT NULL DEFAULT '[]',
  hook          TEXT NOT NULL,
  body          TEXT NOT NULL,
  trigger_date  TEXT,
  trigger_done  INTEGER NOT NULL DEFAULT 0,
  sealed        INTEGER NOT NULL DEFAULT 0,
  anchor        INTEGER NOT NULL DEFAULT 0,
  weight        INTEGER NOT NULL DEFAULT 3,
  tier_since    TEXT,
  last_accessed TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active','superseded','retired','archived')),
  supersedes    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hearth_meta (
  key        TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hearth_history (
  history_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK(target_type IN ('entry','meta')),
  target_id   TEXT NOT NULL,
  op          TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hearth_touch_log (
  log_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL,
  touched_at TEXT NOT NULL
);

-- ① 写入审计：追加式，只 INSERT。meta 用 'meta:<key>' 作 entry_id。
CREATE TABLE IF NOT EXISTS hearth_write_audit (
  revision       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id       TEXT NOT NULL,
  op             TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- ③ source 证据：原始来源记录。写路径只增不改——修正 = 新增一行（revision_of 指向被修正的那行）。
-- 注意：无 DB trigger 禁 UPDATE/DELETE，这是应用层约束，不是数据库级不可变。
CREATE TABLE IF NOT EXISTS hearth_sources (
  source_id   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  excerpt     TEXT,
  range       TEXT,
  checksum    TEXT,
  revision_of TEXT,
  created_at  TEXT NOT NULL
);

-- ③ 条目↔来源一对多引用。链接可随 source_revise 指向新 revision，历史链在 hearth_sources.revision_of 里。
CREATE TABLE IF NOT EXISTS entry_sources (
  entry_id   TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_status ON hearth_entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_type ON hearth_entries(type);
CREATE INDEX IF NOT EXISTS idx_history_target ON hearth_history(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_touchlog_entry ON hearth_touch_log(entry_id, touched_at);
CREATE INDEX IF NOT EXISTS idx_audit_entry ON hearth_write_audit(entry_id, revision);
CREATE INDEX IF NOT EXISTS idx_entry_sources_entry ON entry_sources(entry_id);
CREATE INDEX IF NOT EXISTS idx_sources_revision ON hearth_sources(revision_of);
`);

// H9 兼容旧库：CREATE TABLE IF NOT EXISTS 不会给既有表补列。
const entryColumns = db.prepare(`PRAGMA table_info(hearth_entries)`).all();
if (!entryColumns.some((column) => column.name === 'tier_since')) {
  db.exec(`ALTER TABLE hearth_entries ADD COLUMN tier_since TEXT`);
}
if (!entryColumns.some((column) => column.name === 'weight')) {
  db.exec(`ALTER TABLE hearth_entries ADD COLUMN weight INTEGER NOT NULL DEFAULT 3`);
}
// ③ origin：来源摘要。旧条目保持 NULL = unknown（显式语义，不许悄悄当 manual）
if (!entryColumns.some((column) => column.name === 'origin')) {
  db.exec(`ALTER TABLE hearth_entries ADD COLUMN origin TEXT`);
}

// 时间戳一律服务器打，本地时钟不可信
export function now() {
  return db.prepare(`SELECT datetime('now') AS t`).get().t;
}

// node:sqlite 没有 transaction helper，手动 BEGIN/COMMIT/ROLLBACK
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
