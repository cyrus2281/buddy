import { getDb } from '../store/db.js';
import { log } from '../log.js';
import type { EpisodeView, GoalSource, InferenceState, RunView } from '../../shared/types.js';

/// Episodic memory: every run buddy did, and every time the person overrode
/// the goal buddy proposed.
///
/// A run is the one moment buddy's picture of someone is tested against what
/// they actually wanted. If buddy said "reply to Priya in a new DM" and the
/// person typed "reply in the thread", that is not noise to discard with the
/// HUD — it is the single most informative thing buddy will see all day about
/// how this person works. So it is written down here, shown to the next goal
/// inference that looks similar, and handed to the next rollup to learn from.
///
/// Successful runs are worth keeping too, for a humbler reason: "last time you
/// asked for something like this, it took 18 steps and ended with the ticket
/// linked to the thread" is useful context for the Operator, and it is free.

/** What the HUD was offering when the run started, captured before the run so
 *  the comparison is against what the person actually saw. */
export interface ActivationSnapshot {
  goal: string | null;
  source: InferenceState['source'];
  alternatives: string[];
  confidence: number | null;
}

export function snapshotOf(st: InferenceState | null): ActivationSnapshot | null {
  if (!st || st.phase === 'idle' || !st.goal) return null;
  return {
    goal: st.goal,
    source: st.source,
    alternatives: st.reading?.alternatives.map((a) => a.goal) ?? [],
    confidence: st.reading?.confidence ?? null,
  };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * How the goal that ran relates to the one on offer.
 *
 * Compared after normalising case and punctuation — a goal accepted with a
 * trailing full stop removed is an acceptance, not a correction — and nothing
 * looser than that. A small edit to a proposed goal is a correction worth
 * learning from ("…in the thread" rather than "…in a DM" is two words).
 */
export function classifyGoal(ran: string, offered: ActivationSnapshot | null): GoalSource {
  if (!offered?.goal) return 'typed';
  const r = norm(ran);
  if (r === norm(offered.goal)) return offered.source === 'model' ? 'accepted' : 'provisional';
  if (offered.alternatives.some((a) => norm(a) === r)) return 'alternative';
  // Only a model reading is a proposal worth learning a correction from. A
  // provisional goal is the newest task's title, shown for 200 ms while the
  // reading loads; typing over it says nothing about buddy's judgement.
  return offered.source === 'model' ? 'corrected' : 'typed';
}

interface RawEpisode {
  id: number;
  run_id: number;
  kind: 'run' | 'correction';
  ts: number;
  updated_at: number;
  goal: string;
  inferred_goal: string | null;
  goal_source: GoalSource;
  status: string;
  summary: string;
  apps_json: string;
  steps: number;
  cost_usd: number;
  learned_at: number | null;
}

function toView(r: RawEpisode): EpisodeView {
  let apps: string[] = [];
  try {
    apps = JSON.parse(r.apps_json);
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    ts: r.ts,
    goal: r.goal,
    inferredGoal: r.inferred_goal,
    goalSource: r.goal_source,
    status: r.status,
    summary: r.summary,
    apps,
    steps: r.steps,
    costUsd: r.cost_usd,
    learnedAt: r.learned_at,
  };
}

/** The apps a run touched, from the guardrail verdicts on its steps: read off
 *  the accessibility tree at dispatch, so it is what was actually driven
 *  rather than what the model said it would drive. */
function appsOf(view: RunView): string[] {
  const seen = new Set<string>();
  for (const s of view.steps) if (s.verdict?.appName) seen.add(s.verdict.appName);
  return [...seen];
}

/** Terminal states worth remembering. `running`, `gated` and `confirming` are
 *  not outcomes. */
const TERMINAL = new Set(['done', 'waiting', 'needs_human', 'cancelled']);

export const episodes = {
  /**
   * Record a run that just ended, and the correction it carried if any.
   *
   * Idempotent per run: a run that waits, resumes and then finishes updates
   * its one row rather than leaving three. The correction is written once, the
   * first time — it is about the moment the run started, and a resume does
   * not change what the person chose then.
   */
  recordRun(view: RunView, offered: ActivationSnapshot | null, now = Date.now()): {
    run: EpisodeView | null;
    correction: EpisodeView | null;
  } {
    if (!view.id || !TERMINAL.has(view.status)) return { run: null, correction: null };
    const db = getDb();
    // The run row must exist: an episode is learned *from* a run, and the
    // cascade that deletes it with the run depends on the reference. Its
    // steps and cost are read from it too, because the row is cumulative
    // across standby resumes and the view's budgets restart on each one.
    const row = db.prepare('SELECT steps, cost_usd FROM runs WHERE id = ?').get(view.id) as
      | { steps: number; cost_usd: number }
      | undefined;
    if (!row) return { run: null, correction: null };

    const existing = db.prepare("SELECT * FROM episodes WHERE run_id = ? AND kind = 'run'").get(view.id) as
      | RawEpisode
      | undefined;
    const source = existing ? existing.goal_source : classifyGoal(view.goal, offered);
    const inferred = existing ? existing.inferred_goal : offered?.goal ?? null;
    const summary = (view.outcome?.summary ?? view.haltReason ?? '').trim().slice(0, 600);
    const apps = JSON.stringify(appsOf(view));

    db.prepare(
      `INSERT INTO episodes (run_id, kind, ts, updated_at, goal, inferred_goal, goal_source, status, summary, apps_json, steps, cost_usd)
       VALUES (?, 'run', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, kind) DO UPDATE SET
         updated_at = excluded.updated_at, status = excluded.status, summary = excluded.summary,
         apps_json = excluded.apps_json, steps = excluded.steps, cost_usd = excluded.cost_usd,
         learned_at = NULL`,
    ).run(view.id, view.startedAt || now, now, view.goal, inferred, source, view.status, summary, apps, row.steps, row.cost_usd);

    let correction: EpisodeView | null = null;
    if (!existing && (source === 'corrected' || source === 'alternative') && offered?.goal) {
      db.prepare(
        `INSERT OR IGNORE INTO episodes (run_id, kind, ts, updated_at, goal, inferred_goal, goal_source, status, summary, apps_json)
         VALUES (?, 'correction', ?, ?, ?, ?, ?, ?, '', ?)`,
      ).run(view.id, view.startedAt || now, now, view.goal, offered.goal, source, view.status, apps);
      correction = this.byRun(view.id, 'correction');
      log.info('memory', 'the user overrode buddy’s goal; remembered as a correction', {
        runId: view.id,
        source,
      });
    }
    return { run: this.byRun(view.id, 'run'), correction };
  },

  byRun(runId: number, kind: 'run' | 'correction'): EpisodeView | null {
    const r = getDb().prepare('SELECT * FROM episodes WHERE run_id = ? AND kind = ?').get(runId, kind) as
      | RawEpisode
      | undefined;
    return r ? toView(r) : null;
  },

  byIds(ids: number[]): EpisodeView[] {
    if (!ids.length) return [];
    return (
      getDb()
        .prepare(`SELECT * FROM episodes WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as RawEpisode[]
    ).map(toView);
  },

  recent(limit = 50, kind?: 'run' | 'correction'): EpisodeView[] {
    return (
      getDb()
        .prepare(`SELECT * FROM episodes ${kind ? 'WHERE kind = ?' : ''} ORDER BY ts DESC LIMIT ?`)
        .all(...(kind ? [kind, limit] : [limit])) as RawEpisode[]
    ).map(toView);
  },

  /** What the next rollup has not yet learned from, oldest first. */
  unlearned(limit = 12): EpisodeView[] {
    return (
      getDb()
        .prepare('SELECT * FROM episodes WHERE learned_at IS NULL ORDER BY ts LIMIT ?')
        .all(limit) as RawEpisode[]
    ).map(toView);
  },

  markLearned(ids: number[], at = Date.now()): void {
    if (!ids.length) return;
    getDb()
      .prepare(`UPDATE episodes SET learned_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(at, ...ids);
  },

  counts(): { runs: number; corrections: number } {
    const r = getDb()
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE kind = 'run') AS runs,
                COUNT(*) FILTER (WHERE kind = 'correction') AS corrections FROM episodes`,
      )
      .get() as { runs: number; corrections: number };
    return r;
  },
};

/** The text an episode is embedded and shown as. One function, so what the
 *  index matches on and what a prompt reads cannot drift apart. */
export function episodeText(e: Pick<EpisodeView, 'kind' | 'goal' | 'inferredGoal' | 'goalSource' | 'status' | 'summary'>): string {
  if (e.kind === 'correction') {
    return e.goalSource === 'alternative'
      ? `buddy proposed "${e.inferredGoal}", and the person chose buddy's second guess instead: "${e.goal}".`
      : `buddy proposed "${e.inferredGoal}", and the person ran "${e.goal}" instead.`;
  }
  const outcome =
    e.status === 'done'
      ? 'finished'
      : e.status === 'waiting'
        ? 'went to standby'
        : e.status === 'cancelled'
          ? 'was cancelled'
          : 'stopped for a person';
  return `Run "${e.goal}" ${outcome}${e.summary ? `: ${e.summary}` : '.'}`;
}
