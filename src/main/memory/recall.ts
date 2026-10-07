import { notes, observations } from '../store/notes.js';
import { memoryIndex } from './index.js';
import { vectors } from './vectors.js';
import { dot } from './embed.js';
import { facts } from './facts.js';
import { episodes, episodeText } from './episodes.js';
import type { AnyNote, MemoryHit, MemorySource, NoteType } from '../../shared/types.js';

/// Hybrid recall: one query, every kind of memory, ranked.
///
/// **Two searches, because each fails where the other works.** Keywords find
/// "SAM-4412" and "Priya" exactly and find nothing for "when do I usually eat"
/// — no memory says "eat". Meaning finds "takes lunch around 12:30" for that
/// question and is fuzzy about ticket numbers. So recall runs both.
///
/// **Fusion is a weighted sum of scores, not of ranks — and that was
/// measured, not assumed.** The first version used reciprocal-rank fusion,
/// the textbook default, and on the retrieval set in `evals/memory-retrieval`
/// it was *worse than meaning alone*: top-3 73% against 96%. RRF's damping
/// makes rank 1 and rank 5 nearly equal, so being found by both searches at
/// all outweighs being found *well* by one — and in a memory, nearly
/// everything shares a word with nearly everything. A convex combination,
/// 0.8 × cosine + 0.2 × BM25 normalised to the query's best keyword match,
/// lets an exact keyword hit lift a result without letting a stray common
/// word drown out the right answer: top-1 85%, top-3 96%, MRR 0.90 — better
/// than either half alone. `npm run check:memory` re-measures it, so a change
/// here that makes recall worse fails a check instead of shipping.
///
/// Then two adjustments a plain search engine would not make, because this is
/// a memory of a person and not an index of documents:
///
///   - **Age and belief.** A recap from this morning outranks one from March,
///     and a fact buddy is sure of outranks one it is fading on. Neither is
///     a filter: an old memory that is the only match still comes back.
///   - **Diversity.** Five observations of the same ten minutes are one
///     memory, not five results. Maximal-marginal-relevance re-ranking spends
///     the slots on different things.

/** The weight on meaning; keywords get the rest. Swept 0.6–0.9 on the
 *  retrieval set: 0.8 is the best top-1 and MRR without losing top-3. */
const ALPHA = 0.8;
const CANDIDATES = 60;
/** How much a pick is worth against how much it repeats what is already
 *  picked. A memory is full of near-copies — six observations of one
 *  document — in a way a document index is not, so this is a little lower
 *  than the textbook 0.8; at 0.7 the retrieval set loses nothing to it. */
const MMR_LAMBDA = 0.7;

/** Days for a memory's recency weight to halve. Relations do not age: who
 *  someone is does not get less true because they were last seen in March. */
const HALF_LIFE: Record<string, number | null> = {
  recap: 14,
  task: 30,
  relation: null,
  observation: 7,
  episode: 45,
};

const STOPWORDS = new Set(
  (
    'a an the and or but if of to in on at by for with from as is are was were be been being do does did ' +
    'doing have has had i me my mine we our you your he she it its they them their this that these those ' +
    'what which who whom whose when where why how can could should would will shall may might must about ' +
    'into over under again then than so too very just also any some all each there here up down out off ' +
    'tell remind show give get got usually ever'
  ).split(' '),
);

/** Natural-language query → an FTS5 OR-query over quoted prefix terms.
 *
 *  OR rather than the Notes search's AND: "what did Priya ask about the
 *  migration" should find a note that mentions Priya and not the migration.
 *  BM25 ranks the ones with more terms first. Quoting every term makes every
 *  FTS5 operator character literal, for the same reason `notes.search` does. */
export function ftsQuery(text: string): string | null {
  const terms = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

export interface RecallOptions {
  sources?: MemorySource[];
  /** Restrict notes to these types. */
  noteTypes?: NoteType[];
  limit?: number;
  now?: number;
  /** Drop hits found *only* by meaning whose similarity is below this. A
   *  keyword hit is evidence on its own; a weak semantic one is not. */
  minSimilarity?: number;
  /** Rejected, superseded and dormant facts are not beliefs and are left out
   *  unless asked for — the "You" screen's search asks. */
  includeInactiveFacts?: boolean;
}

interface Candidate {
  key: string;
  source: MemorySource;
  id: number;
  /** Cosine to the query, from the vector search or computed afterwards for
   *  an item only the keyword search found. Null when it has no vector. */
  similarity: number | null;
  /** In the vector search's top candidates. */
  semantic: boolean;
  /** BM25, normalised so the query's best keyword match is 1. 0 if none. */
  lexical: number;
}

const ref = (source: MemorySource, id: number) => `${source[0]}${id}`;

export function recall(query: string, opts: RecallOptions = {}): MemoryHit[] {
  const q = query.trim();
  if (!q) return [];
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 12;
  const sources = opts.sources ?? ['note', 'observation', 'fact', 'episode'];
  const cands = new Map<string, Candidate>();
  const get = (source: MemorySource, id: number) => {
    const key = ref(source, id);
    let c = cands.get(key);
    if (!c) {
      c = { key, source, id, similarity: null, semantic: false, lexical: 0 };
      cands.set(key, c);
    }
    return c;
  };

  // Whatever was written since the last background sync is embedded first, so
  // a note edited a second ago is found by what it now says. Bounded, so a
  // first-launch backfill cannot stall a search.
  memoryIndex.sync({ maxItems: 200 });

  // ── Meaning ──
  const qv = memoryIndex.embed(q);
  if (qv) {
    for (const h of vectors.knn(qv, CANDIDATES, sources)) {
      const c = get(h.source, h.sourceId);
      c.similarity = h.similarity;
      c.semantic = true;
    }
  }

  // ── Words ──
  // Over the same rows and the same text the vectors were made from, in one
  // FTS5 table, so every BM25 score comes from one corpus's statistics.
  // bm25() is negative, lower is better; dividing by the best score makes the
  // strongest keyword match 1 and measures the rest against it.
  const match = ftsQuery(q);
  if (match) {
    const words = vectors.words(match, CANDIDATES, sources);
    const best = Math.min(0, ...words.map((w) => w.bm25));
    for (const w of words) get(w.source, w.sourceId).lexical = best < 0 ? w.bm25 / best : 0;
  }

  // An item only the keywords found still has a meaning, and its true cosine
  // is cheap to compute — a few hundred multiply-adds — so every candidate is
  // scored on both halves rather than on whichever search happened to see it.
  if (qv) {
    for (const c of cands.values()) {
      if (c.similarity != null) continue;
      const v = vectors.get(c.source, c.id);
      if (v) c.similarity = dot(qv, v);
    }
  }

  if (!cands.size) return [];
  const hits = resolve([...cands.values()], opts, now);
  return diversify(hits, limit);
}

/** Load what each candidate is, drop what the options exclude, and weight it. */
function resolve(cands: Candidate[], opts: RecallOptions, now: number): (MemoryHit & { vec: Float32Array | null })[] {
  const ids = (s: MemorySource) => cands.filter((c) => c.source === s).map((c) => c.id);
  const out: (MemoryHit & { vec: Float32Array | null })[] = [];
  const byKey = new Map(cands.map((c) => [c.key, c]));
  const age = (ts: number, halfLife: number | null) =>
    halfLife == null ? 1 : 0.5 + 0.5 * Math.pow(0.5, Math.max(0, now - ts) / 86_400_000 / halfLife);

  const push = (
    source: MemorySource,
    id: number,
    kind: string,
    title: string,
    text: string,
    ts: number,
    weight: number,
  ) => {
    const c = byKey.get(ref(source, id))!;
    const sim = c.similarity ?? 0;
    if (!c.lexical && opts.minSimilarity != null && sim < opts.minSimilarity) return;
    out.push({
      ref: c.key,
      source,
      id,
      kind,
      title,
      text,
      ts,
      score: (ALPHA * Math.max(0, sim) + (1 - ALPHA) * c.lexical) * weight,
      similarity: c.similarity,
      matched: c.lexical && c.semantic ? 'both' : c.lexical ? 'words' : 'meaning',
      vec: vectors.get(source, id),
    });
  };

  for (const id of ids('note')) {
    const n = notes.get(id);
    if (!n) continue;
    if (opts.noteTypes && !opts.noteTypes.includes(n.type)) continue;
    push('note', id, n.type, n.title, n.body, n.updatedAt, age(n.updatedAt, HALF_LIFE[n.type] ?? 30));
  }
  for (const o of observations.byIds(ids('observation'))) {
    push('observation', o.id, 'observation', o.apps.join(', ') || 'Observation', o.summary, o.tsEnd, age(o.tsEnd, HALF_LIFE.observation!));
  }
  for (const f of facts.byIds(ids('fact'), now)) {
    const believed = (f.status === 'active' || f.status === 'pinned') && !f.dormant;
    if (!believed && !opts.includeInactiveFacts) continue;
    // Gentle: a hypothesis at 0.6 still ranks at 0.88 of a certainty. Belief
    // is a tie-breaker in recall, not a filter — the filter is `dormant`.
    push('fact', f.id, f.kind, f.statement, f.statement, f.lastSeenAt, 0.7 + 0.3 * f.effective);
  }
  for (const e of episodes.byIds(ids('episode'))) {
    push('episode', e.id, e.kind, e.goal, episodeText(e), e.ts, age(e.ts, HALF_LIFE.episode!));
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Maximal marginal relevance: each next pick trades its own score against how
 *  much it repeats what is already picked. */
function diversify(hits: (MemoryHit & { vec: Float32Array | null })[], limit: number): MemoryHit[] {
  if (!hits.length) return [];
  const pool = hits.slice(0, limit * 3);
  const top = pool[0]!.score || 1;
  const picked: typeof pool = [];
  while (picked.length < limit && pool.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const h = pool[i]!;
      let redundancy = 0;
      if (h.vec) for (const p of picked) if (p.vec) redundancy = Math.max(redundancy, dot(h.vec, p.vec));
      const s = MMR_LAMBDA * (h.score / top) - (1 - MMR_LAMBDA) * redundancy;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    picked.push(pool.splice(best, 1)[0]!);
  }
  return picked.map(({ vec: _vec, ...h }) => h);
}

/** The Notes screen's search, widened: keyword hits first (they carry the
 *  highlighted snippet), then notes that match by meaning and not by word. */
export function semanticNotes(query: string, type: NoteType | undefined, exclude: Set<number>, limit = 8): AnyNote[] {
  return recall(query, {
    sources: ['note'],
    ...(type ? { noteTypes: [type] } : {}),
    limit: limit + exclude.size,
    minSimilarity: 0.3,
  })
    .filter((h) => h.matched === 'meaning' && !exclude.has(h.id))
    .slice(0, limit)
    .map((h) => notes.get(h.id))
    .filter((n): n is AnyNote => !!n);
}
