import { EventEmitter } from 'node:events';
import { kv } from '../store/db.js';
import { log } from '../log.js';
import { Exclusions } from '../capture/exclusions.js';
import {
  planRestore,
  type RestoreItem,
  type RestorePlan,
  type WorkspaceApp,
  type WorkspaceSnapshot,
} from '../../shared/workspace.js';
import type { AppWindows } from '../sidecar/supervisor.js';
import type { ExclusionRule } from '../../shared/types.js';

/// "Where was I?" — keeping the arrangement, and putting it back.
///
/// Every half minute while buddy is observing, it writes down which apps have
/// windows open, what documents they are showing, and what page a browser's
/// front window is on. That is one accessibility call, no model, and a few
/// hundred bytes; it is the cheapest thing in the product and it answers the
/// most expensive question in the PRD (§2: twenty minutes a day reloading
/// context).
///
/// **The same exclusion list that keeps 1Password out of the frame vault keeps
/// it out of here**, and for a stronger reason: a snapshot is text that
/// survives the daily purge, and "the documents and URLs you had open" is a
/// more legible record of a person's day than a screenshot is. So it is
/// filtered on the way in, never on the way out, and what was left out is
/// counted so the UI can say so.
///
/// **Snapshots are kept by count, not by day.** Twenty of them, a few hundred
/// bytes each, rolling — enough to answer "where was I" for the last few
/// sessions, bounded so it can never become a history nobody asked for.

const KEY = 'workspace.snapshots';
export const MAX_SNAPSHOTS = 20;
/** Sampling cadence. Half a minute is fine: an arrangement of windows is not a
 *  thing that changes meaningfully faster than that, and a missed change is
 *  caught by the next tick. */
export const SNAPSHOT_INTERVAL_MS = 30_000;
/** A snapshot with nothing in it is not worth a row. */
const MIN_APPS = 1;

export interface TrackerDeps {
  /** buddyd's `app_windows`. */
  windows: () => Promise<{ apps: AppWindows[] }>;
  /** buddyd's `open_app` — launches without bringing the app forward. */
  open: (p: { bundleId: string; url?: string; activate?: boolean }) => Promise<unknown>;
  exclusions: () => ExclusionRule[];
  /** The session a snapshot belongs to, or null between sessions. */
  sessionStartedAt: () => number | null;
  now?: () => number;
}

/** buddyd's windows, filtered and trimmed to what a restore needs. */
export function toSnapshot(
  apps: AppWindows[],
  rules: ExclusionRule[],
  sessionStartedAt: number | null,
  now: number,
): WorkspaceSnapshot {
  const ex = new Exclusions(rules);
  const out: WorkspaceApp[] = [];
  let excluded = 0;

  for (const a of apps) {
    if (!a.bundleId) continue;
    const appExcluded = ex.check(
      { bundleId: a.bundleId, appName: a.appName, pid: a.pid, windowTitle: '', idleSeconds: 0, secureInput: false, displayCount: 1 },
      false,
    ).skip;
    if (appExcluded) {
      excluded++;
      continue;
    }
    const windows = [];
    for (const w of a.windows) {
      // A window is checked by its own title too: a private browsing window is
      // excluded while the rest of the browser is not.
      const skip = ex.check(
        { bundleId: a.bundleId, appName: a.appName, pid: a.pid, windowTitle: w.title ?? '', idleSeconds: 0, secureInput: false, displayCount: 1 },
        false,
      ).skip;
      if (skip) {
        excluded++;
        continue;
      }
      windows.push({
        title: (w.title ?? '').slice(0, 160),
        ...(w.document ? { document: w.document } : {}),
        ...(w.url ? { url: w.url } : {}),
        ...(w.minimized ? { minimized: true } : {}),
      });
    }
    if (!windows.length) continue;
    out.push({ bundleId: a.bundleId, appName: a.appName, windows: windows.slice(0, 8) });
  }
  return { t: now, sessionStartedAt, apps: out, excluded };
}

export class WorkspaceTracker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private deps: TrackerDeps) {
    super();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), SNAPSHOT_INTERVAL_MS);
    this.timer.unref?.();
    void this.sample();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Take one now. Returns null when there was nothing to record, or when
   *  buddyd could not answer — neither is worth a log line every half minute. */
  async sample(): Promise<WorkspaceSnapshot | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const { apps } = await this.deps.windows();
      const snap = toSnapshot(apps, this.deps.exclusions(), this.deps.sessionStartedAt(), this.now());
      if (snap.apps.length < MIN_APPS) return null;
      this.append(snap);
      this.emit('change');
      return snap;
    } catch (e) {
      log.debug('workspace', 'could not sample the workspace', { error: (e as Error).message });
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Keep the newest, and keep them sparse.
   *
   * A snapshot every thirty seconds would fill the twenty slots in ten minutes
   * and leave buddy able to answer "where was I" only about the last ten. So a
   * new snapshot replaces the previous one when it belongs to the same session
   * and nothing has changed about which apps and documents are open — which,
   * for someone working in one place for an hour, is almost always.
   */
  private append(snap: WorkspaceSnapshot) {
    const all = this.all();
    const prev = all[all.length - 1];
    if (prev && prev.sessionStartedAt === snap.sessionStartedAt && shape(prev) === shape(snap)) {
      all[all.length - 1] = snap;
    } else {
      all.push(snap);
    }
    kv.set(KEY, all.slice(-MAX_SNAPSHOTS));
  }

  all(): WorkspaceSnapshot[] {
    return kv.get<WorkspaceSnapshot[]>(KEY, []);
  }

  latest(): WorkspaceSnapshot | null {
    const all = this.all();
    return all[all.length - 1] ?? null;
  }

  /**
   * The arrangement to offer back: the last one from a session that is not the
   * one happening now.
   *
   * "The end of the last session" rather than "the newest snapshot", because
   * the newest is from thirty seconds ago and restoring it would be a no-op.
   * When there is no earlier session — buddy has only ever seen this one — the
   * newest still answers "what do I have open", which is what the Home card
   * shows.
   */
  restorable(now = this.now()): WorkspaceSnapshot | null {
    const all = this.all();
    if (!all.length) return null;
    const session = this.deps.sessionStartedAt();
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i]!;
      if (session == null || s.sessionStartedAt !== session) return s;
    }
    // Only this session: the oldest snapshot of it is the arrangement it
    // started with, which is still a better answer than the newest.
    return now - all[0]!.t > 5 * 60_000 ? all[0]! : null;
  }

  /** What would be opened, against what is open right now. */
  async plan(): Promise<RestorePlan> {
    const from = this.restorable();
    if (!from) return planRestore(null, null, this.now());
    let current: WorkspaceSnapshot | null = null;
    try {
      const { apps } = await this.deps.windows();
      current = toSnapshot(apps, this.deps.exclusions(), this.deps.sessionStartedAt(), this.now());
    } catch {
      // Without a current reading everything reads as missing, which would
      // offer to open things that are already open. Say nothing instead.
      return planRestore(null, null, this.now());
    }
    return planRestore(from, current, this.now());
  }

  /**
   * Put it back.
   *
   * Each item is opened **without activating its app**, so a restore of six
   * windows does not throw the person through six context switches on its way
   * to finishing — the arrangement comes back behind what they are doing. The
   * last one is left to macOS's own ordering rather than forced to the front:
   * deciding which of someone's six windows should have focus is a judgement
   * buddy does not have.
   */
  async restore(items: RestoreItem[]): Promise<{ opened: number; failed: { label: string; why: string }[] }> {
    const failed: { label: string; why: string }[] = [];
    let opened = 0;
    for (const item of items) {
      if (item.present) continue;
      try {
        await this.deps.open({
          bundleId: item.bundleId,
          ...(item.target ? { url: item.target } : {}),
          activate: false,
        });
        opened++;
      } catch (e) {
        failed.push({ label: item.label, why: cleanError((e as Error).message) });
      }
    }
    log.info('workspace', 'restored', { opened, failed: failed.length });
    this.emit('change');
    return { opened, failed };
  }

  /** Everything buddy remembers about what was open. The Settings button. */
  forget() {
    kv.set(KEY, []);
    log.info('workspace', 'forgot every workspace snapshot');
    this.emit('change');
  }
}

/** What makes two snapshots "the same arrangement": the apps, and the
 *  documents and pages in them. Window titles change as you type; the set of
 *  things open does not. */
function shape(s: WorkspaceSnapshot): string {
  return s.apps
    .map((a) => `${a.bundleId}:${a.windows.map((w) => w.document ?? w.url ?? '').sort().join('|')}`)
    .sort()
    .join(';');
}

function cleanError(msg: string): string {
  return msg.replace(/\s*\(code -?\d+\)\s*$/, '').replace(/^[a-z_]+:\s*/, '');
}
