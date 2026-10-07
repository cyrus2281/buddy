import { log } from '../log.js';
import { containsCredential } from '../agent/guardrails.js';
import { memoryIndex } from './index.js';
import { vectors } from './vectors.js';
import { facts, effectiveConfidence } from './facts.js';
import { episodes, episodeText } from './episodes.js';
import type { Learning } from '../notes/schemas.js';
import {
  type EpisodeView,
  type FactKind,
  type FactSource,
  type FactView,
  type ObservationRow,
} from '../../shared/types.js';

/// How buddy learns: the rollup proposes, this file disposes.
///
/// Every hour the rollup (T3) already reads an hour of observations to write a
/// recap. Learning rides the same call — no second model, no second bill — by
/// showing it what buddy already believes about the person and asking what
/// this hour adds: a new fact, the same fact seen again, a fact that turned
/// out wrong. It is the same arrangement the relation merge has (README, M3):
/// **prompt-level reuse keeps the memory readable; the mechanical merge is
/// what makes it correct.** The model is told to reuse ids, and usually does;
/// whatever it returns still goes through `learnFact`, which finds the
/// existing belief by meaning *and* wording before it writes a new one.
///
/// The operations are deliberately few — add, reinforce, revise, retract —
/// because each one has to be something a person can see the effect of on the
/// "You" screen and undo.

export type { Learning };

/** What the model is shown so it can reuse rather than repeat. */
export interface LearningContext {
  known: FactView[];
  rejected: FactView[];
  runs: EpisodeView[];
}

export interface LearnSummary {
  added: number;
  reinforced: number;
  revised: number;
  retracted: number;
  /** Matched something the person rejected, or looked like a credential. */
  blocked: number;
  /** Referred to a fact it was not shown, touched a pinned fact, or was empty. */
  ignored: number;
}

/** The model is asked for at most five; this is the hard stop. A rollup that
 *  "learns" twenty things in an hour learned none of them carefully. */
const MAX_PER_ROLLUP = 6;

/** Cosine floor for "these might be the same belief". Necessary, not
 *  sufficient — see `sameBelief`. */
const SAME_MEANING = 0.85;
/** Content-word overlap that has to hold as well. High on purpose: in a
 *  five-word belief, one differing word is usually the whole point of it. */
const SAME_WORDS = 0.75;

const FILLER = new Set(
  'a an the and or of to in on at by for with from as is are was were be it its this that their they them the user person usually often always typically'.split(
    ' ',
  ),
);

/** A deliberately crude stemmer: enough that "replies in threads" and
 *  "replying in a thread" share their words, and no more. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ied')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !FILLER.has(w))
      .map(stem),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Whether two sentences are one belief. Exported for the checks.
 *
 * Meaning alone is not enough, and the reason is specific: a static embedding
 * is a mean of word vectors, and "prefers dark mode" and "prefers light mode"
 * average to nearly the same point. Merge on that and buddy would count
 * evidence for the opposite of what it saw — or, worse, block a correct new
 * belief because it resembles one the person rejected. So the words have to
 * agree too: the content words of one have to be mostly the content words of
 * the other. "Prefers dark mode in editors" and "Prefers dark mode" pass;
 * "dark" and "light" do not.
 */
export function sameBelief(a: string, b: string, similarity: number | null): boolean {
  const words = jaccard(contentWords(a), contentWords(b));
  if (similarity == null) return words >= 0.9;
  return similarity >= SAME_MEANING && words >= SAME_WORDS;
}

/** Facts that might be this sentence, most similar first. */
function neighbours(statement: string): { fact: FactView; similarity: number | null }[] {
  const v = memoryIndex.embed(statement);
  if (v) {
    const hits = vectors.knn(v, 8, ['fact']);
    const byId = new Map(facts.byIds(hits.map((h) => h.sourceId)).map((f) => [f.id, f]));
    return hits.flatMap((h) => (byId.has(h.sourceId) ? [{ fact: byId.get(h.sourceId)!, similarity: h.similarity }] : []));
  }
  // No embedder: exact wording is the only safe test.
  const key = [...contentWords(statement)].sort().join(' ');
  return facts
    .all()
    .filter((f) => [...contentWords(f.statement)].sort().join(' ') === key)
    .map((fact) => ({ fact, similarity: null }));
}

export type LearnOutcome =
  | { action: 'added' | 'reinforced'; fact: FactView }
  | { action: 'blocked'; reason: string; rejected?: FactView }
  | { action: 'ignored'; reason: string };

/**
 * Learn one sentence: find the belief it already is, or write a new one.
 *
 * In order: a credential never becomes a fact; something the person rejected
 * is never learned again; something already believed is reinforced; and only
 * then is a new row written — and embedded on the spot, so the next sentence
 * in the same rollup can find it.
 */
export function learnFact(c: {
  kind: FactKind;
  statement: string;
  confidence: number;
  source: FactSource;
  seenAt?: number;
  sourceObs?: number[];
}): LearnOutcome {
  const statement = c.statement.trim().replace(/\s+/g, ' ');
  if (statement.length < 8) return { action: 'ignored', reason: 'too short to be a fact' };
  const secret = containsCredential(statement);
  if (secret) {
    log.warn('memory', 'refused to learn a sentence containing a credential', { what: secret });
    return { action: 'blocked', reason: `it contains ${secret}` };
  }

  for (const { fact, similarity } of neighbours(statement)) {
    if (!sameBelief(statement, fact.statement, similarity)) continue;
    if (fact.status === 'rejected') {
      log.info('memory', 'did not re-learn a fact the user rejected', { rejected: fact.id });
      return { action: 'blocked', reason: `the person rejected F${fact.id}`, rejected: fact };
    }
    if (fact.status === 'superseded') continue;
    const f = facts.reinforce(fact.id, c.seenAt, c.sourceObs);
    memoryIndex.embedFact(fact.id);
    return { action: 'reinforced', fact: f! };
  }

  const fact = facts.create({
    kind: c.kind,
    statement,
    confidence: c.confidence,
    source: c.source,
    seenAt: c.seenAt,
    sourceObs: c.sourceObs,
  });
  memoryIndex.embedFact(fact.id);
  log.info('memory', 'learned', { id: fact.id, kind: fact.kind, source: fact.source });
  return { action: 'added', fact };
}

const SOURCE: Record<Learning['source'], FactSource> = { observed: 'observed', run: 'run', correction: 'corrected' };

/**
 * Apply a rollup's learnings.
 *
 * A `fact_id` is honoured only if the fact was in what the model was shown.
 * An id it was not shown is an id it made up, and a made-up id that happens
 * to exist would let a hallucination edit an unrelated belief — so it is
 * treated as an `add`, and the merge finds the real one if there is one.
 * Pinned facts are the person's word: a model can reinforce them, never
 * revise or retract them.
 */
export function applyLearnings(
  learnings: Learning[],
  ctx: LearningContext,
  obsIds: number[],
  seenAt = Date.now(),
): LearnSummary {
  const sum: LearnSummary = { added: 0, reinforced: 0, revised: 0, retracted: 0, blocked: 0, ignored: 0 };
  const shown = new Map(ctx.known.map((f) => [f.id, f]));

  for (const l of learnings.slice(0, MAX_PER_ROLLUP)) {
    const target = l.fact_id != null ? shown.get(l.fact_id) : undefined;
    const source = SOURCE[l.source] ?? 'observed';

    if (l.op !== 'add' && !target) {
      if (l.op === 'reinforce' || l.op === 'revise') {
        const r = learnFact({ ...l, source, seenAt, sourceObs: obsIds });
        count(sum, r);
      } else sum.ignored++;
      continue;
    }

    if (l.op === 'add' || l.op === 'reinforce') {
      if (l.op === 'reinforce' && target) {
        facts.reinforce(target.id, seenAt, obsIds);
        memoryIndex.embedFact(target.id);
        sum.reinforced++;
        continue;
      }
      count(sum, learnFact({ ...l, source, seenAt, sourceObs: obsIds }));
      continue;
    }

    if (target!.status === 'pinned') {
      log.info('memory', 'left a confirmed fact alone', { id: target!.id, op: l.op });
      sum.ignored++;
      continue;
    }

    if (l.op === 'retract') {
      facts.weaken(target!.id);
      memoryIndex.embedFact(target!.id);
      sum.retracted++;
      continue;
    }

    // revise: the corrected belief inherits the old one's evidence — it is the
    // same subject, now right — and the old row points at it.
    const secret = containsCredential(l.statement);
    if (secret || l.statement.trim().length < 8) {
      sum.blocked++;
      continue;
    }
    const next = facts.create({
      kind: l.kind,
      statement: l.statement,
      confidence: Math.max(l.confidence, Math.min(0.6, target!.confidence)),
      source,
      evidence: target!.evidence,
      seenAt,
      sourceObs: obsIds,
    });
    facts.supersede(target!.id, next.id);
    memoryIndex.embedFact(next.id);
    memoryIndex.embedFact(target!.id);
    sum.revised++;
  }

  episodes.markLearned(ctx.runs.map((r) => r.id));
  return sum;
}

function count(sum: LearnSummary, r: LearnOutcome) {
  if (r.action === 'added') sum.added++;
  else if (r.action === 'reinforced') sum.reinforced++;
  else if (r.action === 'blocked') sum.blocked++;
  else sum.ignored++;
}

/**
 * What the rollup is shown: the beliefs this hour might touch, the ones the
 * person rejected that it might be about to repeat, and the runs since the
 * last time.
 *
 * Relevant beliefs are found by meaning against the hour's observations, plus
 * the strongest ones regardless, so the model sees both "what we know about
 * this" and "who this person is". Dormant facts are included on purpose: a
 * habit that faded and is back is exactly what reinforcement is for.
 */
export function learningContext(obs: ObservationRow[], now = Date.now()): LearningContext {
  const periodText = obs
    .map((o) => o.summary)
    .join(' ')
    .slice(0, 6_000);
  const known = new Map<number, FactView>();
  const rejected = new Map<number, FactView>();

  const v = periodText ? memoryIndex.embed(periodText) : null;
  if (v) {
    const hits = vectors.knn(v, 40, ['fact']);
    for (const f of facts.byIds(hits.map((h) => h.sourceId), now)) {
      if (f.status === 'rejected') rejected.set(f.id, f);
      else if (f.status !== 'superseded') known.set(f.id, f);
    }
  }
  for (const f of facts.believed(now, 12)) known.set(f.id, f);
  if (!v) for (const f of facts.rejected().slice(0, 8)) rejected.set(f.id, f);

  return {
    known: [...known.values()].slice(0, 30),
    rejected: [...rejected.values()].slice(0, 8),
    runs: episodes.unlearned(10),
  };
}

const pct = (n: number) => n.toFixed(2);

export function renderLearningContext(ctx: LearningContext, now = Date.now()): string {
  const known = ctx.known.length
    ? ctx.known
        .map((f) => {
          const tags = [
            f.kind,
            pct(effectiveConfidence(f, now)),
            `seen ${f.evidence}×`,
            ...(f.status === 'pinned' ? ['confirmed by the person'] : []),
            ...(f.dormant ? ['fading'] : []),
          ];
          return `F${f.id} [${tags.join(' · ')}] ${f.statement}`;
        })
        .join('\n')
    : '(nothing yet — this person is new to buddy)';
  const rejected = ctx.rejected.length
    ? ctx.rejected.map((f) => `F${f.id} ${f.statement}`).join('\n')
    : '(none)';
  const runs = ctx.runs.length
    ? ctx.runs.map((e) => `[run ${e.runId} · ${e.goalSource}] ${episodeText(e)}`).join('\n')
    : '(no runs since the last summary)';
  return [
    '<what_buddy_has_learned>',
    known,
    '</what_buddy_has_learned>',
    '',
    '<rejected_by_the_person>',
    rejected,
    '</rejected_by_the_person>',
    '',
    '<runs_since_last_summary>',
    runs,
    '</runs_since_last_summary>',
  ].join('\n');
}

/** The rollup block when learning is switched off. The field is still in the
 *  schema — one schema, whatever the setting — so the model is told to leave
 *  it empty, and whatever it returns is ignored anyway. */
export const LEARNING_OFF =
  '<learning>off — the person has turned learning off. Return an empty `learnings` list.</learning>';
