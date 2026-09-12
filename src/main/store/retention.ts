import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { frames } from './frames.js';
import { paths } from '../paths.js';
import { log } from '../log.js';

/// Retention (PRD §5.1). Frames expire; the notes made from them do not.
///
/// Runs on launch and hourly. Running on launch matters more than it looks:
/// the app is not always open, so an hourly timer alone would let a machine
/// that was asleep overnight wake up with two-day-old screenshots on disk.

const HOUR_MS = 3_600_000;

export interface PurgeReport {
  expiredFrames: number;
  orphanFiles: number;
  emptyDirs: number;
  staleStaging: number;
  ranAt: number;
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(r: PurgeReport) => void>();

  start() {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), HOUR_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onSweep(fn: (r: PurgeReport) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  sweep(): PurgeReport {
    const now = Date.now();
    const report: PurgeReport = {
      expiredFrames: 0,
      orphanFiles: 0,
      emptyDirs: 0,
      staleStaging: 0,
      ranAt: now,
    };

    try {
      const expired = getDb()
        .prepare('SELECT id FROM frames WHERE deleted_at IS NULL AND expires_at <= ?')
        .all(now) as { id: number }[];
      report.expiredFrames = frames.purge(expired.map((r) => r.id));

      report.orphanFiles = this.sweepOrphans();
      report.staleStaging = this.sweepStaging(now);
      report.emptyDirs = this.sweepEmptyDayDirs();

      const touched =
        report.expiredFrames + report.orphanFiles + report.staleStaging + report.emptyDirs;
      if (touched > 0) log.info('retention', 'swept', { ...report });
      else log.debug('retention', 'swept, nothing to do');
    } catch (e) {
      log.error('retention', 'sweep failed', { error: (e as Error).message });
    }

    for (const l of this.listeners) l(report);
    return report;
  }

  /** Files in the vault with no live row: the crash-between-write-and-insert
   *  case, and anything left by a database that was reset by hand. */
  private sweepOrphans(): number {
    const live = new Set(
      (getDb().prepare('SELECT path FROM frames WHERE deleted_at IS NULL').all() as { path: string }[]).map(
        (r) => r.path,
      ),
    );
    let removed = 0;
    for (const dir of this.dayDirs()) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.png')) continue;
        const full = path.join(dir, name);
        if (live.has(full)) continue;
        try {
          fs.unlinkSync(full);
          removed++;
        } catch {
          /* raced with another sweep */
        }
      }
    }
    return removed;
  }

  /** Staged frames are either promoted or unlinked within a second. Anything
   *  older than a minute is the residue of a crash mid-capture. */
  private sweepStaging(now: number): number {
    const dir = paths.staging();
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          if (now - fs.statSync(full).mtimeMs > 60_000) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {
          /* raced */
        }
      }
    } catch {
      /* no staging dir yet */
    }
    return removed;
  }

  private sweepEmptyDayDirs(): number {
    let removed = 0;
    for (const dir of this.dayDirs()) {
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
          removed++;
        }
      } catch {
        /* raced */
      }
    }
    return removed;
  }

  private dayDirs(): string[] {
    try {
      return fs
        .readdirSync(paths.frames(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
        .map((d) => path.join(paths.frames(), d.name));
    } catch {
      return [];
    }
  }

  /** "delete this day now" from the Timeline, and the bulk-delete in Settings. */
  purgeAll(): PurgeReport {
    const all = getDb().prepare('SELECT id FROM frames WHERE deleted_at IS NULL').all() as { id: number }[];
    const n = frames.purge(all.map((r) => r.id));
    log.info('retention', 'purged all frames on request', { count: n });
    return { ...this.sweep(), expiredFrames: n };
  }
}

export const retention = new RetentionSweeper();
