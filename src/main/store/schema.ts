import type Database from 'better-sqlite3';

/// The full v1 schema from PRD §4, created at M1 even though M1 only writes
/// `frames` and `settings`. Creating it now means M3's notes engine is a set of
/// queries rather than a migration, and the shape is reviewable while it is
/// still cheap to change.

export const SCHEMA_VERSION = 3;

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
  -- Always NULL. Reserved in v1 for vector search; when it arrived (M5) it
  -- needed vectors for observations, facts and runs too, so they all live in
  -- \`memory_vectors\` instead. Left in place because dropping a column rewrites
  -- the table for no gain.
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
  outcome_json TEXT,
  -- Hands-off: worked through the accessibility tree, beside the person.
  hands_off    INTEGER NOT NULL DEFAULT 0
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

-- ── M5 — buddy learns you ────────────────────────────────────────────────────

-- What buddy has learned about the person: one atomic statement per row.
-- \`confidence\` is the belief as of \`last_seen_at\`; what prompts and the UI use
-- is that belief decayed by age (memory/facts.ts), computed at read time so
-- nothing has to run on a clock for an old habit to fade.
CREATE TABLE IF NOT EXISTS facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT    NOT NULL CHECK (kind IN ('preference','habit','workflow','skill','project','relationship','goal','context')),
  statement         TEXT    NOT NULL,
  confidence        REAL    NOT NULL DEFAULT 0.5,
  evidence          INTEGER NOT NULL DEFAULT 1,
  source            TEXT    NOT NULL CHECK (source IN ('observed','told','run','corrected')),
  -- pinned = the user confirmed it or said it; rejected = the user said it is
  -- wrong, and it is kept so buddy does not learn it again next hour.
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','pinned','rejected','superseded')),
  superseded_by     INTEGER REFERENCES facts(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  source_obs_json   TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status, last_seen_at DESC);

-- Every run, as something to learn from. \`correction\` rows are the strongest
-- signal buddy gets: it proposed one goal and the person ran another.
-- Deleting a run deletes what was learned from it, because deleting a run is
-- how a person says "forget that happened".
CREATE TABLE IF NOT EXISTS episodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('run','correction')),
  ts             INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  goal           TEXT    NOT NULL,
  inferred_goal  TEXT,
  -- accepted | alternative | corrected | typed | provisional
  goal_source    TEXT    NOT NULL DEFAULT 'typed',
  status         TEXT    NOT NULL DEFAULT '',
  summary        TEXT    NOT NULL DEFAULT '',
  apps_json      TEXT    NOT NULL DEFAULT '[]',
  steps          INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  learned_at     INTEGER,
  UNIQUE (run_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(ts DESC);

-- How the week is shaped: active seconds per app per local hour, from the
-- free T0 signal. Survives frame retention, costs nothing, needs no model.
CREATE TABLE IF NOT EXISTS app_usage (
  day       TEXT    NOT NULL,
  hour      INTEGER NOT NULL,
  weekday   INTEGER NOT NULL,
  bundle_id TEXT    NOT NULL,
  app_name  TEXT    NOT NULL,
  seconds   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour, bundle_id)
);

-- The memory index: one row per memory item, whatever it is, holding the
-- exact text it is searched by and, when an embedding model is installed, its
-- unit vector. Both halves of recall search *this* table — keywords through
-- \`memory_fts\`, meaning through the vector — so the two always agree on what
-- an item says, and keyword scores come from one corpus rather than being
-- pooled across tables with different statistics.
--
-- This table is the truth; sqlite-vec's \`memory_vec\` is an accelerator
-- rebuilt from it, so buddy still searches by meaning on a machine where the
-- extension will not load. \`src_version\` is the source row's \`updated_at\`
-- when it was indexed — an edit changes it, which is how the index knows it is
-- stale. \`vector\` is empty for text with nothing to embed, and for every row
-- when no model is installed (\`model\` = 'none'): keywords still work then.
CREATE TABLE IF NOT EXISTS memory_vectors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL CHECK (source IN ('note','observation','fact','episode')),
  source_id   INTEGER NOT NULL,
  src_version INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  text        TEXT    NOT NULL DEFAULT '',
  vector      BLOB    NOT NULL,
  UNIQUE (source, source_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text, content='memory_vectors', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_vectors BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_vectors BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF text ON memory_vectors BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

/** Steps from one `user_version` to the next, for databases created before it.
 *  `SCHEMA` is all `IF NOT EXISTS`, so new tables appear on their own; what a
 *  migration is for is the work that has to happen to *existing rows*. */
export const MIGRATIONS: Record<number, string | ((db: Database.Database) => void)> = {
  // v1 → v2 is additive: every M5 table is new, and the memory index fills
  // itself from the existing notes and observations on the first launch
  // (memory/index.ts), because what it needs is an embedding, not SQL.
  2: '',
  // v2 → v3: hands-off runs. A column on an existing table is the one change
  // `CREATE TABLE IF NOT EXISTS` cannot make on its own — and SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, so it asks first. A database whose `runs`
  // table was created from this file already has the column.
  3: (db) => {
    const cols = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'hands_off')) {
      db.exec('ALTER TABLE runs ADD COLUMN hands_off INTEGER NOT NULL DEFAULT 0');
    }
  },
};
