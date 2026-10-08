import type { GoalSource } from './types.js';

/// Shadow mode: buddy keeps score of how well it reads you, per kind of task.
///
/// Every activation is a prediction. buddy looks at the screen, says what it
/// thinks you are doing, and you either run that or you type something else —
/// and M5 already writes down which (`memory/episodes.ts`: `accepted`,
/// `alternative`, `corrected`). So the accuracy of buddy's judgement about you
/// is not something that needs a new always-on loop to measure. It is sitting
/// in the episodes table, ungathered.
///
/// What this file does is gather it **per kind of task**, because one number
/// over everything is useless: buddy can be excellent at "file a bug from a
/// thread" and hopeless at "tidy up this document", and an average hides both.
/// Tasks are grouped by the set of apps they touched, which is a coarse signal
/// that happens to separate the things people actually think of as different
/// jobs.
///
/// Two things it is careful not to be:
///
///   - **It is not a way for buddy to give itself permission.** The only thing
///     a strong record unlocks is an *offer*, shown in the HUD, that the person
///     accepts with the same keystroke they were going to press anyway. The
///     profile is never changed behind them, `leashless` is never offered at
///     all (PRD §7.1: buddy never suggests it), and the offer is withheld for
///     any task whose history shows it needed a confirmation, because that is
///     exactly the task where "nobody is watching" is the wrong answer.
///   - **It is not only good news.** A task buddy keeps getting wrong is worth
///     saying out loud at the moment it is about to be wrong again, and that
///     warning is the half of this feature that no other tool has.

export type TrustLevel = 'unknown' | 'learning' | 'shaky' | 'trusted';

/** One past run, reduced to what scoring needs. */
export interface TrustEpisode {
  runId: number;
  ts: number;
  goal: string;
  goalSource: GoalSource;
  status: string;
  apps: string[];
  /** The run hit at least one confirm gate — buddy had to stop and ask. */
  gated: boolean;
}

export interface TrustCluster {
  /** The sorted app set, which is also the group's identity. */
  key: string;
  apps: string[];
  /** "Slack + Linear", for a person. */
  label: string;
  /** Every run in the group. */
  runs: number;
  /** Runs where buddy proposed a goal and the person either took it or did
   *  not. Typed and provisional goals are excluded: §6.1's 200 ms guess is
   *  not buddy's judgement, and typing before the reading lands says nothing
   *  about it. */
  judged: number;
  accepted: number;
  corrected: number;
  succeeded: number;
  /** Runs that needed a confirmation. */
  gatedRuns: number;
  lastAt: number;
  /** accepted / judged, or 0 when nothing has been judged. */
  rate: number;
  level: TrustLevel;
  /** The most recent judged run was a correction. Outranks an old streak: a
   *  task buddy was right about ten times and wrong about this morning is a
   *  task something has changed about. */
  recentCorrection: boolean;
  /** An example of what this kind of task looks like, in the person's words. */
  example: string;
}

/** Below this many judged runs buddy has not seen enough to say anything. */
export const MIN_JUDGED = 3;
/** And below this many it will not offer anything, however good the rate. */
export const MIN_FOR_OFFER = 5;
export const TRUSTED_RATE = 0.8;
export const SHAKY_RATE = 0.5;

const ACCEPTING: GoalSource[] = ['accepted', 'alternative'];
const JUDGING: GoalSource[] = ['accepted', 'alternative', 'corrected'];

/**
 * The name to show for an app.
 *
 * A run's apps are recorded as the names macOS shows ("Slack"), because that
 * is what a prompt and a log should read; a goal reading names its apps by
 * bundle id, because that is what an allowlist is. So this takes either, and a
 * plain name passes straight through — the last segment of a bundle id is only
 * a guess, and it is only ever used when no better name has been seen.
 */
export function appLabel(app: string): string {
  if (!app.includes('.')) return app;
  const last = app.split('.').pop() ?? app;
  const cleaned = last.replace(/[-_]/g, ' ').replace(/mac(gap|os|app)?$/i, '').trim();
  const word = cleaned || last;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function clusterKey(apps: string[]): string {
  return [...new Set(apps.filter(Boolean))].sort().join('+');
}

export function clusterLabel(apps: string[]): string {
  const names = [...new Set(apps.filter(Boolean))].sort().map(appLabel);
  if (!names.length) return 'Tasks with no app recorded';
  if (names.length <= 3) return names.join(' + ');
  return `${names.slice(0, 3).join(' + ')} + ${names.length - 3} more`;
}

function levelOf(c: Omit<TrustCluster, 'level'>): TrustLevel {
  if (c.judged < MIN_JUDGED) return 'unknown';
  if (c.rate < SHAKY_RATE || (c.recentCorrection && c.rate < TRUSTED_RATE)) return 'shaky';
  if (c.rate >= TRUSTED_RATE && c.judged >= MIN_JUDGED) return 'trusted';
  return 'learning';
}

/** Group runs by the apps they touched and score each group. */
export function buildClusters(episodes: TrustEpisode[]): TrustCluster[] {
  const groups = new Map<string, TrustEpisode[]>();
  for (const e of episodes) {
    const key = clusterKey(e.apps);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out: TrustCluster[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => b.ts - a.ts);
    const judgedList = sorted.filter((e) => JUDGING.includes(e.goalSource));
    const accepted = judgedList.filter((e) => ACCEPTING.includes(e.goalSource)).length;
    const corrected = judgedList.length - accepted;
    const base = {
      key,
      apps: key ? key.split('+') : [],
      label: clusterLabel(key ? key.split('+') : []),
      runs: sorted.length,
      judged: judgedList.length,
      accepted,
      corrected,
      succeeded: sorted.filter((e) => e.status === 'done').length,
      gatedRuns: sorted.filter((e) => e.gated).length,
      lastAt: sorted[0]?.ts ?? 0,
      rate: judgedList.length ? accepted / judgedList.length : 0,
      recentCorrection: judgedList[0] ? !ACCEPTING.includes(judgedList[0].goalSource) : false,
      example: sorted.find((e) => e.goal)?.goal ?? '',
    };
    out.push({ ...base, level: levelOf(base) });
  }
  return out.sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

/** How alike two app sets are. Exactly equal is 1; nothing in common is 0. */
export function overlap(a: string[], b: string[]): number {
  const A = new Set(a.filter(Boolean));
  const B = new Set(b.filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / (A.size + B.size - shared);
}

/** A run's apps are never exactly the same twice — one run touches the browser
 *  and the next does not — so the cluster for a new reading is the closest
 *  one, not an exact match. Half the apps in common is the floor. */
export const MIN_OVERLAP = 0.5;

export function matchCluster(clusters: TrustCluster[], apps: string[]): TrustCluster | null {
  const key = clusterKey(apps);
  const exact = clusters.find((c) => c.key === key);
  if (exact) return exact;
  let best: TrustCluster | null = null;
  let bestScore = 0;
  for (const c of clusters) {
    const score = overlap(c.apps, apps);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore >= MIN_OVERLAP ? best : null;
}

/** What the HUD shows about this kind of task, when there is anything to say. */
export interface TrustView {
  level: TrustLevel;
  label: string;
  runs: number;
  judged: number;
  accepted: number;
  /** One sentence, in the HUD, beside the goal. */
  sentence: string;
  /** A profile worth offering, with the reason. Null when there is nothing to
   *  offer — which is most of the time, and always for a task that has ever
   *  needed a confirmation. */
  offer: { profile: 'unattended'; why: string } | null;
}

/**
 * The offer, and the rule that withholds it.
 *
 * `unattended` is the only profile buddy will ever propose, and only when the
 * history says the proposal costs nothing: at least five runs of this kind,
 * four in five of them buddy's own reading, the most recent one not a
 * correction, and **not one of them ever stopped at a confirmation**.
 *
 * That last clause is the whole safety argument. Under `unattended` a send, a
 * delete or an install is refused outright and the run parks (§7.1) — so for a
 * task that has never needed one, the profile is a pure improvement: nobody is
 * interrupted and nothing dangerous can happen. For a task that *has* needed
 * one, switching to unattended would turn a question into a dead stop, which
 * is both worse for the person and a thing buddy would have talked them into.
 * So it is not offered, however long the streak.
 */
export function trustView(c: TrustCluster | null, proposed: string): TrustView | null {
  if (!c || c.level === 'unknown') return null;
  const of = `${c.accepted} of ${c.judged}`;
  if (c.level === 'shaky') {
    return {
      level: c.level,
      label: c.label,
      runs: c.runs,
      judged: c.judged,
      accepted: c.accepted,
      sentence: c.recentCorrection
        ? `buddy read this kind of task right ${of} times, and got the last one wrong. Worth a look before you run it.`
        : `buddy has read this kind of task right only ${of} times. Worth a look before you run it.`,
      offer: null,
    };
  }
  const canOffer =
    c.level === 'trusted' &&
    c.judged >= MIN_FOR_OFFER &&
    c.gatedRuns === 0 &&
    !c.recentCorrection &&
    proposed === 'attended';
  return {
    level: c.level,
    label: c.label,
    runs: c.runs,
    judged: c.judged,
    accepted: c.accepted,
    sentence:
      c.level === 'trusted'
        ? `You have taken buddy's read on this kind of task ${of} times.`
        : `buddy is still learning this kind of task — your read ${of} times so far.`,
    offer: canOffer
      ? {
          profile: 'unattended',
          why: `${c.runs} runs like this, none of them needed you to approve anything. Unattended means buddy will not ask — and will refuse outright if something does turn out to need approving.`,
        }
      : null,
  };
}
