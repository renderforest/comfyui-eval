'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH, DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    csv_path TEXT NOT NULL,
    sample_seed INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'ref')),
    prompt TEXT NOT NULL,
    style TEXT,
    plan TEXT,
    model TEXT,
    file_created_at TEXT,
    prod_image_url TEXT NOT NULL,
    ref_1 TEXT,
    ref_2 TEXT,
    ref_3 TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed')),
    error TEXT,
    output_path TEXT,
    comfy_prompt_id TEXT,
    seed INTEGER,
    duration_ms INTEGER,
    rating TEXT CHECK (rating IN ('prod', 'local', 'tie'))
  );

  CREATE INDEX IF NOT EXISTS idx_instances_run ON instances (run_id, status);

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text2img', 'edit')),
    json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// additive migrations for DBs created before the workflow library existed
for (const column of ['text_workflow_id INTEGER', 'edit_workflow_id INTEGER']) {
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN ${column} REFERENCES workflows(id)`);
  } catch {
    // column already exists
  }
}

module.exports = db;
