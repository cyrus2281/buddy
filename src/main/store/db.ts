import Database from 'better-sqlite3';
import fs from 'node:fs';
import { paths } from '../paths.js';
import { log } from '../log.js';
import { MIGRATIONS, SCHEMA, SCHEMA_VERSION } from './schema.js';

/// Single SQLite handle for the main process. better-sqlite3 is synchronous,
/// which is the right trade here: every query M1 makes is indexed and
/// sub-millisecond, and the alternative is threading async through the capture
/// loop for no measurable gain.

let db: Database.Database | null = null;

export function openDb(): Database.Database {
  if (db) return db;
  paths.ensure();
  const file = paths.db();
  db = new Database(file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* fresh file, already ours */
  }

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  migrate(db, file);
  return db;
}

/** Bring an older database up to `SCHEMA_VERSION`, one step at a time, each in
 *  its own transaction with the version bump — so a migration that fails
 *  leaves the database at the last version that fully applied rather than
 *  half-way between two. */
function migrate(handle: Database.Database, file: string) {
  const current = (handle.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current === 0) {
    handle.pragma(`user_version = ${SCHEMA_VERSION}`);
    log.info('store', 'schema created', { version: SCHEMA_VERSION, file });
    return;
  }
  if (current > SCHEMA_VERSION) {
    // A newer buddy wrote this file. Its tables are a superset of ours, so
    // carry on — but say so, because a downgrade is the one direction nothing
    // here was written to handle.
    log.warn('store', 'the database is newer than this build', { onDisk: current, expected: SCHEMA_VERSION });
    return;
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    handle.transaction(() => {
      const step = MIGRATIONS[v];
      if (typeof step === 'function') step(handle);
      else if (step) handle.exec(step);
      handle.pragma(`user_version = ${v}`);
    })();
    log.info('store', 'schema migrated', { from: v - 1, to: v });
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('database not open');
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

/// Settings live in SQLite as JSON per key. Secrets never do.
export const kv = {
  get<T>(key: string, fallback: T): T {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      log.warn('store', 'unparseable setting, using fallback', { key });
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    getDb()
      .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  },
};
