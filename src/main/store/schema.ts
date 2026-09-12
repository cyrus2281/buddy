/// The full v1 schema from PRD §4, created at M1 even though M1 only writes
/// `frames` and `settings`. Creating it now means M3's notes engine is a set of
/// queries rather than a migration, and the shape is reviewable while it is
/// still cheap to change.

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS frames (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  display_id    INTEGER NOT NULL,
  path          TEXT    NOT NULL,
  w             INTEGER NOT NULL,
  h             INTEGER NOT NULL,
  bundle_id     TEXT    NOT NULL DEFAULT '',
  app_name      TEXT    NOT NULL DEFAULT '',
  window_title  TEXT    NOT NULL DEFAULT '',
  phash         TEXT    NOT NULL,
  ocr_text      TEXT,
  expires_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_frames_ts      ON frames(ts);
-- The retention sweep runs hourly and is the hottest query in M1.
CREATE INDEX IF NOT EXISTS idx_frames_expires ON frames(expires_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_frames_live    ON frames(deleted_at, ts);

CREATE TABLE IF NOT EXISTS observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_start       INTEGER NOT NULL,
  ts_end         INTEGER NOT NULL,
  summary        TEXT    NOT NULL,
  apps_json      TEXT    NOT NULL DEFAULT '[]',
  entities_json  TEXT    NOT NULL DEFAULT '[]',
  confidence     REAL    NOT NULL DEFAULT 0,
  frame_ids_json TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts_start);

CREATE TABLE IF NOT EXISTS notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL CHECK (type IN ('recap','relation','task')),
  title           TEXT    NOT NULL,
  body            TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  salience        REAL    NOT NULL DEFAULT 0,
  source_obs_json TEXT    NOT NULL DEFAULT '[]',
  -- NULL in v1. Present so vector search is a backfill job, not a migration.
  embedding       BLOB
);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type, updated_at DESC);

CREATE TABLE IF NOT EXISTS note_links (
  note_id         INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  related_note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,
  PRIMARY KEY (note_id, related_note_id, kind)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body, content='notes', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS relations (
  note_id      INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('person','app','product','customer','tool')),
  identifier   TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  aliases_json TEXT    NOT NULL DEFAULT '[]',
  frequency    INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_ident ON relations(kind, identifier);

CREATE TABLE IF NOT EXISTS tasks (
  note_id        INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  status         TEXT    NOT NULL CHECK (status IN ('open','blocked','waiting','done')),
  scope          TEXT    NOT NULL CHECK (scope IN ('session','day','week')),
  last_seen_at   INTEGER NOT NULL,
  next_check_at  INTEGER,
  artifacts_json TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  profile      TEXT    NOT NULL,
  goal         TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  steps        INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL    NOT NULL DEFAULT 0,
  outcome_json TEXT
);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  tool        TEXT    NOT NULL,
  input_json  TEXT    NOT NULL DEFAULT '{}',
  result_json TEXT    NOT NULL DEFAULT '{}',
  frame_path  TEXT,
  is_error    INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE IF NOT EXISTS wakeups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fire_at      INTEGER NOT NULL,
  condition    TEXT    NOT NULL,
  interval_s   INTEGER NOT NULL DEFAULT 300,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 12
);
CREATE INDEX IF NOT EXISTS idx_wakeups_fire ON wakeups(fire_at);

-- Never secrets. API keys go through Electron safeStorage (PRD §7.5).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
