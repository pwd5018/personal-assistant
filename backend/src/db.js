import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "assistant.sqlite"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS raw_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    transcript_text TEXT,
    assistant_text TEXT,
    turn_status TEXT NOT NULL,
    context_json TEXT NOT NULL,
    latency_json TEXT NOT NULL,
    token_json TEXT NOT NULL,
    provider_json TEXT NOT NULL,
    failure_json TEXT,
    transcript_mime_type TEXT,
    audio_bytes INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rolling_summary (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    summary_text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approved_facts (
    id TEXT PRIMARY KEY,
    fact_text TEXT NOT NULL,
    source_turn_id TEXT,
    category TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candidate_facts (
    id TEXT PRIMARY KEY,
    fact_text TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution_note TEXT,
    category TEXT,
    recommendation TEXT,
    recommendation_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS lookup_cache (
    cache_key TEXT PRIMARY KEY,
    question_kind TEXT NOT NULL,
    privacy_mode TEXT NOT NULL,
    answer_mode TEXT NOT NULL,
    resolution_status TEXT NOT NULL,
    retrieval_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    extraction_json TEXT NOT NULL,
    citations_json TEXT NOT NULL,
    web_searches_json TEXT NOT NULL,
    usage_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    hit_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS provider_settings (
    route TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    voice TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const ensureSummaryRow = db.prepare(`
  INSERT INTO rolling_summary (id, summary_text, updated_at)
  VALUES (1, '', datetime('now'))
  ON CONFLICT(id) DO NOTHING
`);

ensureSummaryRow.run();
ensureColumn("provider_settings", "voice", "TEXT");
ensureColumn("provider_settings", "voice_hint", "TEXT");
ensureColumn("approved_facts", "source_turn_id", "TEXT");
ensureColumn("approved_facts", "category", "TEXT");
ensureColumn("candidate_facts", "category", "TEXT");
ensureColumn("candidate_facts", "recommendation", "TEXT");
ensureColumn("candidate_facts", "recommendation_reason", "TEXT");
ensureColumn("lookup_cache", "question_kind", "TEXT NOT NULL DEFAULT 'other'");
ensureColumn("lookup_cache", "privacy_mode", "TEXT NOT NULL DEFAULT 'strict'");
ensureColumn("lookup_cache", "answer_mode", "TEXT NOT NULL DEFAULT 'lookup_or_model'");
ensureColumn("lookup_cache", "resolution_status", "TEXT NOT NULL DEFAULT 'unresolved'");
ensureColumn("lookup_cache", "retrieval_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("lookup_cache", "evidence_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("lookup_cache", "extraction_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("lookup_cache", "citations_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("lookup_cache", "web_searches_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("lookup_cache", "usage_json", "TEXT");
ensureColumn("lookup_cache", "created_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("lookup_cache", "expires_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("lookup_cache", "last_used_at", "TEXT");
ensureColumn("lookup_cache", "hit_count", "INTEGER NOT NULL DEFAULT 0");

export function getDatabase() {
  return db;
}

function ensureColumn(tableName, columnName, columnDefinition) {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);

  if (!columns.includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}
