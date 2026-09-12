import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { paths } from '../paths.js';
import { log } from '../log.js';
import type { FrameRow } from '../../shared/types.js';

/// The frame vault: PNGs on disk, one row each in SQLite. The row is the index;
/// the file is the payload. They are written in that order and deleted in the
/// reverse one, so a crash leaves an orphan file (harmless, swept later) rather
/// than a row pointing at nothing (a broken Timeline).

export interface InsertFrame {
  ts: number;
  displayId: number;
  stagingPath: string;
  w: number;
  h: number;
  bundleId: string;
  appName: string;
  windowTitle: string;
  phash: string;
  retentionDays: number;
}

export const frames = {
  /** Moves the staged PNG into the day's vault directory and records it. */
  keep(f: InsertFrame): FrameRow {
    const dir = paths.dayDir(f.ts);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${f.ts}-${f.displayId}-${f.phash}.png`;
    const dest = path.join(dir, name);
    fs.renameSync(f.stagingPath, dest);
    fs.chmodSync(dest, 0o600);

    const expiresAt = f.ts + f.retentionDays * 86_400_000;
    const info = getDb()
      .prepare(
        `INSERT INTO frames (ts, display_id, path, w, h, bundle_id, app_name, window_title, phash, expires_at)
         VALUES (@ts, @displayId, @path, @w, @h, @bundleId, @appName, @windowTitle, @phash, @expiresAt)`,
      )
      .run({ ...f, path: dest, expiresAt });

    return getDb().prepare('SELECT * FROM frames WHERE id = ?').get(info.lastInsertRowid) as FrameRow;
  },

  /** The most recent live frame, which is what dedupe compares against. */
  latest(): FrameRow | undefined {
    return getDb()
      .prepare('SELECT * FROM frames WHERE deleted_at IS NULL ORDER BY ts DESC LIMIT 1')
      .get() as FrameRow | undefined;
  },

  recent(limit = 50): FrameRow[] {
    return getDb()
      .prepare('SELECT * FROM frames WHERE deleted_at IS NULL ORDER BY ts DESC LIMIT ?')
      .all(limit) as FrameRow[];
  },

  countLive(): { count: number; bytes: number } {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS count FROM frames WHERE deleted_at IS NULL')
      .get() as { count: number };
    let bytes = 0;
    for (const f of getDb()
      .prepare('SELECT path FROM frames WHERE deleted_at IS NULL')
      .all() as { path: string }[]) {
      try {
        bytes += fs.statSync(f.path).size;
      } catch {
        /* already gone; the sweep will tombstone it */
      }
    }
    return { count: row.count, bytes };
  },

  /** Unlink the file, tombstone the row. The row survives so a note that cites
   *  this frame can still say the frame existed and has expired. */
  purge(ids: number[]): number {
    if (ids.length === 0) return 0;
    const db = getDb();
    const select = db.prepare(`SELECT id, path FROM frames WHERE id IN (${ids.map(() => '?').join(',')})`);
    const tombstone = db.prepare('UPDATE frames SET deleted_at = ?, path = ? WHERE id = ?');
    const now = Date.now();
    let n = 0;
    const tx = db.transaction((rows: { id: number; path: string }[]) => {
      for (const r of rows) {
        try {
          if (r.path) fs.unlinkSync(r.path);
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') log.warn('frames', 'unlink failed', { path: r.path, error: err.message });
        }
        tombstone.run(now, '', r.id);
        n++;
      }
    });
    tx(select.all(...ids) as { id: number; path: string }[]);
    return n;
  },
};
