/**
 * Story C — buddy learns you — against live models.
 *
 *   npm run live:learn
 *
 * `check:memory` proves the machinery with the real embedder and the real
 * vector index, and a scripted language model. What it cannot prove is that
 * the API accepts the schemas this milestone added, and that a real Sonnet,
 * shown what buddy already believes, *reuses* it instead of writing the same
 * belief again every hour. That is the whole difference between a memory and
 * a pile of notes, so this runs it with nothing scripted:
 *
 *   1. Two days of observations of one person's habits, rolled up separately
 *      by **Sonnet 5** — the second rollup sees what the first one learned.
 *   2. A goal the person overrode, which the second rollup should learn from.
 *   3. **Ask** (Sonnet 5): "what do you know about how I work?", which should
 *      cite what was learned.
 *   4. **Goal inference** (Opus 5) over an eval fixture with the learned
 *      profile and the correction attached — the new bundle blocks, live.
 *
 * Runs against a throwaway database: a real afternoon's memory is not the
 * place to try this. Costs about twenty cents.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb } from './store/db.js';
import { settings } from './settings.js';
import { observations } from './store/notes.js';
import { runs } from './store/runs.js';
import { anthropicBaseUrl } from './providers.js';
import { AnthropicStructuredClient } from './notes/model.js';
import { rollup } from './notes/rollup.js';
import { askAboutMyDay } from './notes/ask.js';
import { inferGoal } from './agent/inference.js';
import { memoryIndex } from './memory/index.js';
import { facts } from './memory/facts.js';
import { episodes } from './memory/episodes.js';
import { inferenceMemory } from './memory/context.js';
import type { ContextBundle } from '../../prompts/context-bundle.js';
import type { RunView } from '../shared/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-live-learn-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

const out = (s: string) => fs.writeSync(1, s + '\n');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Two mornings of the same person. Day two repeats two habits from day one in
 *  different words, and adds one new thing — so a memory that works reinforces
 *  two beliefs and adds one, and a pile of notes adds three. */
const DAY_ONE = [
  'Opened GitHub before anything else and reviewed two open pull requests on buddy (#212, #214), leaving inline comments; Slack stayed closed until both were approved.',
  'Filed Jira bug SAM-4500 from Priya Raman’s message in #sam-eng: wrote a "Repro steps" heading, numbered the steps, and pasted the stack trace into a code block.',
  'Replied to Priya’s question about the connector rename inside the #sam-eng thread rather than starting a DM.',
  'Edited the Notion page "Q3 Connector Migration" — Priya is listed as reviewer; the user owns the Blockers section.',
];
const DAY_TWO = [
  'First thing: went through the GitHub review queue (PR #219, #220) and approved one; only opened Slack afterwards.',
  'Filed SAM-4512 in Jira with a "Repro steps" section and the log pasted as a code block, linked from the Slack thread.',
  'Booked the Thursday design review in Google Calendar and wrote the agenda in the Notion page "Design Reviews".',
];

async function main() {
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    out('\nANTHROPIC_API_KEY is not set (in the shell or in .env). Nothing to run against.');
    process.exit(2);
  }

  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();
  memoryIndex.open();
  const client = new AnthropicStructuredClient(key, anthropicBaseUrl());
  let spent = 0;
  const failures: string[] = [];
  const expect = (cond: boolean, what: string) => {
    out(`   ${cond ? '✓' : '✗'} ${what}`);
    if (!cond) failures.push(what);
  };

  const seed = (lines: string[], at: number) =>
    lines.map((summary, i) =>
      observations.insert({
        tsStart: at + i * 600_000,
        tsEnd: at + i * 600_000 + 180_000,
        summary,
        apps: [],
        entities: [],
        confidence: 0.85,
        frameIds: [],
      }),
    );

  const showFacts = () =>
    facts.all().forEach((f) =>
      out(`     F${f.id} ${f.kind.padEnd(12)} ${f.confidence.toFixed(2)} ×${f.evidence} ${f.source.padEnd(9)} ${f.statement}`),
    );

  // ── 1. Day one ───────────────────────────────────────────────────────────
  out('\nStory C, live.\n\n1. Day one: four observations → Sonnet 5 rollup with learning on.');
  const d1 = Date.now() - 2 * DAY;
  const obs1 = seed(DAY_ONE, d1);
  const r1 = await rollup(client, obs1, 'manual', { from: d1, to: d1 + 2 * HOUR }, { learn: true });
  spent += r1?.costUsd ?? 0;
  out(`   learned: ${JSON.stringify(r1?.learned)}  ($${(r1?.costUsd ?? 0).toFixed(4)}, ${r1?.ms} ms)`);
  showFacts();
  const afterDay1 = facts.all().length;
  expect(!!r1 && afterDay1 >= 1, 'the API accepted the rollup schema and something durable was learned');

  // ── 2. A correction, then day two ────────────────────────────────────────
  out('\n2. A goal the person overrode, then day two → a second rollup that sees day one’s beliefs.');
  const goal = 'Reply to Priya in the #sam-eng thread with the connector-rename decision';
  const runId = runs.create(goal, 'attended');
  runs.finish(runId, 'done', 9, 0.18, { status: 'done', summary: 'Posted the decision as a reply in the thread.' });
  episodes.recordRun(
    { id: runId, goal, status: 'done', startedAt: Date.now() - DAY, steps: [], usage: { steps: 9, elapsedMs: 0, costUsd: 0.18, exceeded: null }, outcome: { status: 'done', summary: 'Posted the decision as a reply in the thread.' }, haltReason: null } as unknown as RunView,
    { goal: 'Send Priya a DM with the connector-rename decision', source: 'model', alternatives: [], confidence: 0.72 },
  );
  const d2 = Date.now() - DAY;
  const obs2 = seed(DAY_TWO, d2);
  memoryIndex.sync();
  const before = new Map(facts.all().map((f) => [f.id, f.evidence]));
  const r2 = await rollup(client, obs2, 'manual', { from: d2, to: d2 + 2 * HOUR }, { learn: true });
  spent += r2?.costUsd ?? 0;
  out(`   learned: ${JSON.stringify(r2?.learned)}  ($${(r2?.costUsd ?? 0).toFixed(4)}, ${r2?.ms} ms)`);
  showFacts();
  const reinforcedIds = facts.all().filter((f) => (before.get(f.id) ?? 0) > 0 && f.evidence > before.get(f.id)!);
  expect(reinforcedIds.length >= 1, `day two reinforced what day one learned (${reinforcedIds.length} belief${reinforcedIds.length === 1 ? '' : 's'} seen again)`);
  expect(facts.all().some((f) => f.source === 'corrected' || /thread/i.test(f.statement)), 'the correction (thread, not DM) is reflected in what buddy believes');
  memoryIndex.sync();

  // ── 3. Ask ───────────────────────────────────────────────────────────────
  out('\n3. Ask (Sonnet 5): "what do you know about how I work?"');
  const a = await askAboutMyDay('what do you know about how I work?', {
    client,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  });
  spent += a.costUsd;
  out(`   ${a.answer.replace(/\n/g, '\n   ')}`);
  out(`   cited: ${a.cited.map((c) => `${c.type}#${c.id}`).join(', ') || '(nothing)'}  ($${a.costUsd.toFixed(4)})`);
  expect(a.cited.some((c) => c.type === 'fact'), 'the answer cites learned facts');

  // ── 4. Goal inference with the memory attached ───────────────────────────
  out('\n4. Goal inference (Opus 5) on an eval fixture, with the learned profile and the correction attached.');
  const fixture = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'evals', 'goal-inference', 'fixtures', '01-clean-resume.json'), 'utf8'),
  ) as { bundle: ContextBundle };
  const mem = inferenceMemory('Slack #sam-eng Priya connector rename thread reply');
  const bundle: ContextBundle = {
    ...fixture.bundle,
    ...(mem.profile.length ? { profile: mem.profile } : {}),
    ...(mem.corrections.length ? { corrections: mem.corrections } : {}),
    ...(mem.recalled.length ? { recalled: mem.recalled } : {}),
  };
  out(`   bundle carries ${mem.profile.length} learned facts, ${mem.corrections.length} correction(s), ${mem.recalled.length} recalled`);
  const g = await inferGoal(client, bundle);
  spent += g.costUsd;
  out(`   goal: ${g.reading.goal}`);
  out(`   confidence ${g.reading.confidence} · ${g.reading.evidence.length} evidence · $${g.costUsd.toFixed(4)} · ${(g.ms / 1000).toFixed(1)} s`);
  expect(!!g.reading.goal && g.reading.confidence > 0, 'Opus read the bundle with the memory blocks and produced a reading');
  expect(!g.reading.injection_notice, 'and did not mistake a learned fact for an instruction');

  out(`\nTotal spent: $${spent.toFixed(4)}`);
  out(failures.length ? `\n${failures.length} expectation(s) not met.\n` : '\nAll expectations met.\n');
  memoryIndex.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    out(`\nlive:learn failed: ${(e as Error).stack ?? e}`);
    process.exit(1);
  }),
);
