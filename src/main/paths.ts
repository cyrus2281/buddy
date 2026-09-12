import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/// Every path buddy writes to, in one place, created with 0700 on first touch.
/// The frame vault holds screenshots of whatever the user was doing; it is not
/// a directory that should be world-readable because someone forgot a umask.

const root = () => path.join(app.getPath('appData'), 'buddy');

export const paths = {
  root,
  db: () => path.join(root(), 'buddy.db'),
  frames: () => path.join(root(), 'frames'),
  /** Frames land here first, and are promoted into the vault only if kept. */
  staging: () => path.join(root(), 'frames', '.staging'),
  logs: () => path.join(root(), 'logs'),
  /** The §7.3 sentinel kill switch, deliberately outside Application Support so
   *  it can be created from a shell in one obvious command. */
  abortFile: () => path.join(app.getPath('home'), '.buddy', 'ABORT'),
  scratch: () => path.join(app.getPath('home'), '.buddy', 'scratch'),

  /** Frames are filed by day so the retention sweep and the Timeline's
   *  "delete this day now" button both operate on a directory, not a query. */
  dayDir(ts: number): string {
    const d = new Date(ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(root(), 'frames', day);
  },

  ensure() {
    for (const dir of [root(), this.frames(), this.staging(), this.logs(), path.dirname(this.abortFile()), this.scratch()]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* already ours */
      }
    }
  },
};
