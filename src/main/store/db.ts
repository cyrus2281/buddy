import Database from 'better-sqlite3';
import fs from 'node:fs';
import { paths } from '../paths.js';
import { log } from '../log.js';
import { SCHEMA, SCHEMA_VERSION } from './schema.js';

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

  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current === 0) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    log.info('store', 'schema created', { version: SCHEMA_VERSION, file });
  } else if (current !== SCHEMA_VERSION) {
    // No migrations exist yet. Saying so is more useful than a silent mismatch.
    log.warn('store', 'schema version mismatch', { onDisk: current, expected: SCHEMA_VERSION });
  }
  return db;
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
