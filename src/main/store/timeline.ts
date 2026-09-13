import fs from 'node:fs';
import { getDb } from './db.js';
import { frames } from './frames.js';
import { log } from '../log.js';
import type { FrameRow, TimelineDay } from '../../shared/types.js';

/// The Timeline's queries (PRD §8.4).
///
/// The day key is computed in **SQLite, in local time**, and that is the whole
/// subtlety in this file. Frames are filed on disk by `paths.dayDir`, which
/// uses the local date, so a UTC-derived key would disagree with the directory
/// layout for anyone west of Greenwich for part of every day — and the symptom
/// would be a Timeline whose "yesterday" holds this morning's frames. SQLite's
/// `'localtime'` modifier applies the same rule `Date` does.
///
/// The retention countdown is `MIN(expires_at)` rather than the day plus the
/// setting: retention is stamped onto each frame when it is written (§5.1), so
/// a user who changed the setting yesterday has frames from both regimes and
/// only the rows know which is which. Deriving the countdown from the current
/// setting would show a number that is simply not when the files go.

const DAY_EXPR = "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')";

export const timeline = {
  /** Every day that still has live frames, newest first. */
  days(): TimelineDay[] {
    const rows = getDb()
      .prepare(
        `SELECT ${DAY_EXPR} AS day, COUNT(*) AS frames, MIN(expires_at) AS expires_at
           FROM frames WHERE deleted_at IS NULL
          GROUP BY day ORDER BY day DESC`,
      )
      .all() as { day: string; frames: number; expires_at: number }[];

    return rows.map((r) => ({
      day: r.day,
      frames: r.frames,
      bytes: this.bytesFor(r.day),
      expiresAt: r.expires_at,
      apps: this.appsFor(r.day),
    }));
  },

  /** Which apps appear on a day, and how often — the filter's options, ordered
   *  by how much of the day they were (§8.4). */
  appsFor(day: string): { bundleId: string; appName: string; count: number }[] {
    return getDb()
      .prepare(
        `SELECT bundle_id AS bundleId, app_name AS appName, COUNT(*) AS count
           FROM frames WHERE deleted_at IS NULL AND ${DAY_EXPR} = ?
          GROUP BY bundle_id, app_name ORDER BY count DESC`,
      )
      .all(day) as { bundleId: string; appName: string; count: number }[];
  },

  /** Filmstrip order is chronological: the day reads left to right the way it
   *  happened, which is the only ordering a scrubber makes sense over. */
  framesFor(day: string, bundleId?: string | null, limit = 2_000): FrameRow[] {
    const args: unknown[] = [day];
    let where = `deleted_at IS NULL AND ${DAY_EXPR} = ?`;
    if (bundleId) {
      where += ' AND bundle_id = ?';
      args.push(bundleId);
    }
    args.push(limit);
    return getDb()
      .prepare(`SELECT * FROM frames WHERE ${where} ORDER BY ts ASC LIMIT ?`)
      .all(...args) as FrameRow[];
  },

  bytesFor(day: string): number {
    let bytes = 0;
    for (const r of getDb()
      .prepare(`SELECT path FROM frames WHERE deleted_at IS NULL AND ${DAY_EXPR} = ?`)
      .all(day) as { path: string }[]) {
      try {
        bytes += fs.statSync(r.path).size;
      } catch {
        /* unlinked between the query and the stat; the next sweep tombstones it */
      }
    }
    return bytes;
  },

  /**
   * "Delete this day now" (§8.4).
   *
   * Goes through `frames.purge`, which unlinks and tombstones, so a note that
   * cites one of these frames still says it existed and has expired rather than
   * quietly showing a shorter list (§5.1). Deleting a day is not deleting what
   * buddy learned that day, and the Timeline says so on its face.
   */
  deleteDay(day: string): number {
    const ids = (
      getDb()
        .prepare(`SELECT id FROM frames WHERE deleted_at IS NULL AND ${DAY_EXPR} = ?`)
        .all(day) as { id: number }[]
    ).map((r) => r.id);
    const n = frames.purge(ids);
    log.info('timeline', 'day purged on request', { day, frames: n });
    return n;
  },
};
