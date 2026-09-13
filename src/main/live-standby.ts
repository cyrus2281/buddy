/**
 * Story B, end to end, against live models.
 *
 *   npm run live:standby
 *
 * `check:m4` proves the machinery — the schedule surviving a restart, the
 * attempt accounting, the transcript that actually reaches the model on a
 * resume. What it cannot prove is the thing the feature is *for*: that a small
 * model, shown one screenshot and a sentence, can tell whether the condition
 * became true, and that the big model picks the work back up rather than
 * starting it over.
 *
 * So this runs the whole loop with nothing scripted:
 *
 *   1. A TextEdit document says `STATUS: pending`. The Operator (**Opus 5**) is
 *      asked to finish a job it cannot finish yet, and to go to standby.
 *   2. The harness edits the document to `STATUS: READY` — standing in for the
 *      coworker who finally replies.
 *   3. The **real** `StandbyManager` polls the **real** `wakeups` row, captures
 *      the **real** screen, and asks **Haiku 4.5** the condition.
 *   4. On `met: true` the original run resumes on Opus 5 with its saved
 *      transcript and finishes the job.
 *
 * The assertion at the end is the document's contents, not the model's summary.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb } from './store/db.js';
import { settings } from './settings.js';
import { secrets } from './secrets.js';
import { sidecar } from './sidecar/supervisor.js';
import { runs } from './store/runs.js';
import { operator } from './agent/orchestrator.js';
import { StandbyManager } from './agent/standby.js';
import { runContext } from './agent/context.js';
import { AnthropicStructuredClient } from './notes/model.js';
import { SpendMeter } from './notes/spend.js';
import type { PendingGate, RunView } from '../shared/types.js';

const DOC = 'buddy-standby-run.txt';

const TASK =
  'The TextEdit document "buddy-standby-run.txt" is open. Read it.\n\n' +
  'If the STATUS line says "pending", you cannot finish yet and must not guess: call `finish` ' +
  'with status "waiting", a `wake` of { after_s: 20, condition: "the TextEdit document ' +
  'buddy-standby-run.txt shows STATUS: READY", max_attempts: 4 }, and a summary saying what you ' +
  'are waiting for.\n\n' +
  'If the STATUS line says "READY", the wait is over: click at the end of the last line of the ' +
  'document, press Return, type exactly SHIPPED and save with cmd+s. Then call `finish` with ' +
  'status "done".';

const ALLOWLIST = { apps: ['com.apple.TextEdit'], domains: [] };
const BUDGETS = { maxSteps: 40, maxWallClockMs: 4 * 60_000, maxCostUsd: 1.0 };

const out = (s: string) => fs.writeSync(1, s + '\n');

function writeDoc(status: 'pending' | 'READY'): string {
  const file = path.join(paths.scratch(), DOC);
  fs.mkdirSync(paths.scratch(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    ['buddy standby run — scratch document. Safe to delete.', '', `STATUS: ${status}`, ''].join('\n'),
  );
  return file;
}

/** TextEdit holds the file open; rewriting it on disk is not enough. Reverting
 *  is the documented way to make it re-read from disk without a dialog. */
function reopenInTextEdit(file: string) {
  execFileSync('/usr/bin/osascript', [
    '-e',
    `tell application "TextEdit"
       activate
       try
         close (every document whose path is "${file}") saving no
       end try
       open POSIX file "${file}"
     end tell`,
  ]);
}

async function main() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    out('\nANTHROPIC_API_KEY is not set.');
    process.exit(2);
  }
  // The Operator resolves its own client from the keychain; the harness's env
  // key is what the wake check uses, so both halves are live.
  if (!secrets.has('anthropic')) {
    try {
      secrets.set('anthropic', key);
    } catch {
      /* the Operator's factory falls back below */
    }
  }
  operator.setClientFactory(null);

  await sidecar.start();
  const perms = await sidecar.permissions();
  if (!perms.screenRecording || !perms.accessibility) {
    out(`\nbuddyd needs both grants. screen=${perms.screenRecording} ax=${perms.accessibility}`);
    process.exit(2);
  }

  const file = writeDoc('pending');
  execFileSync('/usr/bin/open', ['-a', 'TextEdit', file]);
  await new Promise((r) => setTimeout(r, 1_500));
  execFileSync('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to activate']);
  await new Promise((r) => setTimeout(r, 1_500));

  operator.on('step', (s: { idx: number; tool: string; result: unknown; isError: boolean }) =>
    out(`  ${String(s.idx).padStart(3)} ${s.isError ? '✗' : ' '} ${s.tool.padEnd(22)} ${String(s.result).slice(0, 88)}`),
  );
  operator.on('gate', (g: PendingGate) => {
    out(`  GATE ${g.verdict.class} on ${g.verdict.target} — denying`);
    operator.resolveGate('deny');
  });

  // ── Act one: it cannot finish, so it waits ───────────────────────────────

  out('\nStory B, live.\n\n1. STATUS: pending — asking Opus 5 to finish something it cannot yet.\n');
  const first: RunView = await operator.start({
    goal: TASK,
    profile: 'attended',
    allowlist: ALLOWLIST,
    budgets: BUDGETS,
  });

  out('');
  out(`   → ${first.status}: ${first.outcome?.summary ?? first.haltReason}`);
  if (first.status !== 'waiting') {
    out('\n   It did not go to standby, so there is nothing to wake. Stopping here.');
    await finish(1);
    return;
  }

  const wake = runs.pendingWakeups();
  out(
    `   → wakeup #${wake[0]?.id} on "${wake[0]?.condition}" every ${wake[0]?.interval_s}s, ` +
      `${wake[0]?.max_attempts} attempts`,
  );
  out(`   → transcript saved: ${runContext.exists(first.id) ? 'yes' : 'NO — cannot resume'}`);

  // ── The restart. The wait is a row, so it survives one ───────────────────

  closeDb();
  openDb();
  settings.load();
  const afterRestart = runs.pendingWakeups();
  out(
    `\n2. Closed and reopened the database — the wait ${
      afterRestart.length ? 'survived' : 'DID NOT SURVIVE'
    } (${afterRestart.length} pending).`,
  );

  // ── Act two: the thing happens ───────────────────────────────────────────

  out('\n3. Flipping the document to STATUS: READY — the coworker replied.\n');
  writeDoc('READY');
  reopenInTextEdit(file);
  await new Promise((r) => setTimeout(r, 2_000));

  const spend = new SpendMeter(100);
  const standby = new StandbyManager({
    operator,
    spend,
    // The real Haiku client, not a scripted one. This is the whole point.
    client: () => new AnthropicStructuredClient(key),
    settings: () => settings.get(),
  });
  standby.on('checked', (e: { met: boolean; why: string; attempt: number }) =>
    out(`   check ${e.attempt}: not yet — ${e.why}`),
  );
  standby.on('resuming', (e: { why: string; attempt: number }) =>
    out(`   check ${e.attempt}: MET — ${e.why}\n\n4. Resuming the original run on Opus 5.\n`),
  );

  // Bring the wakeup forward rather than waiting out its 20 s; the attempt is
  // still spent, which is what `makeDue` is for.
  for (const w of runs.pendingWakeups()) runs.makeDue(w.id, Date.now() - 1);
  const fired = await standby.tick();

  // ── What actually happened ───────────────────────────────────────────────

  const finalRun = runs.get(first.id)!;
  const doc = fs.readFileSync(file, 'utf8');
  const shipped = /SHIPPED/.test(doc);
  const steps = runs.steps(first.id);

  out('\n' + '─'.repeat(78) + '\n');
  out(`STORY B   wakeups fired: ${fired}`);
  out(`          run ${first.id} is now "${finalRun.status}" — the SAME run, not a new one`);
  out(`          cumulative: ${finalRun.steps} steps, $${finalRun.cost_usd.toFixed(4)}`);
  out(`          wake checks in the run log: ${steps.filter((s) => s.tool === 'wake-check').length}`);
  out(`          resume steps in the run log: ${steps.filter((s) => s.tool === 'resume').length}`);
  out(`          wake-check spend: $${spend.report().byTier['wake-check'].toFixed(5)}`);
  out(`          pending wakeups left: ${runs.pendingWakeups().length}`);
  out(`          transcript cleaned up: ${runContext.exists(first.id) ? 'no' : 'yes'}`);
  out('');
  out(`          document now reads:\n${doc.split('\n').map((l) => '            ' + l).join('\n')}`);
  out(`          → ${shipped ? 'SHIPPED is there — Story B works end to end.' : 'SHIPPED is MISSING.'}`);
  out('\n' + '─'.repeat(78) + '\n');

  await finish(shipped && finalRun.status === 'done' ? 0 : 1);
}

async function finish(code: number) {
  await sidecar.stop();
  closeDb();
  process.exit(code);
}

app.whenReady().then(main).catch((e) => {
  out(`\nlive standby run failed: ${(e as Error).stack}`);
  process.exit(1);
});
