import { getDb, kv } from '../store/db.js';
import { log } from '../log.js';
import { episodes } from '../memory/episodes.js';
import { buildClusters, matchCluster, trustView, type TrustCluster, type TrustEpisode, type TrustView } from '../../shared/trust.js';

/// Shadow mode, against the real tables (`shared/trust.ts` is the scoring).
///
/// Nothing here is recorded that was not already being recorded. An episode
/// per run, with how the goal that ran related to the one buddy proposed, has
/// been written since M5; whether a run ever stopped at a confirmation is on
/// its steps, because the Run Log is the trust surface and every verdict is
/// kept. This reads both and groups them.

/** How far back a record is worth counting. A year-old streak on an app that
 *  has been redesigned twice since is not evidence about today. */
export const TRUST_WINDOW_MS = 120 * 86_400_000;
/** Enough runs to cover every kind of task someone does, bounded so a long
 *  history cannot make activation slow. */
const LIMIT = 400;

/**
 * Runs that stopped at a confirmation, by id.
 *
 * Matched on the serialized verdict rather than through JSON1, because the
 * envelope is written by `JSON.stringify` and the exact spelling is therefore
 * fixed — and because a string match needs no extension to be present on a
 * machine buddy has no control over. A gate the person approved counts the
 * same as one they denied: the question is whether this kind of task has ever
 * *needed* asking, not how it was answered.
 */
function gatedRunIds(): Set<number> {
  try {
    const rows = getDb()
      .prepare(`SELECT DISTINCT run_id FROM run_steps WHERE result_json LIKE '%"decision":"confirm"%'`)
      .all() as { run_id: number }[];
    return new Set(rows.map((r) => r.run_id));
  } catch (e) {
    // A query that fails must not take activation down; it means every task
    // looks un-gated, so the offer rule is the one thing that would be wrong.
    // Fail closed instead: no gate data, no offers.
    log.warn('shadow', 'could not read gate history; no autonomy will be offered', { error: (e as Error).message });
    return GATE_UNKNOWN;
  }
}

/** The sentinel a failed gate query returns: not a set of ids, a statement
 *  that nothing is known. `clusters` turns it into "every run was gated",
 *  which is what withholds every offer. */
const GATE_UNKNOWN = new Set<number>([-1]);

/**
 * Bundle id → the name macOS shows, learned for free.
 *
 * The two sides of a match are recorded in different vocabularies and neither
 * should change: a run's apps are names, because that is what belongs in a
 * prompt and a log; a reading's `target_apps` are bundle ids, because that is
 * what an allowlist is checked against. Rather than guess a translation from
 * the spelling — `com.tinyspeck.slackmacgap` is only "Slack" if you already
 * know — buddy writes down the pairs it sees. The T0 signal carries both,
 * every two seconds, at no cost.
 */
const NAMES_KEY = 'shadow.appNames';

export const appNames = {
  note(bundleId: string, appName: string) {
    if (!bundleId || !appName) return;
    const all = kv.get<Record<string, string>>(NAMES_KEY, {});
    if (all[bundleId] === appName) return;
    all[bundleId] = appName;
    // Bounded: a machine does not have thousands of apps, and a map that grows
    // without a limit is a map nobody remembers to prune.
    const keys = Object.keys(all);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
    kv.set(NAMES_KEY, all);
  },
  all(): Record<string, string> {
    return kv.get<Record<string, string>>(NAMES_KEY, {});
  },
  /** A bundle id as the name a run would have recorded, or the id unchanged
   *  when buddy has never seen the app in front. */
  nameOf(bundleId: string): string {
    return this.all()[bundleId] ?? bundleId;
  },
};

export const shadow = {
  /** Every kind of task buddy has done, scored. */
  clusters(now = Date.now()): TrustCluster[] {
    const gated = gatedRunIds();
    const unknown = gated === GATE_UNKNOWN;
    const since = now - TRUST_WINDOW_MS;
    const list: TrustEpisode[] = episodes
      .recent(LIMIT, 'run')
      .filter((e) => e.ts >= since)
      .map((e) => ({
        runId: e.runId,
        ts: e.ts,
        goal: e.goal,
        goalSource: e.goalSource,
        status: e.status,
        apps: e.apps,
        gated: unknown || gated.has(e.runId),
      }));
    return buildClusters(list);
  },

  /** What to say in the HUD about a reading that is about to be run. The apps
   *  arrive as bundle ids and the record is kept by name, so they are
   *  translated through what buddy has seen in front of it (`appNames`). */
  forApps(apps: string[], proposedProfile: string, now = Date.now()): TrustView | null {
    if (!apps.length) return null;
    try {
      const named = apps.map((a) => appNames.nameOf(a));
      return trustView(matchCluster(this.clusters(now), named), proposedProfile);
    } catch (e) {
      log.warn('shadow', 'could not score this kind of task', { error: (e as Error).message });
      return null;
    }
  },
};
