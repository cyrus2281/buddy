/**
 * M5 checks — buddy learns you — run against the real modules.
 *
 *   npm run check:memory
 *
 * Same shape as the milestone checks: inside Electron, against a throwaway
 * userData directory, so it never touches a real memory.
 *
 * **What is real here, and what is not.** Unlike M3 and M4, the expensive-
 * looking half of this milestone is *not* replaced: the embedding model is the
 * bundled potion-base-8M, the vector index is the bundled sqlite-vec, and the
 * retrieval-quality check measures them on a real retrieval set. Both are
 * local, deterministic and free, so there is nothing to stub. The one thing
 * replaced is, again, the language **model** — by a scripted structured-output
 * client — because every invariant about learning is about what buddy does
 * with a rollup's reply, not about the reply.
 *
 * What it cannot tell you is whether a live Sonnet learns *good* facts from a
 * real afternoon. That needs a person to use buddy and read the You tab.
 */
import { app } from 'electron';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, getDb, closeDb } from './store/db.js';
import { SCHEMA, SCHEMA_VERSION } from './store/schema.js';
import { settings } from './settings.js';
import { notes, observations, tasks } from './store/notes.js';
import { runs } from './store/runs.js';
import { embedder, setEmbedderForTesting, dot, type Embedder, type StaticEmbedder } from './memory/embed.js';
import { vectors } from './memory/vectors.js';
import { memoryIndex } from './memory/index.js';
import { facts, effectiveConfidence, DORMANT_BELOW, HALF_LIFE_DAYS } from './memory/facts.js';
import { episodes, classifyGoal, type ActivationSnapshot } from './memory/episodes.js';
import { applyLearnings, learnFact, sameBelief } from './memory/learn.js';
import { recall, semanticNotes } from './memory/recall.js';
import { RhythmRecorder, rhythm, rhythmLine } from './memory/rhythm.js';
import { operatorMemory } from './memory/context.js';
import { memory } from './memory/service.js';
import { isTeaching, parseTeaching } from '../shared/teach.js';
import { NotesEngine } from './notes/engine.js';
import type { RollupResult } from './notes/rollup.js';
import { RollupSchema, type RollupOutput } from './notes/schemas.js';
import { askAboutMyDay, AnswerSchema } from './notes/ask.js';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { zodToStrictJsonSchema } from './providers.js';
import { costOfCall, QA_MODEL, type StructuredClient, type StructuredRequest, type StructuredResult } from './notes/model.js';
import { buildBundle } from './agent/inference.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { renderBundle, type ContextBundle } from '../../prompts/context-bundle.js';
import type { CaptureScheduler, T0Signal } from './capture/scheduler.js';
import { DEFAULT_SETTINGS, type RunView, type Settings } from '../shared/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-memory-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };
const results: Result[] = [];

function check(name: string, fn: () => string | Promise<string>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, state: 'pass', detail });
    })
    .catch((e: Error) => {
      results.push({ name, state: 'fail', detail: e.message });
    });
}
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
}

const DAY = 86_400_000;

// ── Test doubles ─────────────────────────────────────────────────────────────

class ScriptedModel implements StructuredClient {
  calls: StructuredRequest<unknown>[] = [];
  constructor(private script: (n: number, req: StructuredRequest<unknown>) => unknown) {}
  async parse<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const raw = this.script(this.calls.length - 1, req as StructuredRequest<unknown>);
    // Through the real schema, as M3 does: a reply the schema would reject
    // proves nothing about the shipping path.
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new Error(`scripted reply does not satisfy the schema: ${parsed.error.message}`);
    const usage = { input_tokens: 2_000, output_tokens: 400 };
    return { value: parsed.data as T, usage, costUsd: costOfCall(req.model, usage), ms: 5 };
  }
}

class FakeScheduler {
  private handlers = new Map<string, Set<(p: unknown) => void>>();
  on(ev: string, fn: (p: never) => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn as (p: unknown) => void);
    return this;
  }
  off(ev: string, fn: (p: never) => void) {
    this.handlers.get(ev)?.delete(fn as (p: unknown) => void);
    return this;
  }
  recentSignals() {
    return [];
  }
}

const ROLLUP_STUB = (over: Partial<RollupOutput> = {}): RollupOutput => ({
  recap: { title: 'Filed a Jira bug', body: 'Filed SAM-4500 with repro steps.', salience: 0.4 },
  relations: [],
  tasks: [],
  learnings: [],
  injection_notice: null,
  ...over,
});

const baseSettings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

const signal = (over: Partial<T0Signal> = {}): T0Signal => ({
  ts: Date.now(),
  bundleId: 'com.tinyspeck.slackmacgap',
  appName: 'Slack',
  windowTitle: 'Slack — #sam-eng',
  idleSeconds: 0,
  secureInput: false,
  contextSwitch: false,
  ...over,
});

/** A RunView as the orchestrator would emit it at the end of a run. */
function viewOf(runId: number, goal: string, status: RunView['status'], summary = '', apps: string[] = []): RunView {
  return {
    id: runId,
    goal,
    profile: 'attended',
    status,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    budgets: { maxSteps: 60, maxWallClockMs: 600_000, maxCostUsd: 2 },
    usage: { steps: 5, elapsedMs: 60_000, costUsd: 0.1, exceeded: null },
    allowlist: { apps: [], domains: [] },
    steps: apps.map((a, i) => ({
      runId,
      idx: i,
      tool: 'computer',
      input: {},
      result: 'ok',
      framePath: null,
      isError: false,
      ts: Date.now(),
      verdict: {
        decision: 'allow',
        class: 'read',
        reason: '',
        signal: 'action-kind',
        target: '',
        appKey: a,
        appName: a,
      },
      scale: 1,
    })),
    outcome: status === 'done' || status === 'waiting' ? { status, summary } : null,
    haltReason: status === 'needs_human' ? summary : null,
    gate: null,
    cacheReadTokens: 0,
    humanInputs: 0,
    sessionGrants: [],
    resumes: 0,
  };
}

function finishedRun(goal: string, status: 'done' | 'needs_human' = 'done', summary = 'Finished.'): number {
  const id = runs.create(goal, 'attended');
  runs.finish(id, status, 7, 0.12, { status, summary });
  return id;
}

const offer = (goal: string, alternatives: string[] = []): ActivationSnapshot => ({
  goal,
  source: 'model',
  alternatives,
  confidence: 0.8,
});

/** Everything M5 writes, and the notes it reads, between scenarios. */
function wipe() {
  const db = getDb();
  db.exec(`
    DELETE FROM facts; DELETE FROM episodes; DELETE FROM app_usage;
    DELETE FROM note_links; DELETE FROM relations; DELETE FROM tasks; DELETE FROM notes;
    DELETE FROM observations; DELETE FROM runs;
  `);
  vectors.clear();
}

const obsRow = (summary: string, ts = Date.now(), apps = ['Notion']) =>
  observations.insert({ tsStart: ts - 120_000, tsEnd: ts, summary, apps, entities: [], confidence: 0.8, frameIds: [] });

/** Reference token ids and vector heads from the Model2Vec Python library
 *  (model2vec 0.9, tokenizers 0.23) for the pinned revision. A tokenizer port
 *  that drifts by one token produces a different vector and no error, so it is
 *  pinned against the reference rather than against itself. */
const REFERENCE = [
  {
    text: 'Héllo, WORLD! naïve café — SAM-4412 @priya priya.raman@solace.com 東京 don\'t',
    ids: [6598, 16, 1094, 5, 14749, 6674, 523, 2526, 17, 27021, 1481, 36, 25933, 2154, 25933, 2154, 18, 13121, 1084, 36, 13023, 9738, 18, 3018, 885, 761, 1129, 11, 62],
    head: [0.086432, -0.075149, -0.235627, 0.150508, 0.059673, 0.174516],
  },
  {
    text: 'Fill the empty \'Blockers\' heading in the Notion page "Q3 Migration"',
    ids: [5045, 1002, 3070, 11, 2802, 1551, 11, 4831, 1005, 1002, 8372, 2937, 6, 59, 1515, 8236, 6],
    head: [0.021311, 0.176463, -0.003117, -0.134779, 0.057677, -0.094252],
  },
  {
    text: 'unaffable xyzzyplugh supercalifragilisticexpialidocious',
    ids: [13483, 19967, 2474, 66, 1106, 27759, 23765, 7959, 2571, 8295, 9134, 28187, 23417, 3594, 9294, 18318, 20279, 9091, 5319],
    head: [-0.098135, -0.248962, -0.273944, -0.211098, 0.03147, 0.024503],
  },
  {
    text: `${'x'.repeat(120)} tail`,
    ids: [4731],
    head: [0.002418, -0.171043, 0.075173, -0.158649, -0.011336, -0.079257],
  },
  {
    text: 'Tabs\tand\nnewlines\r\nand $5 + <tags> = ^caret~ | pipe` 🙂 emoji',
    ids: [20634, 1021, 1004, 1053, 11741, 1004, 8, 25, 15, 32, 21079, 34, 33, 40, 1735, 1108, 72, 70, 7673, 42, 6867, 28153, 1078],
    head: [-0.065909, -0.106064, -0.335931, -0.192288, 0.118992, 0.079357],
  },
];

// ── The checks ───────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());

  // ══ Migration — before anything opens the database the normal way ════════

  await check('a v1 database migrates to v2 with its observations searchable', () => {
    // The v1 schema is exactly today's schema up to the M5 marker: everything
    // below it is new, and everything above it is unchanged.
    const v1 = SCHEMA.split('-- ── M5')[0]!;
    const raw = new Database(paths.db());
    raw.exec(v1);
    raw.pragma('user_version = 1');
    raw.prepare(
      `INSERT INTO observations (ts_start, ts_end, summary, apps_json, entities_json, confidence, frame_ids_json)
       VALUES (1, 2, 'Filed SAM-4412 from the thread in #sam-eng', '[]', '[]', 0.8, '[]')`,
    ).run();
    raw.close();

    openDb();
    const db = getDb();
    eq(db.pragma('user_version', { simple: true }), SCHEMA_VERSION, 'user_version after opening');
    eq((db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 1, 'the v1 row survived');
    for (const t of ['facts', 'episodes', 'app_usage', 'memory_vectors', 'memory_fts']) {
      ok(!!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), `${t} exists`);
    }
    // The first launch indexes what was there before the index existed.
    settings.load();
    memoryIndex.open();
    memoryIndex.sync({ full: true });
    const hit = recall('SAM-4412', { limit: 1 })[0];
    eq(hit?.source, 'observation', 'an observation written under v1 is found');
    eq(hit?.matched, 'both', 'by its words and by its meaning');
    return `v1 → v${SCHEMA_VERSION}: tables added; the first launch indexes the existing memory`;
  });

  // The migration check opens everything; if it failed, open it anyway so the
  // rest of the suite reports on its own subjects rather than crashing.
  if (!memoryIndex.isOpen()) {
    try {
      getDb();
    } catch {
      openDb();
    }
    settings.load();
    memoryIndex.open();
  }

  // ══ The embedder ══════════════════════════════════════════════════════════

  await check('the tokenizer reproduces the reference WordPiece ids exactly', () => {
    const e = embedder() as StaticEmbedder | null;
    ok(!!e, 'the bundled model loads — run `npm run fetch:model` if it is missing');
    let tokens = 0;
    for (const r of REFERENCE) {
      const ids = e!.tokenize(r.text);
      eq(JSON.stringify(ids), JSON.stringify(r.ids), `token ids for ${JSON.stringify(r.text.slice(0, 30))}`);
      const v = e!.embed(r.text)!;
      r.head.forEach((x, i) => ok(Math.abs(v[i]! - x) < 1e-5, `vector[${i}] ${v[i]} vs reference ${x}`));
      tokens += ids.length;
    }
    return `${REFERENCE.length} strings, ${tokens} tokens: accents, CJK, emoji, punctuation-as-words, an over-long word — identical to Model2Vec`;
  });

  await check('embeddings are unit length, deterministic, and null for nothing', () => {
    const e = embedder()!;
    const a = e.embed('Reviews pull requests every morning')!;
    const b = e.embed('Reviews pull requests every morning')!;
    eq(a.length, 256, 'dimension');
    ok(Math.abs(Math.sqrt(dot(a, a)) - 1) < 1e-5, 'unit length');
    ok(a.every((x, i) => x === b[i]), 'the same text gives the same vector');
    eq(e.embed(''), null, 'empty text has no vector');
    eq(e.embed('  \n\t '), null, 'whitespace has none either');
    eq(e.embed('🙂🙂'), null, 'nor does text made only of unknown tokens');
    return `${e.id}, ${e.dim}-d`;
  });

  await check('it embeds in microseconds on the main process', () => {
    const e = embedder()!;
    const texts = Array.from({ length: 2_000 }, (_, i) => `Worked on ticket SAM-${4000 + i} in the Q${(i % 4) + 1} migration page with Priya`);
    const t0 = performance.now();
    for (const t of texts) e.embed(t);
    const per = ((performance.now() - t0) * 1000) / texts.length;
    ok(per < 500, `${per.toFixed(0)} µs per sentence is too slow for the main process`);
    return `${per.toFixed(0)} µs per sentence — no worker thread needed`;
  });

  // ══ The vector store ══════════════════════════════════════════════════════

  await check('sqlite-vec loads into buddy’s own database', () => {
    ok(vectors.isAccelerated(), `sqlite-vec did not load: ${vectors.extensionProblem()}`);
    const v = (getDb().prepare('SELECT vec_version() AS v').get() as { v: string }).v;
    const decl = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vec'").get() as { sql: string }).sql;
    ok(decl.includes('float[256]') && decl.includes('cosine'), 'the vec0 table matches the model');
    return `sqlite-vec ${v}, vec0 float[256] cosine, in the same file as the notes`;
  });

  await check('vec0 and the fallback scan agree on the nearest neighbours', () => {
    wipe();
    const subjects = ['Priya', 'Arjun', 'the connectors team', 'Acme', 'the design team', 'the Q3 migration', 'SAM-4412', 'the release'];
    const verbs = ['reviews', 'asks about', 'waits on', 'plans', 'writes up', 'demos', 'files bugs for', 'ships'];
    const objects = ['every Monday', 'in Slack threads', 'in Notion', 'before standup', 'after lunch', 'in Linear', 'by email', 'on Fridays'];
    let n = 0;
    for (const s of subjects) for (const v of verbs) for (const o of objects.slice(0, 6)) {
      facts.create({ kind: 'context', statement: `${s} ${v} ${o}`, confidence: 0.6, source: 'observed' });
      n++;
    }
    memoryIndex.sync();
    const queries = ['who reviews things on Monday', 'Slack', 'migration planning', 'demo for Acme', 'release on Friday', 'Linear bugs'];
    let compared = 0;
    for (const q of queries) {
      const qv = memoryIndex.embed(q)!;
      const fast = vectors.knn(qv, 10, ['fact']);
      const scan = vectors.knnScan(qv, 10, ['fact']);
      eq(fast.length, scan.length, `result count for "${q}"`);
      fast.forEach((h, i) => {
        ok(Math.abs(h.similarity - scan[i]!.similarity) < 1e-4, `similarity at rank ${i} for "${q}"`);
        compared++;
      });
      const overlap = fast.filter((h) => scan.some((s) => s.sourceId === h.sourceId)).length;
      ok(overlap >= 9, `"${q}": vec0 and the scan share only ${overlap}/10`);
    }
    return `${n} vectors, ${queries.length} queries, ${compared} ranks identical to 1e-4`;
  });

  await check('without the extension, search by meaning degrades to a scan — not to nothing', () => {
    const before = recall('who reviews things on Monday', { sources: ['fact'], limit: 5 }).map((h) => h.id);
    memoryIndex.close();
    memoryIndex.open({ accelerate: false });
    ok(!vectors.isAccelerated(), 'running without vec0');
    const after = recall('who reviews things on Monday', { sources: ['fact'], limit: 5 }).map((h) => h.id);
    eq(JSON.stringify(after), JSON.stringify(before), 'the same results, in the same order');
    // A fact written while unaccelerated is only in the rows…
    facts.create({ kind: 'context', statement: 'Arjun demos the release to Acme on Fridays', confidence: 0.6, source: 'observed' });
    memoryIndex.sync();
    memoryIndex.close();
    // …and the accelerator notices on the next open and rebuilds from them.
    memoryIndex.open();
    const plain = (getDb().prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE length(vector) > 0').get() as { n: number }).n;
    const fast = (getDb().prepare('SELECT COUNT(*) AS n FROM memory_vec').get() as { n: number }).n;
    eq(fast, plain, 'vec0 rebuilt to match the rows');
    return `identical top-5 either way; vec0 caught up with ${plain} rows on reopen`;
  });

  // ══ The index ═════════════════════════════════════════════════════════════

  await check('every kind of memory gets one vector, and a second sync does nothing', () => {
    wipe();
    notes.create({ type: 'recap', title: 'Q3 migration', body: 'Filled the Overview and stopped at Blockers.' });
    tasks.upsert({ title: 'Fill the Blockers section', body: 'Waiting on Priya.' });
    obsRow('Edited the Q3 Migration page in Notion');
    facts.create({ kind: 'habit', statement: 'Reviews pull requests before standup', confidence: 0.6, source: 'observed' });
    const runId = finishedRun('Reply to Priya in the thread');
    episodes.recordRun(viewOf(runId, 'Reply to Priya in the thread', 'done', 'Replied.'), null);

    const first = memoryIndex.sync();
    const { bySource } = vectors.counts();
    eq(first.embedded, 5, 'five items embedded');
    eq(bySource.note, 2, 'two notes');
    eq(bySource.observation, 1, 'one observation');
    eq(bySource.fact, 1, 'one fact');
    eq(bySource.episode, 1, 'one episode');
    eq(memoryIndex.sync().embedded, 0, 'a second sync finds nothing owed');
    eq(memoryIndex.status().pending, 0, 'status agrees');
    return 'notes, observations, facts and runs share one index; what is owed is computed from the rows';
  });

  await check('an edited note is re-embedded; a deleted one leaves no vector', () => {
    wipe();
    const id = notes.create({ type: 'recap', title: 'Morning', body: 'Wrote the release notes.' });
    memoryIndex.sync();
    const before = vectors.get('note', id)!;
    // Edits land in the same millisecond in a test; make the edit visibly later.
    getDb().prepare('UPDATE notes SET updated_at = updated_at - 10 WHERE id = ?').run(id);
    memoryIndex.sync();
    notes.update(id, { body: 'Debugged the flaky retention sweep test.' });
    eq(memoryIndex.sync().embedded, 1, 'the edit is owed and re-embedded');
    const after = vectors.get('note', id)!;
    ok(dot(before, after) < 0.95, 'and the vector moved with the text');
    const hit = recall('flaky test', { sources: ['note'], limit: 1 })[0];
    eq(hit?.id, id, 'search finds it by what it says now');
    notes.delete(id);
    const r = memoryIndex.sync();
    eq(r.removed, 1, 'the orphaned vector is removed');
    eq(vectors.get('note', id), null, 'and is gone');
    return 'stale and orphaned vectors are found from the rows, with no write hooks to forget';
  });

  await check('text with nothing to embed is marked once, not retried forever', () => {
    wipe();
    notes.create({ type: 'recap', title: '—', body: '…' });
    eq(memoryIndex.sync().embedded, 1, 'looked at once');
    eq(memoryIndex.sync().embedded, 0, 'and not owed again');
    eq(vectors.counts().total, 0, 'without becoming a vector that matches every other dash');
    return 'indexed for its words, with no vector';
  });

  await check('a different embedding model empties the index and rebuilds it', () => {
    wipe();
    notes.create({ type: 'recap', title: 'Morning', body: 'Wrote the release notes.' });
    facts.create({ kind: 'habit', statement: 'Writes release notes on Fridays', confidence: 0.6, source: 'observed' });
    memoryIndex.sync();
    const fake: Embedder = {
      id: 'fake-8d@1',
      dim: 8,
      embed: (t) => {
        if (!t.trim()) return null;
        const v = new Float32Array(8);
        for (const ch of t) v[ch.charCodeAt(0) % 8]! += 1;
        const n = Math.sqrt(dot(v, v));
        return v.map((x) => x / n);
      },
    };
    setEmbedderForTesting(fake);
    memoryIndex.open();
    eq(vectors.counts().total, 0, 'the old vectors are gone, not mixed with the new space');
    memoryIndex.sync();
    eq(vectors.counts().total, 2, 'everything re-embedded');
    const decl = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vec'").get() as { sql: string }).sql;
    ok(decl.includes('float[8]'), 'vec0 recreated for the new dimension');
    setEmbedderForTesting(undefined);
    memoryIndex.open();
    memoryIndex.sync();
    eq(memoryIndex.status().model, embedder()!.id, 'and back');
    return 'a model change is a rebuild, never two vector spaces in one index';
  });

  // ══ Facts: the merge ══════════════════════════════════════════════════════

  await check('a re-worded belief is reinforced rather than duplicated', () => {
    wipe();
    const a = learnFact({ kind: 'preference', statement: 'Prefers to reply in the Slack thread rather than by DM', confidence: 0.6, source: 'observed' });
    eq(a.action, 'added', 'first sighting');
    const b = learnFact({ kind: 'preference', statement: 'Prefers replying in Slack threads rather than DMs.', confidence: 0.6, source: 'observed' });
    eq(b.action, 'reinforced', 'second sighting, different wording');
    const f = facts.get((a as { fact: { id: number } }).fact.id)!;
    eq(f.evidence, 2, 'evidence counted');
    ok(f.confidence > 0.6, 'and belief went up');
    eq(facts.all().length, 1, 'one row');
    return `one belief, seen twice, ${f.confidence.toFixed(2)} sure`;
  });

  await check('opposites are not merged: dark mode is not light mode', () => {
    wipe();
    learnFact({ kind: 'preference', statement: 'Prefers dark mode in every editor', confidence: 0.6, source: 'observed' });
    const v1 = memoryIndex.embed('Prefers dark mode in every editor')!;
    const v2 = memoryIndex.embed('Prefers light mode in every editor')!;
    const sim = dot(v1, v2);
    const r = learnFact({ kind: 'preference', statement: 'Prefers light mode in every editor', confidence: 0.6, source: 'observed' });
    eq(r.action, 'added', 'a separate belief');
    eq(facts.all().length, 2, 'two rows');
    ok(sameBelief('Prefers dark mode in editors', 'Prefers dark mode', 0.9), 'a narrower restatement is the same belief');
    ok(!sameBelief('Prefers dark mode', 'Prefers light mode', 0.99), 'an opposite is not, however close the vectors');
    return `cosine ${sim.toFixed(2)} — meaning alone would have merged them; the word check does not`;
  });

  await check('a belief the person rejected is never learned again', () => {
    wipe();
    const r = learnFact({ kind: 'habit', statement: 'Uses dark mode in VS Code', confidence: 0.6, source: 'observed' });
    const id = (r as { fact: { id: number } }).fact.id;
    memory.reject(id);
    const again = learnFact({ kind: 'habit', statement: 'Uses dark mode in VS Code.', confidence: 0.9, source: 'observed' });
    eq(again.action, 'blocked', 'the same belief is blocked');
    eq(facts.get(id)!.evidence, 1, 'and a rejection is not argued back by repetition');
    const other = learnFact({ kind: 'habit', statement: 'Uses light mode in VS Code', confidence: 0.6, source: 'observed' });
    eq(other.action, 'added', 'while a genuinely different belief is not blocked by it');
    return 'rejected beliefs are kept as a list of things not to learn';
  });

  await check('telling buddy overrides a past rejection, in the person’s own words', () => {
    wipe();
    const r = learnFact({ kind: 'habit', statement: 'Uses dark mode in VS Code', confidence: 0.6, source: 'observed' });
    memory.reject((r as { fact: { id: number } }).fact.id);
    const taught = memory.teach('remember that I use dark mode in VS Code');
    ok(!!taught.fact, taught.note);
    eq(taught.fact!.status, 'pinned', 'pinned');
    eq(taught.fact!.statement, 'I use dark mode in VS Code.', 'stored as said');
    eq(facts.rejected().length, 1, 'the old rejection stays as history');
    return taught.note;
  });

  await check('credentials never become beliefs, however they arrive', () => {
    wipe();
    eq(learnFact({ kind: 'context', statement: 'Their OpenAI key is sk-proj1234567890abcdefghijkl', confidence: 0.9, source: 'observed' }).action, 'blocked', 'an API key from a rollup');
    eq(memory.teach('remember my card is 4111 1111 1111 1111').fact, null, 'a card number from the person');
    eq(facts.all().length, 0, 'nothing stored');
    return 'the guardrail’s key and card detectors, applied to memory';
  });

  await check('beliefs fade unless seen again; what the person confirmed does not', () => {
    wipe();
    const now = Date.now();
    const old = facts.create({ kind: 'habit', statement: 'Plays chess at lunch', confidence: 0.6, source: 'observed', seenAt: now - 90 * DAY });
    const expected = 0.6 * Math.pow(0.5, 90 / HALF_LIFE_DAYS.habit);
    ok(Math.abs(old.effective - expected) < 1e-6, `two half-lives: ${old.effective.toFixed(3)} vs ${expected.toFixed(3)}`);
    ok(old.dormant && old.effective < DORMANT_BELOW, 'dormant');
    ok(!facts.believed(now).some((f) => f.id === old.id), 'so it is no longer brought up');
    const back = facts.reinforce(old.id, now)!;
    ok(!back.dormant && Math.abs(back.effective - 0.72) < 1e-6, 'seen again, it is back at 0.72');
    const skill = facts.create({ kind: 'skill', statement: 'Writes Swift', confidence: 0.6, source: 'observed', seenAt: now - 90 * DAY });
    ok(skill.effective > 0.5, `a skill fades slower: ${skill.effective.toFixed(2)} after 90 days`);
    const told = facts.create({ kind: 'habit', statement: 'Runs at 7am', confidence: 0.2, source: 'told', seenAt: now - 900 * DAY });
    eq(told.effective, 1, 'a pinned belief does not fade');
    const seen = effectiveConfidence({ confidence: 0.6, evidence: 16, kind: 'habit', status: 'active', lastSeenAt: now - 90 * DAY }, now);
    ok(seen > old.effective, 'and evidence slows the fade');
    return `habit after 90 days: ${expected.toFixed(2)} → dormant; skill ${skill.effective.toFixed(2)}; seen 16×: ${seen.toFixed(2)}`;
  });

  await check('reinforcement has diminishing returns, and a first sighting is capped', () => {
    wipe();
    const f = facts.create({ kind: 'habit', statement: 'Writes docs on Thursdays', confidence: 0.95, source: 'observed' });
    eq(f.confidence, 0.6, 'one hour of watching is a hypothesis: capped at 0.6');
    const seq = [f.confidence];
    for (let i = 0; i < 4; i++) seq.push(facts.reinforce(f.id)!.confidence);
    ok(seq.every((c, i) => i === 0 || c > seq[i - 1]!), 'rising');
    ok(seq[4]! < 0.95, 'never certain from watching alone');
    eq(facts.create({ kind: 'goal', statement: 'Wants the memory work merged', confidence: 0.99, source: 'corrected' }).confidence, 0.85, 'a correction starts higher');
    return seq.map((c) => c.toFixed(2)).join(' → ');
  });

  await check('a revision supersedes the old belief; a retraction weakens it', () => {
    wipe();
    const a = facts.create({ kind: 'project', statement: 'Owns the Q3 migration', confidence: 0.6, source: 'observed' });
    const b = facts.create({ kind: 'habit', statement: 'Works late on Thursdays', confidence: 0.6, source: 'observed' });
    const sum = applyLearnings(
      [
        { op: 'revise', fact_id: a.id, kind: 'project', statement: 'Owns the Q4 connector migration', confidence: 0.7, source: 'observed', evidence: 'obs 3' },
        { op: 'retract', fact_id: b.id, kind: 'habit', statement: b.statement, confidence: 0.6, source: 'observed', evidence: 'obs 4' },
      ],
      { known: [a, b], rejected: [], runs: [] },
      [],
    );
    eq(sum.revised, 1, 'revised');
    eq(sum.retracted, 1, 'retracted');
    const old = facts.get(a.id)!;
    eq(old.status, 'superseded', 'the old belief is superseded');
    const next = facts.get(old.supersededBy!)!;
    eq(next.statement, 'Owns the Q4 connector migration', 'by the corrected one');
    eq(facts.get(b.id)!.confidence, 0.3, 'the retracted one halved');
    return 'history kept: the old row points at its replacement';
  });

  await check('a model cannot rewrite what the person confirmed, or touch a fact it was not shown', () => {
    wipe();
    const mine = facts.create({ kind: 'preference', statement: 'Replies in threads, never by DM', confidence: 1, source: 'told' });
    const hidden = facts.create({ kind: 'context', statement: 'Works from a 16-inch MacBook', confidence: 0.6, source: 'observed' });
    memoryIndex.sync();
    const sum = applyLearnings(
      [
        { op: 'revise', fact_id: mine.id, kind: 'preference', statement: 'Prefers DMs', confidence: 0.9, source: 'observed', evidence: '' },
        { op: 'retract', fact_id: mine.id, kind: 'preference', statement: mine.statement, confidence: 0.9, source: 'observed', evidence: '' },
        // An F-number it was never shown: treated as new text, not as a handle.
        { op: 'reinforce', fact_id: hidden.id, kind: 'preference', statement: 'Listens to lo-fi while coding', confidence: 0.6, source: 'observed', evidence: '' },
      ],
      { known: [mine], rejected: [], runs: [] },
      [],
    );
    eq(facts.get(mine.id)!.statement, 'Replies in threads, never by DM', 'the person’s words stand');
    eq(facts.get(mine.id)!.status, 'pinned', 'still pinned');
    eq(facts.get(hidden.id)!.evidence, 1, 'the unshown fact is untouched');
    eq(sum.ignored, 2, 'two ignored');
    eq(sum.added, 1, 'and the made-up reference became an ordinary new belief');
    return 'pinned beliefs are reinforce-only; F-numbers are honoured only if they were shown';
  });

  // ══ Learning inside the rollup ════════════════════════════════════════════

  await check('the hourly summary is shown what buddy believes, what was rejected, and the runs — and learns from its reply', async () => {
    wipe();
    const jira = facts.create({ kind: 'workflow', statement: 'Files Jira bugs with a Repro steps heading and the log in a code block', confidence: 0.6, source: 'observed' });
    const rejected = facts.create({ kind: 'habit', statement: 'Files Jira tickets late on Friday afternoons', confidence: 0.6, source: 'observed' });
    facts.reject(rejected.id);
    const runId = finishedRun('Reply to Priya in the #sam-eng thread');
    episodes.recordRun(viewOf(runId, 'Reply to Priya in the #sam-eng thread', 'done', 'Replied.'), offer('Send Priya a DM'));
    obsRow('Filed a Jira bug SAM-4500 with a Repro steps heading and pasted the stack trace in a code block', Date.now(), ['Jira']);
    obsRow('Linked SAM-4500 back to the Slack thread with Priya', Date.now(), ['Slack']);
    memoryIndex.sync();

    const model = new ScriptedModel((_n, req) => {
      const text = (req.content[0] as { text: string }).text;
      ok(text.includes(`F${jira.id} [workflow`), 'the relevant belief is shown with its F-number');
      ok(/<rejected_by_the_person>[\s\S]*Files Jira tickets late on Friday/.test(text), 'the rejection is shown as one');
      ok(text.includes(`[run ${runId} · corrected]`), 'and the correction is shown');
      return ROLLUP_STUB({
        learnings: [
          { op: 'reinforce', fact_id: jira.id, kind: 'workflow', statement: jira.statement, confidence: 0.8, source: 'observed', evidence: 'obs 1' },
          { op: 'add', fact_id: null, kind: 'preference', statement: 'Replies to Priya in the Slack thread rather than by DM', confidence: 0.9, source: 'correction', evidence: `run ${runId}` },
          { op: 'add', fact_id: null, kind: 'habit', statement: 'Files Jira tickets late on Friday afternoons.', confidence: 0.5, source: 'observed', evidence: 'obs 2' },
        ],
      });
    });
    const engine = new NotesEngine({ scheduler: new FakeScheduler() as unknown as CaptureScheduler, client: model, settings: baseSettings() });
    let result: RollupResult | null = null;
    engine.on('rollup', (r: RollupResult) => (result = r));
    const now = Date.now();
    ok(await engine.runRollup('manual', { from: now - 3_600_000, to: now }), 'the rollup ran');
    const learned = (result as RollupResult | null)?.learned;
    ok(!!learned, 'it reports what it learned');
    eq(learned!.reinforced, 1, 'one reinforced');
    eq(learned!.added, 1, 'one added');
    eq(learned!.blocked, 1, 'one blocked — the rejected belief, offered again');
    eq(facts.get(jira.id)!.evidence, 2, 'the workflow belief gained evidence');
    const pref = facts.all().find((f) => f.kind === 'preference')!;
    eq(pref.source, 'corrected', 'the new belief knows it came from a correction');
    ok(episodes.byRun(runId, 'run')!.learnedAt != null, 'and the run is marked learned from');
    return `reinforced 1, added 1, blocked 1 — in the same call that wrote the recap`;
  });

  await check('with learning off, the summary is told so and nothing is learned', async () => {
    wipe();
    obsRow('Filed a Jira bug with repro steps');
    const model = new ScriptedModel((_n, req) => {
      const text = (req.content[0] as { text: string }).text;
      ok(text.includes('<learning>off'), 'told learning is off');
      ok(!text.includes('<what_buddy_has_learned>'), 'and shown nothing it believes');
      return ROLLUP_STUB({
        learnings: [{ op: 'add', fact_id: null, kind: 'workflow', statement: 'Files Jira bugs with repro steps', confidence: 0.9, source: 'observed', evidence: '' }],
      });
    });
    const engine = new NotesEngine({ scheduler: new FakeScheduler() as unknown as CaptureScheduler, client: model, settings: baseSettings({ learningEnabled: false }) });
    const now = Date.now();
    await engine.runRollup('manual', { from: now - 3_600_000, to: now });
    eq(model.calls.length, 1, 'the recap still ran');
    eq(facts.all().length, 0, 'a learning it returned anyway was ignored');
    return 'the setting is honoured below the prompt, not just in it';
  });

  await check('the rollup schema requires learnings and rejects a malformed one', () => {
    ok(RollupSchema.safeParse(ROLLUP_STUB()).success, 'a well-formed rollup passes');
    ok(!RollupSchema.safeParse({ ...ROLLUP_STUB(), learnings: undefined }).success, 'missing learnings fails');
    ok(
      !RollupSchema.safeParse(ROLLUP_STUB({ learnings: [{ op: 'forget', fact_id: null, kind: 'habit', statement: 'x', confidence: 1, source: 'observed', evidence: '' } as never] })).success,
      'an operation outside the four fails',
    );
    ok(
      !RollupSchema.safeParse(ROLLUP_STUB({ learnings: [{ op: 'add', fact_id: null, kind: 'mood', statement: 'x', confidence: 1, source: 'observed', evidence: '' } as never] })).success,
      'a kind outside the eight fails',
    );
    return 'validated before anything is written';
  });

  await check('both providers’ schema converters accept the new rollup and Ask shapes', () => {
    // The live API is the real judge (`npm run live:learn`); this is the part
    // that can be checked offline: the converters build, and what they build
    // still says what the zod schema says.
    const anthropic = JSON.stringify(zodOutputFormat(RollupSchema as never));
    // The SDK moves enum constraints into the field's description for the
    // API, and zod enforces them again on the way back — so the operations
    // and kinds are looked for anywhere in the format, not as `enum` members.
    for (const token of ['learnings', 'fact_id', 'reinforce', 'retract', 'relationship']) {
      ok(anthropic.includes(token), `the Anthropic format is missing ${token}`);
    }
    ok(JSON.stringify(zodOutputFormat(AnswerSchema as never)).includes('cited_fact_ids'), 'and Ask’s fact citations');
    const strict = zodToStrictJsonSchema(RollupSchema) as { properties: { learnings: { items: { required: string[]; additionalProperties: boolean } } } };
    const item = strict.properties.learnings.items;
    eq(item.additionalProperties, false, 'OpenAI strict: no additional properties on a learning');
    ok(['op', 'fact_id', 'kind', 'statement', 'confidence', 'source', 'evidence'].every((k) => item.required.includes(k)), 'and every field required');
    const ask = zodToStrictJsonSchema(AnswerSchema) as { required: string[] };
    ok(ask.required.includes('cited_fact_ids'), 'the optional citation list is required under strict mode, as OpenAI demands');
    ok(AnswerSchema.safeParse({ answer: 'a', cited_note_ids: [] }).success, 'while a provider that omits it still parses');
    return 'Anthropic structured outputs and OpenAI strict mode both build';
  });

  // ══ Runs and corrections ══════════════════════════════════════════════════

  await check('how the goal that ran relates to the one buddy offered', () => {
    const o = offer('Send Priya a DM about the rename', ['Reply in the #sam-eng thread']);
    eq(classifyGoal('Send Priya a DM about the rename.', o), 'accepted', 'punctuation is not a correction');
    eq(classifyGoal('Reply in the #sam-eng thread', o), 'alternative', 'buddy’s second guess');
    eq(classifyGoal('Reply to Priya in the thread instead', o), 'corrected', 'their own words');
    eq(classifyGoal('Anything', null), 'typed', 'nothing was offered');
    eq(classifyGoal('Something else', { ...o, source: 'task-note' }), 'typed', 'typing over the 200 ms provisional goal is not a correction');
    eq(classifyGoal('Send Priya a DM about the rename', { ...o, source: 'task-note' }), 'provisional', 'accepting it is noted as such');
    return 'accepted · alternative · corrected · typed · provisional';
  });

  await check('a run is one episode however many times it ends; its correction is written once', () => {
    wipe();
    const goal = 'Reply to Priya in the thread';
    const runId = finishedRun(goal);
    memory.expectRun(goal, {
      phase: 'ready',
      goal: 'Send Priya a DM',
      source: 'model',
      reading: { goal: 'Send Priya a DM', confidence: 0.7, alternatives: [], evidence: [], already_done: [], first_steps: [], proposed_profile: 'attended', risk_flags: [], target_apps: [], injection_notice: null },
      error: null,
      ms: 1,
      costUsd: 0,
      requestId: 1,
    });
    memory.onRunUpdate(viewOf(runId, goal, 'waiting', 'Waiting for Priya.', ['Slack']));
    memory.onRunUpdate(viewOf(runId, goal, 'waiting', 'Waiting for Priya.', ['Slack']));
    // The standby resume ends it: no activation, same run.
    memory.onRunUpdate(viewOf(runId, goal, 'done', 'Replied in the thread.', ['Slack']));
    const all = episodes.recent(10);
    eq(all.filter((e) => e.kind === 'run').length, 1, 'one run episode');
    eq(all.filter((e) => e.kind === 'correction').length, 1, 'one correction');
    const run = episodes.byRun(runId, 'run')!;
    eq(run.status, 'done', 'the outcome updated to how it finally ended');
    eq(run.goalSource, 'corrected', 'and still knows it was a correction');
    eq(run.steps, 7, 'steps from the cumulative run row');
    eq(JSON.stringify(run.apps), '["Slack"]', 'apps from what the guardrail saw at dispatch');
    return 'waiting → resumed → done is one memory, not three';
  });

  await check('deleting a run forgets what was learned from it', () => {
    wipe();
    const runId = finishedRun('File the bug');
    episodes.recordRun(viewOf(runId, 'File the bug', 'done', 'Filed.'), offer('File a ticket'));
    memoryIndex.sync();
    ok(vectors.counts().bySource.episode === 2, 'the run and its correction are indexed');
    runs.delete(runId);
    eq(episodes.recent(10).length, 0, 'episodes cascade with the run');
    memoryIndex.sync();
    eq(vectors.counts().bySource.episode, 0, 'and their vectors go on the next sync');
    return 'deleting a run is how someone says "forget that happened"';
  });

  // ══ Recall ════════════════════════════════════════════════════════════════

  let benchSummary = '';
  await check('hybrid recall beats either half alone on the retrieval set', () => {
    wipe();
    const bench = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals', 'memory-retrieval', 'bench.json'), 'utf8')) as {
      memories: { id: number; type: string; text: string }[];
      queries: { q: string; relevant: number[] }[];
    };
    const refOf = new Map<string, number>();
    for (const m of bench.memories) {
      if (m.type === 'fact') refOf.set(`f${facts.create({ kind: 'context', statement: m.text, confidence: 0.6, source: 'observed' }).id}`, m.id);
      else if (m.type === 'observation') refOf.set(`o${obsRow(m.text).id}`, m.id);
      else if (m.type === 'task') refOf.set(`n${tasks.upsert({ title: m.text }).id}`, m.id);
      else refOf.set(`n${notes.create({ type: m.type as 'recap' | 'relation', title: m.text.split(' ').slice(0, 3).join(' '), body: m.text })}`, m.id);
    }
    memoryIndex.sync();

    const score = (rank: (q: string) => string[]) => {
      let hit1 = 0;
      let hit3 = 0;
      let mrr = 0;
      for (const { q, relevant } of bench.queries) {
        const ids = rank(q).map((r) => refOf.get(r));
        const best = ids.findIndex((id) => id != null && relevant.includes(id));
        if (best === 0) hit1++;
        if (best >= 0 && best < 3) hit3++;
        if (best >= 0) mrr += 1 / (best + 1);
      }
      const n = bench.queries.length;
      return { hit1: hit1 / n, hit3: hit3 / n, mrr: mrr / n };
    };
    const hybrid = score((q) => recall(q, { limit: 10 }).map((h) => h.ref));
    const meaning = score((q) =>
      vectors.knn(memoryIndex.embed(q)!, 10).map((h) => `${h.source[0]}${h.sourceId}`),
    );
    setEmbedderForTesting(null);
    memoryIndex.open();
    const words = score((q) => recall(q, { limit: 10 }).map((h) => h.ref));
    setEmbedderForTesting(undefined);
    memoryIndex.open();

    const fmt = (s: { hit1: number; hit3: number; mrr: number }) =>
      `hit@1 ${Math.round(s.hit1 * 100)}% · hit@3 ${Math.round(s.hit3 * 100)}% · MRR ${s.mrr.toFixed(2)}`;
    benchSummary = `\n      words only    ${fmt(words)}\n      meaning only  ${fmt(meaning)}\n      hybrid        ${fmt(hybrid)}`;
    ok(hybrid.hit3 >= 0.9, `hybrid top-3 is below 90%:${benchSummary}`);
    ok(hybrid.hit3 > words.hit3, `hybrid beats keywords alone:${benchSummary}`);
    ok(hybrid.mrr >= meaning.mrr - 0.02, `and does not lose to meaning alone:${benchSummary}`);
    return `${bench.queries.length} questions over ${bench.memories.length} memories:${benchSummary}`;
  });

  await check('recall finds what no keyword matches', () => {
    wipe();
    const lunch = facts.create({ kind: 'habit', statement: 'Usually takes lunch around 12:30 and is idle for about 45 minutes', confidence: 0.7, source: 'observed' });
    facts.create({ kind: 'preference', statement: 'Prefers dark mode in every editor', confidence: 0.7, source: 'observed' });
    facts.create({ kind: 'workflow', statement: 'Deploys to staging with the g tool after tests pass', confidence: 0.7, source: 'observed' });
    memoryIndex.sync();
    const hits = recall('when does the user go for a meal break', { limit: 3 });
    eq(hits[0]?.id, lunch.id, 'the lunch habit ranks first');
    eq(hits[0]?.matched, 'meaning', 'found by meaning alone — it shares no word with the question');
    return `similarity ${hits[0]!.similarity!.toFixed(2)} for a question with no word in common`;
  });

  await check('recall prefers the recent and the believed, and spreads its results', () => {
    wipe();
    const oldId = notes.create({ type: 'recap', title: 'Q3 migration page', body: 'Worked on the Q3 migration page Overview.' });
    const newId = notes.create({ type: 'recap', title: 'Q3 migration page', body: 'Worked on the Q3 migration page Overview.' });
    getDb().prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now() - 60 * DAY, oldId);
    for (let i = 0; i < 6; i++) obsRow(`Edited the Q3 Migration page in Notion, Overview section, paragraph ${i + 1}`);
    const blocker = facts.create({ kind: 'project', statement: 'Owns the Q3 migration; the Blockers section waits on Priya', confidence: 0.8, source: 'observed' });
    memoryIndex.sync();
    const hits = recall('Q3 migration page', { limit: 4 });
    const rank = (src: string, id: number) => hits.findIndex((h) => h.source === src && h.id === id);
    ok(rank('note', newId) >= 0 && (rank('note', oldId) < 0 || rank('note', newId) < rank('note', oldId)), 'this week’s recap outranks March’s');
    ok(hits.filter((h) => h.source === 'observation').length <= 2, 'six near-copies do not take every slot');
    ok(rank('fact', blocker.id) >= 0, 'so the belief about the project still makes the top four');
    return hits.map((h) => h.ref).join(' ');
  });

  await check('Ask answers from what buddy learned, and cites it', async () => {
    wipe();
    const f = memory.teach('remember that I prefer to be asked before buddy sends anything on Slack').fact!;
    memoryIndex.sync();
    const model = new ScriptedModel((_n, req) => {
      const text = (req.content[0] as { text: string }).text;
      ok(text.includes('What buddy has learned about the person'), 'the learned facts are in context');
      ok(text.includes(`F${f.id} (preference, they told buddy)`), 'with an F-number and where it came from');
      return { answer: 'You want to be asked before anything is sent on Slack.', cited_note_ids: [], cited_fact_ids: [f.id, 99_999] };
    });
    const out = await askAboutMyDay('what do you know about how I like Slack handled?', { client: model, provider: 'anthropic', model: QA_MODEL });
    eq(out.cited.length, 1, 'one citation — the made-up one is dropped');
    eq(out.cited[0]!.type, 'fact', 'typed as a fact');
    eq(out.cited[0]!.id, f.id, 'resolving to the real one');
    return '"what do you know about me" has an answer, and it can be checked';
  });

  await check('the Notes search widens to notes that match by meaning', () => {
    wipe();
    const id = notes.create({ type: 'recap', title: 'Lunch', body: 'Had lunch with the design team at the Thai place.' });
    notes.create({ type: 'recap', title: 'Morning', body: 'Reviewed pull requests for the connector.' });
    memoryIndex.sync();
    eq(notes.search('meal', 'recap').length, 0, 'keywords find nothing for "meal"');
    const related = semanticNotes('eating a meal with colleagues', 'recap', new Set());
    eq(related[0]?.id, id, 'meaning finds the lunch');
    return 'keyword hits first, then related ones marked as such';
  });

  // ══ The stages that read the memory ═══════════════════════════════════════

  await check('goal inference gets the profile, matching corrections and the week — and none of it with learning off', () => {
    wipe();
    memory.teach('remember that I reply in Slack threads, never by DM');
    const runId = finishedRun('Reply to Priya in the #sam-eng thread about the connector rename');
    episodes.recordRun(
      viewOf(runId, 'Reply to Priya in the #sam-eng thread about the connector rename', 'done', 'Replied.'),
      offer('Send Priya a DM about the connector rename'),
    );
    const db = getDb();
    const now = Date.now();
    for (let d = 1; d <= 4; d++) {
      const t = new Date(now - d * DAY);
      db.prepare('INSERT INTO app_usage VALUES (?, ?, ?, ?, ?, ?)').run(
        `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
        new Date(now).getHours(),
        t.getDay(),
        'com.tinyspeck.slackmacgap',
        'Slack',
        2_400,
      );
    }
    memoryIndex.sync();
    const signals = [signal({ windowTitle: 'Slack — #sam-eng — Priya: is the connector rename going ahead?' })];
    const b = buildBundle(signals, now);
    ok((b.profile ?? []).some((f) => f.statement.includes('Slack threads') && f.source === 'told'), 'the profile carries what they said');
    eq(b.corrections?.length, 1, 'the matching correction is there');
    eq(b.corrections![0]!.proposed, 'Send Priya a DM about the connector rename', 'with what buddy proposed');
    ok(!!b.rhythm, 'and the week');
    const text = (renderBundle(b)[0] as { text: string }).text;
    for (const tag of ['<about_the_user>', '<past_corrections>', '<rhythm>']) ok(text.includes(tag), `${tag} rendered`);
    ok(text.indexOf('<about_the_user>') < text.indexOf('<relations>'), 'the stable profile sits early, with the other stable blocks');

    settings.update({ learningEnabled: false });
    const off = buildBundle(signals, now);
    settings.update({ learningEnabled: true });
    ok(!off.profile && !off.corrections && !off.rhythm && !off.recalled, 'learning off: none of it');
    return `profile ${b.profile!.length}, corrections ${b.corrections!.length}, rhythm "${b.rhythm!.slice(0, 48)}…"`;
  });

  await check('a bundle with no memory renders exactly as the eval fixtures were tuned on', () => {
    const fixtures = path.join(process.cwd(), 'evals', 'goal-inference', 'fixtures');
    let n = 0;
    for (const f of fs.readdirSync(fixtures).filter((x) => x.endsWith('.json') && !x.includes('.shot'))) {
      const b = (JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8')) as { bundle: ContextBundle }).bundle;
      const plain = JSON.stringify(renderBundle(b));
      const emptied = JSON.stringify(renderBundle({ ...b, profile: [], corrections: [], recalled: [], rhythm: null }));
      eq(emptied, plain, `${f}: empty memory fields render as nothing`);
      for (const tag of ['about_the_user', 'past_corrections', 'rhythm', 'recalled']) ok(!plain.includes(`<${tag}>`), `${f}: no <${tag}>`);
      n++;
    }
    return `${n} fixtures render byte-identically with and without empty memory`;
  });

  await check('the Operator is told how this person works — as background, never as permission', () => {
    wipe();
    facts.create({ kind: 'workflow', statement: 'Files Jira bugs with a Repro steps heading and the log in a code block', confidence: 0.8, source: 'observed' });
    facts.create({ kind: 'preference', statement: 'Listens to lo-fi music on Spotify while coding', confidence: 0.8, source: 'observed' });
    const runId = finishedRun('File a Jira bug from Priya’s Slack thread about the crash', 'done', 'Filed SAM-4500 and linked the thread.');
    episodes.recordRun(viewOf(runId, 'File a Jira bug from Priya’s Slack thread about the crash', 'done', 'Filed SAM-4500 and linked the thread.'), null);
    memoryIndex.sync();
    const block = operatorMemory('File a Jira bug for the crash Priya reported in Slack');
    ok(!!block, 'there is something relevant to say');
    ok(block!.includes('Repro steps'), 'the relevant workflow is in it');
    ok(!block!.includes('lo-fi'), 'the irrelevant preference is not');
    ok(block!.includes('Earlier runs that look like this one') && block!.includes('Filed SAM-4500'), 'nor is the earlier run forgotten');
    ok(/never authorise/.test(block!), 'and it says what it is not');
    const base = { goal: 'File the bug', profile: 'attended' as const, allowlist: { apps: [], domains: [] }, budgets: { maxSteps: 60, maxWallClockMs: 600_000, maxCostUsd: 2 }, scale: 1, screen: { width: 1728, height: 1117 } };
    const withMem = buildSystemPrompt({ ...base, memory: block });
    ok(withMem.indexOf('## How this person works') < withMem.indexOf('## Ending the run'), 'placed among how to work, before the rules');
    ok(!buildSystemPrompt(base).includes('## How this person works'), 'and absent, not empty, when there is nothing');
    eq(operatorMemory('Order a birthday cake'), null, 'nothing relevant: no section at all');
    return `${block!.split('\n').filter((l) => l.startsWith('- ')).length} lines of background for a Jira goal`;
  });

  // ══ The week ══════════════════════════════════════════════════════════════

  await check('the week is learned from the T0 signal, with idle, excluded and asleep time left out', () => {
    wipe();
    const rec = new RhythmRecorder({ enabled: () => true, excluded: (b) => b === 'com.1password.1password' });
    // Three recent weekdays at 10:00.
    const days: Date[] = [];
    for (let back = 1; days.length < 3; back++) {
      const d = new Date(Date.now() - back * DAY);
      if (d.getDay() >= 1 && d.getDay() <= 5) days.push(d);
    }
    for (const d of days) {
      const t0 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).getTime();
      let t = t0;
      const feed = (n: number, over: Partial<T0Signal>) => {
        for (let i = 0; i < n; i++, t += 2_000) rec.onSignal(signal({ ts: t, ...over }));
      };
      feed(900, { bundleId: 'com.microsoft.VSCode', appName: 'Code' }); // 30 min
      feed(150, { bundleId: 'com.microsoft.VSCode', appName: 'Code', idleSeconds: 300 }); // 5 min idle
      feed(150, { bundleId: 'com.1password.1password', appName: '1Password' }); // 5 min excluded
      t += 10 * 60_000; // asleep
      feed(300, { bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' }); // 10 min
      rec.onSignal(signal({ ts: t + 3_600_000 })); // much later: the gap is not counted
    }
    rec.flush();
    const r = rhythm();
    const w = days[0]!.getDay();
    const cell = r.grid[w]![10]!;
    ok(cell >= 38 && cell <= 41, `10:00 on ${days[0]!.toDateString()} is ${cell} active minutes, expected ~40`);
    eq(r.topApp[w]![10], 'Code', 'mostly in Code');
    eq((getDb().prepare("SELECT COUNT(*) AS n FROM app_usage WHERE bundle_id = 'com.1password.1password'").get() as { n: number }).n, 0, 'the password manager is not recorded at all');
    ok(r.summary.length > 0, 'and it can say so in words');
    const at = days[0]!;
    const line = rhythmLine(new Date(at.getFullYear(), at.getMonth(), at.getDate() + 7, 10, 15).getTime())!;
    ok(/usually in Code \(7\d%\)/.test(line), `the inference line: "${line}"`);
    return `${cell} min at 10:00 (30 Code + 10 Slack); idle, 1Password and the 10-minute gap not counted · "${r.summary[0]}"`;
  });

  // ══ Teaching ══════════════════════════════════════════════════════════════

  await check('"remember that…" is taught; a question about memory is not', () => {
    for (const t of ['remember that I reply in threads', 'Buddy, remember: Priya is my tech lead', 'note: deploys go through g', 'keep in mind I am off on Fridays', "don't forget I prefer Linear over Jira"]) {
      ok(isTeaching(t), `"${t}" is teaching`);
    }
    for (const t of ['remember what I did yesterday?', 'what did I do this morning', 'Remember', 'notebook cleanup', 'remembering is hard']) {
      ok(!isTeaching(t), `"${t}" is not`);
    }
    eq(parseTeaching('Buddy, remember: Priya is my tech lead')!.kind, 'relationship', 'a person');
    eq(parseTeaching("remember that I prefer Linear over Jira")!.kind, 'preference', 'a preference');
    eq(parseTeaching('remember that I review PRs every morning')!.kind, 'habit', 'a habit');
    eq(parseTeaching('remember that I review PRs every morning')!.statement, 'I review PRs every morning.', 'kept in their words');
    return 'checked before the question test, so "remember that…" never runs anything';
  });

  await check('forgetting everything learned keeps the notes', () => {
    wipe();
    const note = notes.create({ type: 'recap', title: 'Morning', body: 'Wrote the release notes.' });
    memory.teach('remember that I write release notes on Fridays');
    const runId = finishedRun('Write the release notes');
    episodes.recordRun(viewOf(runId, 'Write the release notes', 'done', ''), offer('Draft the changelog'));
    getDb().prepare("INSERT INTO app_usage VALUES ('2026-10-01', 10, 4, 'x', 'X', 60)").run();
    memoryIndex.sync();
    memory.forgetEverything();
    eq(facts.all().length, 0, 'facts gone, rejected ones included');
    eq(episodes.recent(10).length, 0, 'episodes gone');
    eq((getDb().prepare('SELECT COUNT(*) AS n FROM app_usage').get() as { n: number }).n, 0, 'the week gone');
    eq(vectors.counts().bySource.fact + vectors.counts().bySource.episode, 0, 'and their vectors');
    ok(!!notes.get(note), 'while the note stays');
    ok(!!runs.list(5).find((r) => r.id === runId), 'and so does the run log');
    return 'what happened stays; who buddy thinks you are goes';
  });

  // ══ Scale ═════════════════════════════════════════════════════════════════

  await check('a year of observations embeds in seconds and recall stays interactive', () => {
    wipe();
    const apps = ['Notion', 'Slack', 'VS Code', 'Linear', 'Chrome', 'Figma', 'Mail'];
    const verbs = ['Edited', 'Reviewed', 'Replied to', 'Drafted', 'Read', 'Filed', 'Commented on'];
    const things = ['the Q3 migration page', 'SAM-4412', 'Priya’s thread in #sam-eng', 'the connector rename PR', 'the release notes', 'Arjun’s demo deck', 'the retention sweep test'];
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO observations (ts_start, ts_end, summary, apps_json, entities_json, confidence, frame_ids_json)
       VALUES (?, ?, ?, ?, '[]', 0.8, '[]')`,
    );
    const N = 20_000;
    const t = Date.now() - 365 * DAY;
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const a = apps[i % apps.length]!;
        ins.run(t + i * 1_500_000, t + i * 1_500_000 + 180_000, `${verbs[(i * 3) % 7]} ${things[(i * 5) % 7]} in ${a}, pass ${i}`, JSON.stringify([a]));
      }
    })();
    const t0 = performance.now();
    memoryIndex.sync();
    const syncMs = performance.now() - t0;
    const times: number[] = [];
    for (const q of ['what did Priya ask about the rename', 'release notes', 'retention test failures', 'Arjun demo', 'SAM-4412', 'what did I do in Figma']) {
      const s = performance.now();
      recall(q, { limit: 12 });
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    ok(syncMs < 15_000, `embedding ${N} observations took ${(syncMs / 1000).toFixed(1)} s`);
    ok(median < 150, `median recall ${median.toFixed(0)} ms`);
    return `${N.toLocaleString()} observations embedded in ${(syncMs / 1000).toFixed(1)} s; median recall ${median.toFixed(0)} ms (sqlite-vec ${vectors.isAccelerated() ? 'on' : 'off'})`;
  });

  // ── Report ────────────────────────────────────────────────────────────────

  memoryIndex.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => r.state === 'fail');
  const pad = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: '✓', fail: '✗', skip: '–' } as const;
  let report =
    '\nMemory checks (M5 — buddy learns you)\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${results.length - failed.length}/${results.length} passed\n`;
  report +=
    '\nNever covered here: whether a live rollup learns *good* facts from a real\n' +
    'afternoon. The embedder, the index and the retrieval are the real ones;\n' +
    'the language model is scripted. Reading the You tab after a day of use is\n' +
    'the only check for the rest.\n\n';
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
