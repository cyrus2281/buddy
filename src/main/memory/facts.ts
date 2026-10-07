import { getDb } from '../store/db.js';
import { log } from '../log.js';
import {
  FACT_KINDS,
  type FactKind,
  type FactSource,
  type FactStatus,
  type FactView,
} from '../../shared/types.js';

/// The `facts` table: what buddy believes about the person, one sentence per
/// row, each with a confidence, a count of how often it was seen, and where it
/// came from.
///
/// This file is the store and the arithmetic. *Deciding* whether a new
/// sentence is a fact buddy already has is `learn.ts`'s job, because that needs
/// the embedder and this should not.
///
/// **Beliefs fade unless they are seen again.** A fact's stored `confidence`
/// is the belief as of the last time it was observed; the number anything acts
/// on is that belief decayed by how long ago that was. Decay is computed when
/// it is read, not by a job that rewrites rows on a timer — so a Mac that was
/// shut for a fortnight comes back with two-week-old beliefs at exactly the
/// strength two-week-old beliefs should have, and nothing had to be awake for
/// that to be true.
///
/// How fast depends on what the fact is about. A project is over in weeks; a
/// skill is not; a habit is somewhere between and should go quiet within a
/// couple of months of not being seen. Evidence slows it: something seen forty
/// times is not forgotten as fast as something seen once.

/** Days for an unreinforced, once-seen fact to lose half its weight. */
export const HALF_LIFE_DAYS: Record<FactKind, number> = {
  preference: 180,
  habit: 45,
  workflow: 120,
  skill: 365,
  project: 21,
  relationship: 180,
  goal: 60,
  context: 60,
};

/** Below this buddy stops bringing a fact up. It is still listed — fading is
 *  something the person can see and argue with — but it no longer shapes a
 *  goal or an answer. */
export const DORMANT_BELOW = 0.25;

/** The ceiling on a first sighting, by source. One hour of watching is a
 *  hypothesis, not a conviction; being corrected is close to being told. */
export const FIRST_SIGHTING_CAP: Record<FactSource, number> = {
  observed: 0.6,
  run: 0.7,
  corrected: 0.85,
  told: 1,
};

/** Each confirming sighting closes this fraction of the gap to certainty. */
const REINFORCE_RATE = 0.3;

const DAY_MS = 86_400_000;

interface RawFact {
  id: number;
  kind: FactKind;
  statement: string;
  confidence: number;
  evidence: number;
  source: FactSource;
  status: FactStatus;
  superseded_by: number | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  source_obs_json: string;
}

/** The belief now. Pinned facts are the person's word and do not fade;
 *  rejected and superseded ones are not beliefs at all. */
export function effectiveConfidence(
  f: { confidence: number; evidence: number; kind: FactKind; status: FactStatus; lastSeenAt: number },
  now = Date.now(),
): number {
  if (f.status === 'pinned') return 1;
  if (f.status !== 'active') return 0;
  const ageDays = Math.max(0, now - f.lastSeenAt) / DAY_MS;
  const halfLife = HALF_LIFE_DAYS[f.kind] * (1 + 0.5 * Math.log2(Math.max(1, f.evidence)));
  return f.confidence * Math.pow(0.5, ageDays / halfLife);
}

export function reinforced(confidence: number): number {
  return confidence + (1 - confidence) * REINFORCE_RATE;
}

const parseIds = (s: string): number[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
};

function toView(r: RawFact, now: number): FactView {
  const base = {
    confidence: r.confidence,
    evidence: r.evidence,
    kind: r.kind,
    status: r.status,
    lastSeenAt: r.last_seen_at,
  };
  const effective = effectiveConfidence(base, now);
  return {
    id: r.id,
    kind: r.kind,
    statement: r.statement,
    confidence: r.confidence,
    effective,
    dormant: (r.status === 'active' || r.status === 'pinned') && effective < DORMANT_BELOW,
    evidence: r.evidence,
    source: r.source,
    status: r.status,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
    sourceObs: parseIds(r.source_obs_json),
  };
}

export interface NewFact {
  kind: FactKind;
  statement: string;
  confidence: number;
  source: FactSource;
  status?: FactStatus;
  evidence?: number;
  seenAt?: number;
  sourceObs?: number[];
}

export const facts = {
  get(id: number, now = Date.now()): FactView | null {
    const r = getDb().prepare('SELECT * FROM facts WHERE id = ?').get(id) as RawFact | undefined;
    return r ? toView(r, now) : null;
  },

  byIds(ids: number[], now = Date.now()): FactView[] {
    if (!ids.length) return [];
    return (
      getDb()
        .prepare(`SELECT * FROM facts WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as RawFact[]
    ).map((r) => toView(r, now));
  },

  /** Everything, newest first, for the "You" screen. */
  all(now = Date.now()): FactView[] {
    return (getDb().prepare('SELECT * FROM facts ORDER BY last_seen_at DESC').all() as RawFact[]).map((r) =>
      toView(r, now),
    );
  },

  /** What buddy currently believes, strongest first, dormant ones left out. */
  believed(now = Date.now(), limit = 500): FactView[] {
    return (
      getDb()
        .prepare("SELECT * FROM facts WHERE status IN ('active','pinned') ORDER BY last_seen_at DESC")
        .all() as RawFact[]
    )
      .map((r) => toView(r, now))
      .filter((f) => !f.dormant)
      .sort((a, b) => b.effective - a.effective || b.evidence - a.evidence)
      .slice(0, limit);
  },

  rejected(): FactView[] {
    return (
      getDb().prepare("SELECT * FROM facts WHERE status = 'rejected' ORDER BY updated_at DESC").all() as RawFact[]
    ).map((r) => toView(r, Date.now()));
  },

  create(f: NewFact): FactView {
    if (!FACT_KINDS.includes(f.kind)) throw new Error(`not a fact kind: ${f.kind}`);
    const statement = f.statement.trim();
    if (!statement) throw new Error('a fact needs a statement');
    const now = Date.now();
    const seenAt = f.seenAt ?? now;
    const status = f.status ?? (f.source === 'told' ? 'pinned' : 'active');
    const confidence = Math.min(FIRST_SIGHTING_CAP[f.source], clamp01(f.confidence));
    const info = getDb()
      .prepare(
        `INSERT INTO facts (kind, statement, confidence, evidence, source, status, created_at, updated_at, last_seen_at, source_obs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.kind,
        statement,
        status === 'pinned' ? 1 : confidence,
        Math.max(1, f.evidence ?? 1),
        f.source,
        status,
        now,
        now,
        seenAt,
        JSON.stringify(f.sourceObs ?? []),
      );
    return this.get(Number(info.lastInsertRowid))!;
  },

  /** Seen again. Pinned facts are already certain and only get their
   *  sighting recorded; rejected ones are not touched — a rejection is not a
   *  belief that can be argued back into existence by repetition. */
  reinforce(id: number, seenAt = Date.now(), sourceObs: number[] = []): FactView | null {
    const f = this.get(id);
    if (!f || f.status === 'rejected' || f.status === 'superseded') return f;
    const obs = [...new Set([...f.sourceObs, ...sourceObs])].slice(-200);
    getDb()
      .prepare(
        `UPDATE facts SET confidence = ?, evidence = evidence + 1, last_seen_at = MAX(last_seen_at, ?),
                          source_obs_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(f.status === 'pinned' ? 1 : reinforced(f.confidence), seenAt, JSON.stringify(obs), Date.now(), id);
    return this.get(id);
  },

  /** Contradicted without a replacement: halve it, and retire it once it is
   *  barely a belief at all. */
  weaken(id: number): FactView | null {
    const f = this.get(id);
    if (!f || f.status !== 'active') return f;
    const next = f.confidence * 0.5;
    getDb()
      .prepare('UPDATE facts SET confidence = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(next, next < 0.15 ? 'superseded' : 'active', Date.now(), id);
    return this.get(id);
  },

  /** Replace a belief with a corrected one. The old row is kept, pointing at
   *  its replacement, so "why does buddy think this" has a history. */
  supersede(id: number, by: number): void {
    getDb()
      .prepare("UPDATE facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(by, Date.now(), id);
  },

  /** The person confirmed it. */
  pin(id: number): FactView | null {
    getDb()
      .prepare("UPDATE facts SET status = 'pinned', confidence = 1, superseded_by = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    log.info('memory', 'fact confirmed by the user', { id });
    return this.get(id);
  },

  /** The person said it is wrong. Kept, so it is never learned again. */
  reject(id: number): FactView | null {
    getDb().prepare("UPDATE facts SET status = 'rejected', updated_at = ? WHERE id = ?").run(Date.now(), id);
    log.info('memory', 'fact rejected by the user', { id });
    return this.get(id);
  },

  /** Undo a rejection: back to an ordinary belief at its old strength. */
  restore(id: number): FactView | null {
    getDb()
      .prepare("UPDATE facts SET status = 'active', last_seen_at = ?, updated_at = ? WHERE id = ? AND status = 'rejected'")
      .run(Date.now(), Date.now(), id);
    return this.get(id);
  },

  /** The person rewrote it. Their words are pinned: a model never gets to
   *  quietly re-edit a sentence the user wrote themselves. */
  edit(id: number, patch: { statement?: string; kind?: FactKind }): FactView | null {
    const f = this.get(id);
    if (!f) return null;
    if (patch.kind && !FACT_KINDS.includes(patch.kind)) throw new Error(`not a fact kind: ${patch.kind}`);
    const statement = patch.statement?.trim() || f.statement;
    getDb()
      .prepare(
        `UPDATE facts SET statement = ?, kind = ?, status = 'pinned', confidence = 1, source = 'told',
                          updated_at = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(statement, patch.kind ?? f.kind, Date.now(), Date.now(), id);
    return this.get(id);
  },

  /** Gone entirely — including from the list of things not to re-learn. */
  forget(id: number): void {
    getDb().prepare('DELETE FROM facts WHERE id = ?').run(id);
    log.info('memory', 'fact forgotten', { id });
  },

  stats(): { total: number; pinned: number; rejected: number; lastLearnedAt: number | null } {
    const r = getDb()
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE status IN ('active','pinned')) AS total,
                COUNT(*) FILTER (WHERE status = 'pinned') AS pinned,
                COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
                MAX(CASE WHEN source != 'told' THEN created_at END) AS last
           FROM facts`,
      )
      .get() as { total: number; pinned: number; rejected: number; last: number | null };
    return { total: r.total, pinned: r.pinned, rejected: r.rejected, lastLearnedAt: r.last };
  },
};

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}
