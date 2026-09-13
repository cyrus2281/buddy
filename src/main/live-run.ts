/**
 * One real run, against a live Opus 5.
 *
 *   npm run live:run
 *
 * This is the only thing in the repository that talks to the actual API, and it
 * exists because `check:m2` structurally cannot. M2 drives the whole loop
 * through a scripted `ModelClient`, so batch fail-stop, the `toolset_name`
 * field, the screenshot pruning and the cache breakpoints are all correct in
 * *shape* and have never met a server. Three specific claims are unverifiable
 * that way, and each one fails as something that reads like a model problem:
 *
 *   1. **`toolset_name: "computer"` on every `tool_result` is accepted.**
 *      Omitting it is a documented hard 400; including it wrongly would be too,
 *      and a scripted client accepts either.
 *   2. **`usage.cache_read_input_tokens` is non-zero after the first turn.**
 *      A persistent zero means a silent cache invalidator — a reordered tool, a
 *      timestamp in the system prompt, a breakpoint that moved — and it costs
 *      real money per turn without ever failing.
 *   3. **Pruning does not desync `tool_use`/`tool_result` pairing.** The prune
 *      rewrites history every 25 turns. A real task finishes long before that,
 *      so this harness runs the real `pruneScreenshots` against the real
 *      transcript afterwards and sends the result to the API, which is the only
 *      thing that can actually answer the question.
 *
 * The task is deliberately the smallest thing that is genuinely two apps:
 * read two numbers out of a TextEdit document, add them in Calculator, type the
 * total back. Calculator holds no data and can destroy nothing, the TextEdit
 * document is written into `~/.buddy/scratch` by this file, and the budgets are
 * a fifth of the shipping defaults. Confirm gates are auto-denied and reported
 * rather than waited on, so nothing can hang holding the keyboard.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb } from './store/db.js';
import { settings } from './settings.js';
import { sidecar } from './sidecar/supervisor.js';
import { AgentRunner } from './agent/runner.js';
import { AnthropicClient, OPERATOR_MODEL, type ModelClient, type ModelResponse } from './agent/client.js';
import { buildTools } from './agent/tools.js';
import { killSwitches } from './agent/killswitch.js';
import { sealTranscript } from './agent/context.js';
import type { Allowlist, PendingGate } from '../shared/types.js';

const SOURCE = 'buddy-live-run.txt';

const TASK =
  'The TextEdit document "buddy-live-run.txt" is open. It has two numbers in it and a line ' +
  'reading "TOTAL:". Add the two numbers together using the Calculator app, then switch back to ' +
  'TextEdit and type the total immediately after "TOTAL:" on that line. Do not change anything ' +
  'else in the document. Call finish when the total is written.';

const ALLOWLIST: Allowlist = {
  apps: ['com.apple.TextEdit', 'com.apple.calculator'],
  domains: [],
};

/**
 * The shipping step budget, and a shorter clock and cheaper cap — this is
 * somebody's actual machine.
 *
 * 30 steps was the first attempt and it was not enough, for a reason worth
 * writing down: a GUI calculator costs **one step per digit**. "8616 + 5821 ="
 * is eleven `left_click`s, and the run reached the right answer and ran out of
 * budget before it could type it back. The step budget counts tool calls, not
 * intentions, and a click-heavy app burns it fast.
 */
const BUDGETS = { maxSteps: 60, maxWallClockMs: 5 * 60_000, maxCostUsd: 1.0 };

interface TurnUsage {
  turn: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** The real client, with a tap on `usage`. Nothing about the request changes —
 *  a wrapper that altered the body would be measuring itself. */
class ObservedClient implements ModelClient {
  usage: TurnUsage[] = [];
  errors: string[] = [];
  constructor(private inner: AnthropicClient) {}
  async create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    try {
      const res = await this.inner.create(params);
      const u = res.usage;
      this.usage.push({
        turn: this.usage.length + 1,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      });
      return res;
    } catch (e) {
      this.errors.push((e as Error).message);
      throw e;
    }
  }
}

function prepareDocument(): { a: number; b: number; file: string } {
  const a = 1_000 + Math.floor(Math.random() * 8_000);
  const b = 1_000 + Math.floor(Math.random() * 8_000);
  const file = path.join(paths.scratch(), SOURCE);
  fs.mkdirSync(paths.scratch(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    [
      'buddy live run — scratch document. Safe to delete.',
      '',
      `First number: ${a}`,
      `Second number: ${b}`,
      '',
      'TOTAL:',
      '',
    ].join('\n'),
  );
  return { a, b, file };
}

async function main() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    fs.writeSync(1, '\nANTHROPIC_API_KEY is not set. Nothing to run against.\n');
    process.exit(2);
  }

  await sidecar.start();
  const perms = await sidecar.permissions();
  if (!perms.screenRecording || !perms.accessibility) {
    fs.writeSync(
      1,
      `\nbuddyd needs both grants to drive the machine. screenRecording=${perms.screenRecording} ` +
        `accessibility=${perms.accessibility}\n`,
    );
    process.exit(2);
  }

  const { a, b, file } = prepareDocument();
  const expected = a + b;

  // Both apps open, and TextEdit **activated** rather than merely opened,
  // before the first screenshot. `open -a` can leave a window behind whatever
  // is already frontmost, and the first run of this harness spent three real
  // turns discovering that: every key press classified `off_allowlist` because
  // the frontmost app was neither of the two on the list.
  execFileSync('/usr/bin/open', ['-a', 'Calculator']);
  execFileSync('/usr/bin/open', ['-a', 'TextEdit', file]);
  await new Promise((r) => setTimeout(r, 1_500));
  execFileSync('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to activate']);
  await new Promise((r) => setTimeout(r, 1_500));
  const front = await sidecar.frontmost();
  fs.writeSync(1, `  frontmost at start: ${front.appName} (${front.bundleId})\n`);

  const observed = new ObservedClient(new AnthropicClient(key));
  const runner = new AgentRunner({ client: observed, killSwitches });

  const gates: PendingGate[] = [];
  runner.on('gate', (g: PendingGate) => {
    // Never waited on. This is unattended in practice — there is nobody at the
    // keyboard to answer — so a gate denies, which parks the run and shows up
    // in the report as the interesting thing it would be.
    //
    // Answering synchronously is deliberate: it is what found the ordering bug
    // in `askUser`, where the gate event went out before the resolver was
    // installed and an immediate answer was silently dropped.
    gates.push(g);
    fs.writeSync(1, `  GATE  ${g.verdict.class} on ${g.verdict.target} — denying\n`);
    const took = runner.resolveGate('deny');
    if (!took) fs.writeSync(1, '  GATE  the answer was DROPPED — the run will hang\n');
  });
  runner.on('step', (s: { idx: number; tool: string; result: unknown; isError: boolean }) => {
    fs.writeSync(
      1,
      `  ${String(s.idx).padStart(3)} ${s.isError ? '✗' : ' '} ${s.tool.padEnd(24)} ${String(
        s.result,
      ).slice(0, 90)}\n`,
    );
  });

  fs.writeSync(1, `\nLive run — ${OPERATOR_MODEL}\n  ${a} + ${b} = ${expected}\n  ${file}\n\n`);

  const view = await runner.run({
    goal: TASK,
    profile: 'attended',
    allowlist: ALLOWLIST,
    budgets: BUDGETS,
  });

  // ── The three questions ──────────────────────────────────────────────────

  const lines: string[] = ['', '─'.repeat(78), ''];

  // 0. Did it do the task?
  const after = fs.readFileSync(file, 'utf8');
  const totalLine = after.split('\n').find((l) => l.startsWith('TOTAL:')) ?? '';
  const wrote = totalLine.replace('TOTAL:', '').replace(/[^0-9]/g, '');
  lines.push(
    `TASK      ${view.status} in ${view.usage.steps} steps, ${Math.round(
      view.usage.elapsedMs / 1000,
    )}s, $${view.usage.costUsd.toFixed(4)}`,
    `          document now reads "${totalLine.trim()}" — expected ${expected} → ${
      wrote === String(expected) ? 'CORRECT' : 'WRONG'
    }`,
    `          outcome: ${view.outcome?.summary ?? view.haltReason ?? '(none)'}`,
  );
  if (gates.length) {
    lines.push(
      `          ${gates.length} confirm gate(s) fired and were auto-denied: ` +
        gates.map((g) => `${g.verdict.class}/${g.verdict.target}`).join(', '),
    );
  }

  // 1. toolset_name accepted.
  const computerResults = countComputerResults(runner.transcript());
  lines.push(
    '',
    `Q1 toolset_name   ${computerResults} computer tool_result block(s) sent with ` +
      `toolset_name:"computer"; ${observed.usage.length} turn(s) completed with ` +
      `${observed.errors.length} API error(s).`,
    observed.errors.length
      ? `          errors: ${observed.errors.join(' | ')}`
      : '          No 400 — the field is accepted as sent.',
  );

  // 2. Prompt caching.
  const cacheRows = observed.usage
    .map(
      (u) =>
        `          turn ${String(u.turn).padStart(2)}  in ${String(u.input).padStart(6)}  ` +
        `write ${String(u.cacheWrite).padStart(6)}  read ${String(u.cacheRead).padStart(6)}`,
    )
    .join('\n');
  const afterFirst = observed.usage.slice(1);
  const cacheOk = afterFirst.length > 0 && afterFirst.some((u) => u.cacheRead > 0);
  lines.push(
    '',
    `Q2 cache          ${cacheOk ? 'NON-ZERO after the first turn' : 'ZERO — a silent invalidator'}` +
      ` (max read ${Math.max(0, ...observed.usage.map((u) => u.cacheRead))} tokens)`,
    cacheRows,
  );

  // 3. Pruning against the real API.
  lines.push('', 'Q3 pruning');
  const transcript = runner.transcript();

  // Measured BEFORE the prune as well as after, because "the pruned
  // conversation is desynced" and "the conversation was already desynced" are
  // different findings and only one of them is about pruning. The first version
  // of this harness only measured after, and reported a halted run's unanswered
  // batch as a pruning failure.
  const pairingBefore = checkPairing(transcript);
  const beforeImages = countImages(transcript);
  const pruned = runner.pruneNow();
  const afterImages = countImages(transcript);
  const pairingAfter = checkPairing(transcript);
  lines.push(
    `          ${beforeImages} image block(s) → pruned ${pruned} → ${afterImages} left ` +
      `(the shipping rule keeps the last 3)`,
    `          pairing before the prune: ${pairingBefore.ok ? 'intact' : `DESYNCED — ${pairingBefore.why}`}`,
    `          pairing after  the prune: ${pairingAfter.ok ? 'intact' : `DESYNCED — ${pairingAfter.why}`}`,
    `          → pruning ${pairingBefore.ok === pairingAfter.ok ? 'changed nothing about pairing' : 'CHANGED PAIRING'}`,
  );

  // And the seal, which is what standby actually writes to disk. A run that
  // halted inside a batch leaves that batch unanswered; `sealTranscript` answers
  // it, and the API is the only authority on whether that is enough.
  const sealed = sealTranscript(transcript);
  const pairingSealed = checkPairing(sealed);
  lines.push(
    `          pairing after sealTranscript: ${
      pairingSealed.ok ? 'intact' : `DESYNCED — ${pairingSealed.why}`
    } (${sealed.length - transcript.length} synthetic result message(s) inserted)`,
  );

  // The only test that counts: send it to the API.
  try {
    const probe = new AnthropicClient(key);
    const res = await probe.create({
      model: OPERATOR_MODEL,
      max_tokens: 1_024,
      system: [{ type: 'text', text: 'Answer in one short sentence.' }],
      tools: buildTools(),
      messages: [
        ...sealed,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'This is a diagnostic, not a continuation. Do not call any tool. In one sentence, ' +
                'say what you did in this conversation.',
            },
          ],
        },
      ],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    } as Anthropic.Messages.MessageCreateParamsNonStreaming);
    const said = res.content
      .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join(' ')
      .trim();
    lines.push(
      '          API accepted the pruned + sealed conversation — no 400, no orphaned tool_use.',
      `          it summarised it as: "${said.slice(0, 160)}"`,
    );
  } catch (e) {
    lines.push(`          API REJECTED the pruned + sealed conversation: ${(e as Error).message}`);
  }

  lines.push('', '─'.repeat(78), '');
  fs.writeSync(1, lines.join('\n'));

  await sidecar.stop();
  closeDb();
  process.exit(0);
}

function countComputerResults(messages: Anthropic.Messages.MessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as unknown as Record<string, unknown>[]) {
      if (b.type === 'tool_result' && b.toolset_name === 'computer') n++;
    }
  }
  return n;
}

function countImages(messages: Anthropic.Messages.MessageParam[]): number {
  let n = 0;
  const walk = (blocks: Record<string, unknown>[]) => {
    for (const b of blocks) {
      if (b.type === 'image') n++;
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        walk(b.content as unknown as Record<string, unknown>[]);
      }
    }
  };
  for (const m of messages) if (Array.isArray(m.content)) walk(m.content as unknown as Record<string, unknown>[]);
  return n;
}

/** Every `tool_use` answered, in order, by a `tool_result` in the next message.
 *  The local half of Q3; the API is the authoritative half. */
function checkPairing(messages: Anthropic.Messages.MessageParam[]): { ok: boolean; why: string } {
  const uses = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as unknown as Record<string, unknown>[]) {
      if (b.type === 'tool_use') uses.add(String(b.id));
      if (b.type === 'tool_result') answered.add(String(b.tool_use_id));
    }
  }
  const orphans = [...uses].filter((id) => !answered.has(id));
  const strays = [...answered].filter((id) => !uses.has(id));
  if (orphans.length) return { ok: false, why: `${orphans.length} tool_use with no result` };
  if (strays.length) return { ok: false, why: `${strays.length} tool_result with no tool_use` };
  return { ok: true, why: `${uses.size} pairs` };
}

app.whenReady().then(main).catch((e) => {
  fs.writeSync(1, `\nlive run failed: ${(e as Error).stack}\n`);
  process.exit(1);
});
