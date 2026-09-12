/**
 * M2 exit-criteria checks, run against the real modules — not reimplementations.
 *
 *   npm run check:m2
 *
 * Same shape as `m1-checks.ts`: inside Electron, against a throwaway userData
 * directory, so it never touches real runs or real frames.
 *
 * **What this harness can and cannot prove.** It drives the real `AgentRunner`,
 * the real `Executor`, the real guardrails, and the real `KillSwitches`, with
 * two things replaced:
 *
 *   - the **model**, by a scripted `ModelClient` that returns the exact content
 *     blocks a turn would. This is the point of the seam: every loop invariant
 *     worth testing (fail-stop, deny-parks, budget parks, pruning, the
 *     `toolset_name` on every result) is about what the loop does with a
 *     response, not about the network.
 *   - the **sidecar's `input`, `capture`, and `target_info`**, by a fake that
 *     records what was dispatched and answers with whatever AX facts the case
 *     needs. Real `CGEvent` dispatch is TCC-gated and cannot run headlessly, and
 *     a check that needs a granted Mac is a check that never runs.
 *
 * Everything between those two seams is the shipping code. What that leaves
 * unproven is stated in `README.md` rather than implied to be covered.
 */
import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, getDb, closeDb } from './store/db.js';
import { runs } from './store/runs.js';
import { normalizeAccelerator, settings } from './settings.js';
import { AgentRunner, HALT_TEXT } from './agent/runner.js';
import { Executor, type Frame } from './agent/executor.js';
import { KillSwitches } from './agent/killswitch.js';
import { classify, enforce, hostAllowed, policyMatrix, type TargetInfo } from './agent/guardrails.js';
import { BudgetTracker, costOf } from './agent/budget.js';
import { buildTools, COMPUTER_ACTIONS, COMPUTER_TOOLSET_NAME, FinishSchema } from './agent/tools.js';
import { buildSystemPrompt } from './agent/prompt.js';
import type { ModelClient, ModelResponse } from './agent/client.js';
import type { Allowlist, RunProfile, RunView } from '../shared/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-m2-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };
const results: Result[] = [];

/** A check that needs something this machine has not granted. It is neither a
 *  pass nor a failure: reporting it as a pass would be a lie, and reporting it
 *  as a failure would mean `check:m2` never goes green on a fresh machine,
 *  which teaches people to ignore the whole report. It is printed loudly, with
 *  what to do about it, and excluded from the score. */
class Skipped extends Error {}
const skip = (why: string): never => {
  throw new Skipped(why);
};

function check(name: string, fn: () => string | Promise<string>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, state: 'pass', detail });
    })
    .catch((e: Error) => {
      results.push({ name, state: e instanceof Skipped ? 'skip' : 'fail', detail: e.message });
    });
}
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
}

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A scripted model: one canned response per turn, and a record of what it was
 *  sent so the cache and pruning invariants can be read off the request. */
class ScriptedModel implements ModelClient {
  turn = 0;
  requests: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];

  constructor(
    private script: (
      turn: number,
      req: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ) => ModelResponse | Promise<ModelResponse>,
  ) {}

  async create(req: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    this.requests.push(structuredClone(req) as typeof req);
    return this.script(this.turn++, req);
  }
}

let nextToolId = 1;
const toolUse = (name: string, input: unknown, toolset = true): Anthropic.Messages.ContentBlock =>
  ({
    type: 'tool_use',
    id: `toolu_${nextToolId++}`,
    name,
    input,
    caller: { type: 'direct' },
    ...(toolset ? { toolset_name: COMPUTER_TOOLSET_NAME } : {}),
  }) as Anthropic.Messages.ContentBlock;

const turn = (content: Anthropic.Messages.ContentBlock[], usage?: Partial<ModelResponse['usage']>): ModelResponse => ({
  content,
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
});

const finishTurn = (summary = 'Done.', status: 'done' | 'waiting' | 'needs_human' = 'done', wake?: unknown) =>
  turn([toolUse('finish', { status, summary, ...(wake ? { wake } : {}) }, false)]);

/** The sidecar, faked at the RPC boundary: everything above it is real. */
interface FakeOptions {
  target?: Partial<TargetInfo>;
  /** Make the nth dispatched input call fail. */
  failOn?: (action: string, n: number) => string | null;
  scale?: number;
  origin?: { x: number; y: number };
}

class FakeExecutor extends Executor {
  dispatched: { action: string; params: Record<string, unknown> }[] = [];
  classified: { action: string; decision: string }[] = [];
  private n = 0;

  constructor(private opts: FakeOptions = {}) {
    super();
  }

  private target(): TargetInfo {
    return {
      bundleId: 'com.apple.TextEdit',
      appName: 'TextEdit',
      pid: 42,
      windowTitle: 'Untitled',
      secureInput: false,
      focused: null,
      url: null,
      element: null,
      ...this.opts.target,
    };
  }

  override async capture(runId: number, region: { x: number; y: number; w: number; h: number } | null): Promise<Frame> {
    const p = path.join(paths.root(), 'runs', String(runId), `fake-${this.n++}.png`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A real 1x1 PNG, so the Run Log's image path is exercised end to end.
    fs.writeFileSync(p, Buffer.from(ONE_PIXEL_PNG, 'base64'));
    return {
      path: p,
      base64: ONE_PIXEL_PNG,
      width: region?.w ?? 1728,
      height: region?.h ?? 1117,
      scale: this.opts.scale ?? 1,
      originX: this.opts.origin?.x ?? 0,
      originY: this.opts.origin?.y ?? 0,
      displayId: 1,
    };
  }

  override async describeFocusedWindow(): Promise<string> {
    return 'AXWindow "Untitled"\n  AXTextArea @864,560 [1600x900]';
  }

  override async execute(
    action: string,
    input: Record<string, unknown>,
    ctx: Parameters<Executor['execute']>[2],
  ): ReturnType<Executor['execute']> {
    // A real dispatch is a sidecar RPC over a pipe, so it turns the event loop.
    // Without this the entire run is one unbroken microtask chain and nothing
    // delivered by `setImmediate` — which is how the hotkey, the IPC Stop, and
    // buddyd's `human_input` notification all arrive — would ever be seen.
    await new Promise((r) => setImmediate(r));

    // The real classifier, on the real policy matrix, with faked AX facts.
    const frame = ctx.lastFrame;
    let point: { x: number; y: number } | null = null;
    const c = input.coordinate;
    if (Array.isArray(c) && frame) point = Executor.translate([Number(c[0]), Number(c[1])], frame);

    const verdict = classify({
      action,
      input,
      target: this.target(),
      allowlist: ctx.allowlist,
      profile: ctx.profile,
    });
    this.classified.push({ action, decision: verdict.decision });

    if (verdict.decision === 'deny') return { kind: 'denied', verdict };
    if (verdict.decision === 'confirm' && !ctx.preApproved) return { kind: 'gate', verdict };

    if (action === 'screenshot' || action === 'zoom') {
      const f = await this.capture(ctx.runId, null);
      return { kind: 'ok', text: '', frame: f, verdict };
    }

    const failure = this.opts.failOn?.(action, this.dispatched.length);
    // Recorded before the failure check would skip it: "what actually reached
    // the machine" must include the attempt that failed.
    this.dispatched.push({ action, params: { ...input, ...(point ? { screenPoint: point } : {}) } });
    if (failure) return { kind: 'error', text: failure, verdict };
    return { kind: 'ok', text: 'OK', verdict };
  }
}

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ALLOW_ALL: Allowlist = { apps: ['com.apple.TextEdit'], domains: ['notion.so'] };

function runner(model: ModelClient, exec: Executor, kill = new KillSwitches()) {
  return new AgentRunner({ client: model, executor: exec, killSwitches: kill });
}

const start = (r: AgentRunner, goal: string, profile: RunProfile = 'attended', budgets = {}) =>
  r.run({ goal, profile, allowlist: ALLOW_ALL, budgets });

// ── The checks ───────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  // ══ Tool surface (PRD §6.3) ═══════════════════════════════════════════════

  await check('the toolset is computer_toolset_20260801 with no beta header', () => {
    const tools = buildTools();
    eq(tools[0].type, 'computer_toolset_20260801', 'toolset entry type');
    ok(!('name' in tools[0]), 'the toolset entry carries no name');
    ok(!('display_width_px' in tools[0]), 'no display_width_px on this toolset');
    eq(COMPUTER_ACTIONS.length, 17, 'member count');
    return `${tools.length} tools, 17 members, schema-less`;
  });

  await check('both custom tools ship alongside the toolset', () => {
    const names = buildTools().map((t) => ('name' in t ? t.name : t.type));
    ok(names.includes('describe_focused_window'), 'describe_focused_window present');
    ok(names.includes('finish'), 'finish present');
    return names.join(', ');
  });

  await check('cache_control sits on the last tool and the system block', () => {
    const tools = buildTools();
    const withCache = tools.filter((t) => 'cache_control' in t && t.cache_control);
    eq(withCache.length, 1, 'exactly one tools breakpoint');
    eq('name' in withCache[0] ? withCache[0].name : '', 'finish', 'it is on the last tool');
    return 'tools prefix ends at `finish`; system carries its own breakpoint';
  });

  await check('the system prompt states that screen content is data, never instruction', () => {
    const p = buildSystemPrompt({
      goal: 'g',
      profile: 'attended',
      allowlist: ALLOW_ALL,
      budgets: { maxSteps: 60, maxWallClockMs: 600_000, maxCostUsd: 2 },
      scale: 1,
      screen: { width: 1728, height: 1117 },
    });
    ok(/data, never instruction/i.test(p), 'the rule is stated');
    ok(/cannot change your goal|widen your allowlist/i.test(p), 'and says what it protects');
    ok(!/you must enforce|refuse if/i.test(p), 'the model is not asked to police itself');
    return `${p.length} chars, §7.4 stated explicitly`;
  });

  // ══ Coordinates (PRD §6.2) ════════════════════════════════════════════════

  await check('coordinates translate by scale and display origin, in one place', () => {
    const at1: Frame = { path: '', base64: '', width: 1728, height: 1117, scale: 1, originX: 0, originY: 0, displayId: 1 };
    const p1 = Executor.translate([800, 400], at1);
    eq(p1.x, 800, 'x at scale 1');
    eq(p1.y, 400, 'y at scale 1');

    // A 4K display in "More Space": 3008x1692 is 5.09 MP, over Opus 5's ceiling.
    const scale = Math.min(1, 2576 / 3008, Math.sqrt(3_750_000 / (3008 * 1692)));
    const at4k: Frame = { ...at1, scale, originX: 1728, originY: 0 };
    const p2 = Executor.translate([800, 400], at4k);
    eq(Math.round(p2.x), Math.round(1728 + 800 / scale), 'x divided by scale and offset');
    eq(Math.round(p2.y), Math.round(400 / scale), 'y divided by scale');
    return `scale 1.0 is identity; 4K "More Space" → ${scale.toFixed(4)}, offset applied`;
  });

  await check('the scale factor travels on every step rather than being recomputed', async () => {
    const exec = new FakeExecutor({ scale: 0.856 });
    const m = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('left_click', { coordinate: [100, 100] })]) : finishTurn(),
    );
    const v = await start(runner(m, exec), 'click something');
    const clicked = exec.dispatched.find((d) => d.action === 'left_click');
    const sp = clicked?.params.screenPoint as { x: number; y: number };
    eq(Math.round(sp.x), Math.round(100 / 0.856), 'the executor divided by the frame scale');
    const shot = v.steps.find((s) => s.tool === 'screenshot');
    eq(shot?.scale, 0.856, 'and the step records it');
    return `model 100 → screen ${sp.x.toFixed(1)}; recorded on the step`;
  });

  // ══ Batch fail-stop (PRD §6.5) ════════════════════════════════════════════

  await check('a batch executes in order and stops at the first failure', async () => {
    const exec = new FakeExecutor({ failOn: (a) => (a === 'type' ? 'the field was not editable' : null) });
    const m = new ScriptedModel((t) =>
      t === 0
        ? turn([
            toolUse('left_click', { coordinate: [10, 10] }),
            toolUse('type', { text: 'hello' }),
            toolUse('key', { text: 'Return' }),
            toolUse('left_click', { coordinate: [20, 20] }),
          ])
        : finishTurn(),
    );
    await start(runner(m, exec), 'batch');

    const actions = exec.dispatched.map((d) => d.action);
    eq(actions.join(','), 'left_click,type', 'the two after the failure never dispatched');

    // The halt text must be exact, and on every block after the failure.
    const second = m.requests[1].messages.find((msg) => msg.role === 'user')!;
    const blocks = (m.requests[1].messages[m.requests[1].messages.length - 1].content as unknown[]).filter(
      (b) => (b as { type: string }).type === 'tool_result',
    ) as { is_error?: boolean; content: { type: string; text: string }[] }[];
    eq(blocks.length, 4, 'all four results came back');
    eq(blocks[0].is_error ?? false, false, 'the first succeeded');
    eq(blocks[1].is_error, true, 'the failure is marked');
    eq(blocks[2].content[0].text, HALT_TEXT, 'block 3 carries the exact halt text');
    eq(blocks[3].content[0].text, HALT_TEXT, 'block 4 carries the exact halt text');
    eq(blocks[3].is_error, true, 'and is an error');
    return `2 of 4 dispatched; blocks 3–4 read "${HALT_TEXT}"`;
  });

  await check('all the results of a batch come back in ONE user message', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) =>
      t === 0
        ? turn([
            toolUse('left_click', { coordinate: [1, 1] }),
            toolUse('left_click', { coordinate: [2, 2] }),
            toolUse('left_click', { coordinate: [3, 3] }),
          ])
        : finishTurn(),
    );
    await start(runner(m, exec), 'batch');
    const msgs = m.requests[1].messages;
    const userMsgs = msgs.filter((x) => x.role === 'user');
    // The opening message plus exactly one results message — not three.
    eq(userMsgs.length, 2, 'one user message for the whole batch');
    const results = (userMsgs[1].content as { type: string }[]).filter((b) => b.type === 'tool_result');
    eq(results.length, 3, 'carrying all three results');
    return 'one user message, three tool_results — batching is not punished';
  });

  await check('every computer tool_result carries toolset_name: "computer"', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) =>
      t === 0
        ? turn([
            toolUse('screenshot', {}),
            toolUse('left_click', { coordinate: [5, 5] }),
            toolUse('describe_focused_window', {}, false),
          ])
        : finishTurn(),
    );
    await start(runner(m, exec), 'toolset name');
    const blocks = resultsOf(m.requests[1]);
    eq(blocks.length, 3, 'three results');
    eq(blocks[0].toolset_name, 'computer', 'screenshot result');
    eq(blocks[1].toolset_name, 'computer', 'click result');
    ok(!('toolset_name' in blocks[2]) || blocks[2].toolset_name == null, 'custom tool carries none');
    return 'computer members tagged; custom tools untagged (omitting it is a hard 400)';
  });

  await check('only screenshot and zoom return images; everything else returns text', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('screenshot', {}), toolUse('key', { text: 'Tab' })]) : finishTurn(),
    );
    await start(runner(m, exec), 'images');
    const blocks = resultsOf(m.requests[1]);
    const kinds = (b: Record<string, unknown>) => (b.content as { type: string }[]).map((c) => c.type);
    eq(kinds(blocks[0]).includes('image'), true, 'screenshot returns an image');
    eq(kinds(blocks[1]).includes('image'), false, 'key returns no image');
    eq(kinds(blocks[1])[0], 'text', 'key returns text');
    return 'screenshot → image + AX tree; key → "OK"';
  });

  await check('the AX tree is returned alongside every screenshot', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) => (t === 0 ? turn([toolUse('screenshot', {})]) : finishTurn()));
    await start(runner(m, exec), 'ax alongside');
    const result = resultsOf(m.requests[1])[0];
    const parts = result.content as { type: string; text?: string }[];
    eq(parts[0].type, 'image', 'the image comes first');
    eq(parts[1].type, 'text', 'the tree comes with it');
    ok(/AXTextArea/.test(parts[1].text ?? ''), 'and it is actually the tree');
    return 'every screenshot carries the named-element tree — §6.3’s largest reliability win';
  });

  // ══ Guardrails (PRD §7.1, §7.2) ═══════════════════════════════════════════

  await check('the policy matrix is exactly PRD §7.1', () => {
    const expected: [string, string, string][] = [
      ['read', 'allow', 'allow'],
      ['type_editor', 'allow', 'allow'],
      ['send', 'confirm', 'deny'],
      ['purchase', 'deny', 'deny'],
      ['credentials', 'deny', 'deny'],
      ['delete', 'confirm', 'deny'],
      ['install', 'confirm', 'deny'],
      ['system_settings', 'confirm', 'deny'],
      ['off_allowlist', 'confirm', 'deny'],
    ];
    for (const [cls, att, un] of expected) {
      eq(enforce(cls as never, 'attended'), att, `${cls} attended`);
      eq(enforce(cls as never, 'unattended'), un, `${cls} unattended`);
    }
    eq(Object.keys(policyMatrix).length, expected.length, 'no extra classes');
    return `${expected.length} classes × 2 profiles, one table`;
  });

  await check('a gated button confirms in attended and parks in unattended', async () => {
    const sendButton = { target: { element: sendEl() } };

    const attended = new FakeExecutor(sendButton);
    const mA = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('left_click', { coordinate: [100, 100] })]) : finishTurn(),
    );
    const rA = runner(mA, attended);
    // Approve as soon as the gate opens: this is the HUD's Approve button.
    rA.on('gate', () => setImmediate(() => rA.resolveGate('approve')));
    const vA = await start(rA, 'send it', 'attended');
    eq(attended.classified[0].decision, 'confirm', 'attended gates');
    eq(attended.dispatched.length, 1, 'and dispatches after approval');
    eq(vA.status, 'done', 'the run continued');

    const unattended = new FakeExecutor(sendButton);
    const mU = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('left_click', { coordinate: [100, 100] })]) : finishTurn(),
    );
    const vU = await start(runner(mU, unattended), 'send it', 'unattended');
    eq(unattended.classified[0].decision, 'deny', 'unattended denies');
    eq(unattended.dispatched.length, 0, 'nothing reached the machine');
    eq(vU.status, 'needs_human', 'and the run parked');
    return 'same classification, two profiles: confirm → dispatch, deny → park';
  });

  await check('a credential field denies under BOTH profiles', async () => {
    for (const profile of ['attended', 'unattended'] as const) {
      const exec = new FakeExecutor({
        target: { focused: { role: 'AXSecureTextField', subrole: '', title: 'Password', isSecureTextField: true } },
      });
      const m = new ScriptedModel((t) =>
        t === 0 ? turn([toolUse('type', { text: 'hunter2' })]) : finishTurn(),
      );
      const v = await start(runner(m, exec), 'log in', profile);
      eq(exec.classified[0].decision, 'deny', `${profile}: denied`);
      eq(exec.dispatched.length, 0, `${profile}: nothing typed`);
      eq(v.status, 'needs_human', `${profile}: parked`);
    }
    return 'AXSecureTextField → deny, attended and unattended alike';
  });

  await check('purchase denies under both profiles', () => {
    for (const profile of ['attended', 'unattended'] as const) {
      const v = classify({
        action: 'left_click',
        input: { coordinate: [1, 1] },
        target: { ...baseTarget(), element: el('AXButton', 'Place order') },
        allowlist: ALLOW_ALL,
        profile,
      });
      eq(v.decision, 'deny', `${profile} denies a purchase`);
      eq(v.class, 'purchase', 'classified as purchase');
    }
    return '"Place order" → purchase → deny, both profiles';
  });

  await check('a deny is never followed by an alternate route to the same effect', async () => {
    const exec = new FakeExecutor({ target: { element: el('AXButton', 'Send') } });
    // A model that tries three ways to send. Only the first should ever be seen.
    const m = new ScriptedModel((t) => {
      if (t === 0) return turn([toolUse('left_click', { coordinate: [100, 100] })]);
      if (t === 1) return turn([toolUse('key', { text: 'cmd+Return' })]);
      if (t === 2) return turn([toolUse('type', { text: 'send\n' })]);
      return finishTurn();
    });
    const v = await start(runner(m, exec), 'send the message', 'unattended');

    eq(m.turn, 1, 'the model was called exactly once — the loop did not continue');
    eq(exec.dispatched.length, 0, 'nothing reached the machine');
    eq(v.status, 'needs_human', 'the run parked');
    ok(/Blocked:/.test(v.haltReason ?? ''), 'and says why');
    const denied = v.steps.filter((s) => s.verdict?.decision === 'deny');
    eq(denied.length, 1, 'one denial in the log');
    return 'deny → park. No second turn, no second route, no asking the model how to proceed.';
  });

  await check('denying at the confirm gate parks rather than retrying', async () => {
    const exec = new FakeExecutor({ target: { element: el('AXButton', 'Delete') } });
    const m = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('left_click', { coordinate: [1, 1] })]) : finishTurn(),
    );
    const r = runner(m, exec);
    r.on('gate', () => setImmediate(() => r.resolveGate('deny')));
    const v = await start(r, 'delete it', 'attended');
    eq(exec.dispatched.length, 0, 'nothing dispatched');
    eq(v.status, 'needs_human', 'parked');
    eq(m.turn, 1, 'the model never got another turn');
    ok(/denied/i.test(v.haltReason ?? ''), 'the reason names the denial');
    return 'user denies → park, same as a policy deny';
  });

  await check('keystroke-content heuristics deny key-shaped and card-shaped text', () => {
    const cases: [string, boolean][] = [
      ['sk-ant-api03-abcdefghijklmnopqrstuvw', true],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123', true],
      ['4111 1111 1111 1111', true], // passes Luhn
      ['4111 1111 1111 1112', false], // fails Luhn
      ['legal umbrella cactus rhythm velvet ginger marble candle harbor puzzle silver orange', true],
      ['Filed SAM-4412 and linked the thread.', false],
      ['Order number 1234567890123456', false],
    ];
    for (const [text, shouldDeny] of cases) {
      const v = classify({
        action: 'type',
        input: { text },
        target: baseTarget(),
        allowlist: ALLOW_ALL,
        profile: 'attended',
      });
      eq(v.decision === 'deny', shouldDeny, `"${text.slice(0, 28)}…"`);
    }
    return `${cases.length} cases: keys, Luhn-valid cards, and seed phrases denied; prose and order numbers not`;
  });

  await check('over-flagging is avoided: ordinary editing stays `allow`', () => {
    const benign: [string, Record<string, unknown>][] = [
      ['type', { text: 'The migration is blocked on the connector rename.' }],
      ['key', { text: 'cmd+s' }],
      ['key', { text: 'shift+Return' }],
      ['scroll', { coordinate: [10, 10], scroll_direction: 'down', scroll_amount: 3 }],
      ['left_click', { coordinate: [10, 10] }],
    ];
    for (const [action, input] of benign) {
      const v = classify({ action, input, target: baseTarget(), allowlist: ALLOW_ALL, profile: 'unattended' });
      eq(v.decision, 'allow', `${action} ${JSON.stringify(input).slice(0, 40)}`);
    }
    // PRD §6.7: over-flagging is not a safe default — it trains users to click
    // through confirmations until they stop reading them.
    return `${benign.length} ordinary actions, all allowed even unattended`;
  });

  await check('Return in a message composer is a send; shift+Return is not', () => {
    const slack = { ...baseTarget(), bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' };
    const send = classify({ action: 'key', input: { text: 'Return' }, target: slack, allowlist: { apps: ['com.tinyspeck.slackmacgap'], domains: [] }, profile: 'attended' });
    eq(send.class, 'send', 'Return in Slack is a send');
    eq(send.decision, 'confirm', 'and is gated in attended');
    const line = classify({ action: 'key', input: { text: 'shift+Return' }, target: slack, allowlist: { apps: ['com.tinyspeck.slackmacgap'], domains: [] }, profile: 'attended' });
    eq(line.decision, 'allow', 'shift+Return is a line break');
    const doc = classify({ action: 'key', input: { text: 'Return' }, target: baseTarget(), allowlist: ALLOW_ALL, profile: 'attended' });
    eq(doc.decision, 'allow', 'Return in a text editor is just a newline');
    return 'the one send path no button title can reveal';
  });

  await check('the unattended allowlist gates apps and domains', () => {
    const off = classify({
      action: 'left_click',
      input: { coordinate: [1, 1] },
      target: { ...baseTarget(), bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' },
      allowlist: ALLOW_ALL,
      profile: 'unattended',
    });
    eq(off.decision, 'deny', 'an app off the list is denied unattended');
    eq(off.class, 'off_allowlist', 'classified as off-allowlist');

    const offAttended = classify({
      action: 'left_click',
      input: { coordinate: [1, 1] },
      target: { ...baseTarget(), bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' },
      allowlist: ALLOW_ALL,
      profile: 'attended',
    });
    eq(offAttended.decision, 'confirm', 'and confirmed in attended');

    const browser = { ...baseTarget(), bundleId: 'com.apple.Safari', appName: 'Safari' };
    const allowlist: Allowlist = { apps: ['com.apple.Safari'], domains: ['notion.so'] };
    eq(
      classify({ action: 'left_click', input: { coordinate: [1, 1] }, target: { ...browser, url: 'https://www.notion.so/x' }, allowlist, profile: 'unattended' }).decision,
      'allow',
      'an allowlisted domain passes',
    );
    eq(
      classify({ action: 'left_click', input: { coordinate: [1, 1] }, target: { ...browser, url: 'https://evil.example/x' }, allowlist, profile: 'unattended' }).decision,
      'deny',
      'another site in the same browser does not',
    );
    ok(!hostAllowed('https://evilnotion.so/x', ['notion.so']), 'suffix match is on a dot boundary');
    ok(hostAllowed('https://www.notion.so/x', ['notion.so']), 'subdomains pass');
    return 'app + domain, both enforced; `evilnotion.so` does not match `notion.so`';
  });

  await check('a run cannot escalate its own profile mid-run', async () => {
    const exec = new FakeExecutor({ target: { element: el('AXButton', 'Send') } });
    const m = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('left_click', { coordinate: [1, 1] })]) : finishTurn(),
    );
    const r = runner(m, exec);
    const v = await start(r, 'send', 'unattended');
    eq(v.profile, 'unattended', 'the profile is what it started as');
    eq(v.status, 'needs_human', 'and the send was denied, not escalated');
    // There is deliberately no API to change it: the field is set once in run().
    ok(!('setProfile' in r), 'AgentRunner exposes no way to change the profile');
    return 'the profile is set once in run() and there is no setter';
  });

  // ══ Kill switches (PRD §7.3) ══════════════════════════════════════════════

  await check('kill switch 1 — the abort hotkey stops a run mid-flight', async () => {
    const { view, dispatched, turns } = await killDuringRun((r) => r.stop('hotkey'));
    eq(view.status, 'needs_human', 'parked');
    ok(/abort hotkey/.test(view.haltReason ?? ''), `haltReason names it: ${view.haltReason}`);
    ok(turns < 6, 'the loop stopped rather than running to its scripted end');
    return `fired mid-run at turn ${turns}, ${dispatched} actions dispatched, "${view.haltReason}"`;
  });

  await check('kill switch 2 — the ~/.buddy/ABORT sentinel stops a run mid-flight', async () => {
    const kill = new KillSwitches();
    const exec = new FakeExecutor();
    let turns = 0;
    const m = new ScriptedModel((t) => {
      turns = t + 1;
      // Create the sentinel from outside the loop, the way a shell would.
      if (t === 2) fs.writeFileSync(paths.abortFile(), '');
      return t < 8 ? turn([toolUse('left_click', { coordinate: [1, 1] })]) : finishTurn();
    });
    const v = await start(runner(m, exec, kill), 'sentinel');
    eq(v.status, 'needs_human', 'parked');
    ok(/ABORT/.test(v.haltReason ?? ''), `haltReason names the file: ${v.haltReason}`);
    ok(turns <= 4, `stopped within a turn of the file appearing (turn ${turns})`);
    eq(fs.existsSync(paths.abortFile()), true, 'the file is left for the user to remove');
    fs.unlinkSync(paths.abortFile());
    return `stat'd every turn; stopped at turn ${turns}`;
  });

  await check('a stale sentinel is cleared when a run arms, not inherited', async () => {
    fs.writeFileSync(paths.abortFile(), '');
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) => (t === 0 ? turn([toolUse('key', { text: 'Tab' })]) : finishTurn()));
    const v = await start(runner(m, exec, new KillSwitches()), 'stale sentinel');
    eq(v.status, 'done', 'a leftover ABORT did not kill the next run');
    eq(fs.existsSync(paths.abortFile()), false, 'and it was cleared');
    return 'arm() clears a stale sentinel — an old abort cannot kill tomorrow’s run';
  });

  await check('kill switch 3 — human takeover stops a run mid-flight', async () => {
    // The signal buddyd's event tap sends, delivered the way it is delivered.
    const { view, turns } = await killDuringRun((r) => r.stop('human-takeover'));
    eq(view.status, 'needs_human', 'parked');
    ok(/took over/.test(view.haltReason ?? ''), `haltReason names it: ${view.haltReason}`);
    return `fired at turn ${turns}: "${view.haltReason}"`;
  });

  await check('kill switch 4 — Stop stops a run mid-flight', async () => {
    const { view, turns } = await killDuringRun((r) => r.stop('stop-button'));
    eq(view.status, 'needs_human', 'parked');
    ok(/Stop button/.test(view.haltReason ?? ''), `haltReason names it: ${view.haltReason}`);
    return `fired at turn ${turns}: "${view.haltReason}"`;
  });

  await check('a killed run keeps its log intact', async () => {
    const { view } = await killDuringRun((r) => r.stop('hotkey'));
    const persisted = runs.steps(view.id);
    ok(persisted.length >= 2, `steps survived in SQLite (${persisted.length})`);
    eq(persisted.length, view.steps.length, 'the in-memory and stored logs agree');
    const row = runs.get(view.id)!;
    eq(row.status, 'needs_human', 'the row records why it ended');
    ok(row.ended_at != null, 'and when');
    return `${persisted.length} steps preserved, run row closed as needs_human`;
  });

  await check('a second kill switch does not stop a second run', () => {
    const k = new KillSwitches();
    // arm() is async only because of the sidecar; the latch is synchronous.
    (k as unknown as { armed: boolean }).armed = true;
    eq(k.fire('hotkey'), true, 'the first fires');
    eq(k.fire('sentinel'), false, 'the second is a no-op');
    eq(k.fired, 'hotkey', 'and the first one is what is reported');
    return 'first switch wins; the rest are no-ops';
  });

  // ══ Budgets (PRD §6.5) ════════════════════════════════════════════════════

  await check('the step budget parks the run with its log intact', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel(() => turn([toolUse('left_click', { coordinate: [1, 1] })]));
    const v = await start(runner(m, exec), 'forever', 'attended', { maxSteps: 6 });
    eq(v.status, 'needs_human', 'parked');
    ok(/Step budget reached: \d+ of 6/.test(v.haltReason ?? ''), `names the number: ${v.haltReason}`);
    ok(v.steps.length >= 6, 'the log is intact');
    ok(v.usage.steps >= 6, 'and the meter agrees');
    return v.haltReason!;
  });

  await check('the cost budget parks the run', async () => {
    const exec = new FakeExecutor();
    // ~$0.00325 a turn at Opus 5 prices; a $0.01 cap lands in a few turns.
    const m = new ScriptedModel(() =>
      turn([toolUse('key', { text: 'Tab' })], { input_tokens: 500, output_tokens: 30 }),
    );
    const v = await start(runner(m, exec), 'expensive', 'attended', { maxCostUsd: 0.01 });
    eq(v.status, 'needs_human', 'parked');
    ok(/Cost budget reached/.test(v.haltReason ?? ''), `names it: ${v.haltReason}`);
    return v.haltReason!;
  });

  await check('the wall-clock budget parks the run', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return turn([toolUse('key', { text: 'Tab' })]);
    });
    const v = await start(runner(m, exec), 'slow', 'attended', { maxWallClockMs: 60 });
    eq(v.status, 'needs_human', 'parked');
    ok(/Time budget reached/.test(v.haltReason ?? ''), `names it: ${v.haltReason}`);
    return v.haltReason!;
  });

  await check('cost is computed at Opus 5 prices, cache reads included', () => {
    const c = costOf({
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    eq(Number(c.toFixed(4)), 5, 'input at $5/MTok');
    eq(
      Number(costOf({ output_tokens: 1_000_000 }).toFixed(4)),
      25,
      'output at $25/MTok',
    );
    eq(Number(costOf({ cache_read_input_tokens: 1_000_000 }).toFixed(4)), 0.5, 'cache read at 0.1x');
    eq(Number(costOf({ cache_creation_input_tokens: 1_000_000 }).toFixed(4)), 6.25, 'cache write at 1.25x');
    const t = new BudgetTracker({ maxSteps: 2, maxWallClockMs: 1e9, maxCostUsd: 1e9 });
    t.step();
    eq(t.usage().exceeded, null, 'one step of two is fine');
    t.step();
    eq(t.usage().exceeded, 'steps', 'two of two is not');
    return 'in $5 · out $25 · write ×1.25 · read ×0.1 per MTok';
  });

  await check('a budget never fails silently and never quietly continues', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel(() => turn([toolUse('key', { text: 'Tab' })]));
    const v = await start(runner(m, exec), 'budget', 'attended', { maxSteps: 4 });
    ok(v.haltReason != null, 'the reason is on the run');
    eq(v.outcome?.status, 'needs_human', 'and the outcome is not a success');
    const stored = runs.get(v.id)!;
    eq(stored.status, 'needs_human', 'persisted as needs_human');
    ok((stored.outcome_json ?? '').includes('budget'), 'with the reason persisted');
    return 'reason on the run, the outcome, and the row';
  });

  // ══ Loop hygiene (PRD §6.5) ═══════════════════════════════════════════════

  await check('screenshots are pruned to the last 3, in a batch every 25 turns', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) => (t < 30 ? turn([toolUse('screenshot', {})]) : finishTurn()));
    await start(runner(m, exec), 'prune', 'attended', { maxSteps: 200 });

    const countImages = (req: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
      let n = 0;
      for (const msg of req.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const b of msg.content as unknown as Record<string, unknown>[]) {
          if (b.type === 'image') n++;
          if (b.type === 'tool_result' && Array.isArray(b.content))
            n += (b.content as { type: string }[]).filter((c) => c.type === 'image').length;
        }
      }
      return n;
    };
    // Turn 25 is the first prune. Before it, images accumulate; after it, three.
    const before = countImages(m.requests[24]);
    const after = countImages(m.requests[25]);
    ok(before > 10, `images accumulate between prunes (${before} at turn 25)`);
    eq(after, 3, 'and are cut to the last 3');
    ok(
      m.requests.slice(1, 24).every((r, i) => countImages(r) >= countImages(m.requests[i])),
      'no pruning happened on the turns in between',
    );
    return `${before} images at turn 25 → ${after} at turn 26; no per-turn rewrite`;
  });

  await check('a pruned screenshot leaves its tool_result in place', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) => (t < 28 ? turn([toolUse('screenshot', {})]) : finishTurn()));
    await start(runner(m, exec), 'prune pairing', 'attended', { maxSteps: 200 });
    const req = m.requests[26];
    const uses = new Set<string>();
    const results = new Set<string>();
    for (const msg of req.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content as unknown as Record<string, unknown>[]) {
        if (b.type === 'tool_use') uses.add(b.id as string);
        if (b.type === 'tool_result') results.add(b.tool_use_id as string);
      }
    }
    eq(uses.size, results.size, 'every tool_use still has its tool_result');
    const text = JSON.stringify(req.messages);
    ok(text.includes('pruned from context'), 'the placeholder explains where the image went');
    return `${uses.size} tool_use/tool_result pairs intact after pruning`;
  });

  await check('cache breakpoints: tools + system fixed, one rolling, never over four', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) => (t < 6 ? turn([toolUse('key', { text: 'Tab' })]) : finishTurn()));
    await start(runner(m, exec), 'cache');

    for (const [i, req] of m.requests.entries()) {
      let n = 0;
      for (const t of req.tools ?? []) if ('cache_control' in t && t.cache_control) n++;
      for (const s of (req.system ?? []) as unknown as Record<string, unknown>[]) if (s.cache_control) n++;
      let rolling = 0;
      for (const msg of req.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const b of msg.content as unknown as Record<string, unknown>[]) if (b.cache_control) rolling++;
      }
      eq(n, 2, `turn ${i}: tools + system breakpoints`);
      eq(rolling, 1, `turn ${i}: exactly one rolling breakpoint`);
      ok(n + rolling <= 4, `turn ${i}: within the four-breakpoint limit`);

      // The rolling one must be on the newest message, or it caches nothing new.
      const last = req.messages[req.messages.length - 1];
      const blocks = last.content as unknown as Record<string, unknown>[];
      ok(blocks[blocks.length - 1].cache_control != null, `turn ${i}: rolling breakpoint is on the newest block`);
    }
    return `${m.requests.length} turns, 3 breakpoints each, always on the newest block`;
  });

  await check('cache reads are measured, so a persistent zero is visible', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) =>
      t < 3
        ? turn([toolUse('key', { text: 'Tab' })], { cache_read_input_tokens: 4200 })
        : finishTurn('done', 'done'),
    );
    const v = await start(runner(m, exec), 'cache telemetry');
    eq(v.cacheReadTokens, 4200 * 3, 'cache reads accumulate on the run view');
    return `${v.cacheReadTokens} cache-read tokens surfaced live in the HUD (§6.5)`;
  });

  // ══ Termination (PRD §6.6) ════════════════════════════════════════════════

  await check('finish sets the run’s terminal status', async () => {
    for (const [status, expected] of [
      ['done', 'done'],
      ['needs_human', 'needs_human'],
    ] as const) {
      const exec = new FakeExecutor();
      const m = new ScriptedModel(() => finishTurn(`ended ${status}`, status));
      const v = await start(runner(m, exec), 'finish');
      eq(v.status, expected, `status=${status}`);
      eq(v.outcome?.summary, `ended ${status}`, 'the summary is the outcome');
    }
    return 'the terminal state comes from a tool call, not from parsing prose';
  });

  await check('finish(waiting) persists a wakeup to SQLite for M4', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel(() =>
      finishTurn('Waiting on Priya.', 'waiting', {
        after_s: 300,
        condition: 'Priya has replied in #sam-eng',
        max_attempts: 12,
      }),
    );
    const v = await start(runner(m, exec), 'standby');
    eq(v.status, 'waiting', 'the run is waiting');
    const w = runs.wakeups(v.id);
    eq(w.length, 1, 'one wakeup row');
    eq(w[0].condition, 'Priya has replied in #sam-eng', 'with the condition');
    eq(w[0].max_attempts, 12, 'and the attempt cap');
    ok((w[0].fire_at as number) > Date.now() + 290_000, 'and a fire time 300s out');
    return 'parseable standby, not a regex-scraped summary';
  });

  await check('finish(waiting) with no wake condition parks instead of waiting forever', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel(() => finishTurn('Waiting.', 'waiting'));
    const v = await start(runner(m, exec), 'bad standby');
    eq(v.status, 'needs_human', 'parked');
    eq(runs.wakeups(v.id).length, 0, 'no wakeup scheduled');
    return 'nothing to wake on → needs_human, not a run that sleeps forever';
  });

  await check('a malformed finish is an error the model can correct, not a silent success', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('finish', { status: 'triumphant' }, false)]) : finishTurn(),
    );
    const v = await start(runner(m, exec), 'bad finish');
    eq(v.status, 'done', 'the corrected finish landed');
    ok(
      v.steps.some((s) => s.tool === 'finish' && s.isError),
      'and the rejection is in the log',
    );
    ok(!FinishSchema.safeParse({ status: 'triumphant' }).success, 'the schema rejects it');
    return 'zod-validated; a bad finish never reads as a completed run';
  });

  await check('a run that ends without finish is parked, not recorded as success', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel(() => ({
      content: [{ type: 'text', text: 'I think that is everything!', citations: null }] as never,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const v = await start(runner(m, exec), 'no finish');
    eq(v.status, 'needs_human', 'parked');
    ok(/stopped calling tools|without a `finish`/.test(v.haltReason ?? ''), v.haltReason ?? 'no reason');
    return v.haltReason!;
  });

  // ══ The run log (PRD §8.5) ════════════════════════════════════════════════

  await check('every step persists action, target, result, and its screenshot', async () => {
    const exec = new FakeExecutor({ target: { element: el('AXButton', 'Save') } });
    const m = new ScriptedModel((t) =>
      t === 0 ? turn([toolUse('screenshot', {}), toolUse('type', { text: 'hello' })]) : finishTurn(),
    );
    const v = await start(runner(m, exec), 'log');

    const stored = runs.steps(v.id);
    ok(stored.length >= 3, `steps persisted (${stored.length})`);
    const shot = stored.find((s) => s.tool === 'screenshot')!;
    ok(shot.framePath != null, 'the screenshot has a frame path');
    eq(fs.existsSync(shot.framePath!), true, 'and the file is on disk');
    const typed = stored.find((s) => s.tool === 'type')!;
    eq((typed.input as { text: string }).text, 'hello', 'the input round-trips');
    eq(typed.result, 'OK', 'the result round-trips');
    ok(typed.verdict != null, 'the verdict round-trips');
    return `${stored.length} steps, ${stored.filter((s) => s.framePath).length} with screenshots`;
  });

  await check('run frames live outside the frame vault, so the daily purge cannot take them', async () => {
    const exec = new FakeExecutor();
    const m = new ScriptedModel((t) => (t === 0 ? turn([toolUse('screenshot', {})]) : finishTurn()));
    const v = await start(runner(m, exec), 'vault');
    const shot = runs.steps(v.id).find((s) => s.framePath)!;
    ok(!shot.framePath!.startsWith(paths.frames()), 'not in the frame vault');
    ok(shot.framePath!.includes(path.join('runs', String(v.id))), 'filed with the run');
    // And deleting the run takes them with it.
    runs.delete(v.id);
    eq(fs.existsSync(shot.framePath!), false, 'deleting the run deletes its screenshots');
    eq(runs.get(v.id), undefined, 'and the row');
    return 'runs/<id>/ — kept with the run, deleted with the run';
  });

  await check('an interrupted run is parked at launch rather than showing as live', async () => {
    getDb()
      .prepare(
        `INSERT INTO runs (started_at, profile, goal, status, steps, cost_usd) VALUES (?, 'attended', 'crashed', 'running', 3, 0.1)`,
      )
      .run(Date.now() - 60_000);
    const n = runs.reconcileOnLaunch();
    ok(n >= 1, 'at least the one we planted was reconciled');
    const stuck = getDb()
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")
      .get() as { n: number };
    eq(stuck.n, 0, 'nothing is left marked running');
    return `${n} interrupted run(s) parked`;
  });

  await check('an accelerator Electron will not parse is rewritten, not lost', () => {
    eq(normalizeAccelerator('Control+Shift+Period'), 'Control+Shift+.', 'Period → .');
    eq(normalizeAccelerator('Alt+Command+Period'), 'Alt+Command+.', 'the default abort spelling');
    eq(normalizeAccelerator('Alt+Command+.'), 'Alt+Command+.', 'an already-valid one is untouched');
    eq(normalizeAccelerator('Cmd+Opt+Space'), 'Command+Alt+Space', 'modifier aliases too');
    eq(normalizeAccelerator('Control+Shift+F13'), 'Control+Shift+F13', 'an unknown token passes through to fail loudly');
    const s = settings.update({ abortHotkey: 'Control+Shift+Period' });
    eq(s.abortHotkey, 'Control+Shift+.', 'and settings normalize on the way in');
    settings.update({ abortHotkey: 'Alt+Command+.' });
    return 'a kill switch is not allowed to fail on a spelling';
  });

  // ══ The sidecar seam (PRD §6.4) ═══════════════════════════════════════════
  //
  // The real buddyd, over the real RPC. What runs here depends on what this
  // machine has granted, and the report says which — a check that silently
  // degrades to nothing is worse than one that says it was skipped.

  await withSidecar(async (rpc, grants, notes) => {
    await check('buddyd speaks the M2 RPC surface', async () => {
      const info = await rpc('ping', {});
      eq(typeof info.version, 'string', 'ping answers');
      for (const method of ['target_info', 'watch_input', 'unwatch_input']) {
        const r = await rpc(method, {}).catch((e: Error) => ({ __err: e.message }) as never);
        const err = (r as { __err?: string }).__err ?? '';
        ok(!/unknown method/.test(err), `${method} exists (got: ${err || 'ok'})`);
      }
      return `buddyd ${info.version}: target_info, watch_input, unwatch_input all present`;
    });

    await check('the input vocabulary is exactly the 17 toolset members', async () => {
      for (const action of COMPUTER_ACTIONS) {
        const err = await rpcErr(rpc, 'input', { action, coordinate: [1, 1], text: 'a', scroll_direction: 'down' });
        ok(!/unknown action/.test(err ?? ''), `${action} is in the vocabulary`);
      }
      const bogus = await rpcErr(rpc, 'input', { action: 'teleport' });
      ok(/unknown action: teleport/.test(bogus ?? ''), 'an action outside the set is a protocol error');
      return '17 members accepted; anything else is -32602';
    });

    await check('screenshot and zoom are routed to the capture path, not to input', async () => {
      for (const action of ['screenshot', 'zoom']) {
        const err = await rpcErr(rpc, 'input', { action });
        ok(/served by the capture path/.test(err ?? ''), `${action} is not served by input`);
      }
      return 'one piece of code owns the scale factor';
    });

    await check('key combinations parse before any permission gate', async () => {
      // Valid combos must not be rejected as malformed; the only thing that may
      // stop them is a permission, which is a different error.
      for (const combo of ['Return', 'cmd+s', 'ctrl+shift+Tab', 'cmd+shift+4', 'Page_Down', '?']) {
        const err = await rpcErr(rpc, 'input', { action: 'key', text: combo });
        ok(!/unknown key|not a modifier/.test(err ?? ''), `"${combo}" parses (got: ${err ?? 'ok'})`);
      }
      for (const [combo, expected] of [
        ['flurb', 'unknown key'],
        ['wibble+s', 'not a modifier'],
      ] as const) {
        const err = await rpcErr(rpc, 'input', { action: 'key', text: combo });
        ok(new RegExp(expected).test(err ?? ''), `"${combo}" → ${expected} (got: ${err})`);
      }
      const noText = await rpcErr(rpc, 'input', { action: 'key' });
      ok(/requires `text`/.test(noText ?? ''), 'a missing key is a protocol error');
      return 'X11 keysym names, modifiers, and shifted characters, all before the TCC gate';
    });

    await check('a coordinate is required where the toolset requires one', async () => {
      eq(await rpcErr(rpc, 'input', { action: 'mouse_move' }), 'coordinate is required', 'mouse_move');
      ok(
        /start_coordinate is required/.test(
          (await rpcErr(rpc, 'input', { action: 'left_click_drag', coordinate: [1, 1] })) ?? '',
        ),
        'left_click_drag',
      );
      ok(
        /scroll_direction/.test((await rpcErr(rpc, 'input', { action: 'scroll', coordinate: [1, 1] })) ?? ''),
        'scroll',
      );
      return 'malformed requests are -32602, whatever is granted';
    });

    await check('input without Accessibility is a named error, not a silent no-op', async () => {
      if (grants.accessibility) skip('Accessibility IS granted, so there is no ungranted path to check.');
      const err = await rpcErr(rpc, 'input', { action: 'mouse_move', coordinate: [10, 10] });
      ok(/accessibility_not_granted/.test(err ?? ''), `named error, got: ${err}`);
      const tap = await rpcErr(rpc, 'watch_input', {});
      ok(/accessibility_not_granted/.test(tap ?? ''), 'and the takeover tap says so too');
      return 'the model is told delivery failed rather than believing it clicked';
    });

    await check('real CGEvent dispatch moves the pointer', async () => {
      if (!grants.accessibility) {
        skip('Accessibility is not granted to this buddyd, so no CGEvent can be posted.');
      }
      const before = await rpc('input', { action: 'cursor_position' });

      // This is the one check that asserts on global machine state: a hand on
      // the real mouse between the move and the read fails it, and that is not
      // a coordinate bug. A genuine translation bug misses every attempt, so
      // retry and fail only if it never lands. (Seen in the wild: expected 420,
      // got 652, while direct dispatch was landing 5/5 exactly.)
      let after = { x: -1, y: -1 };
      let landed = false;
      const attempts = 3;
      for (let i = 0; i < attempts && !landed; i++) {
        await rpc('input', { action: 'mouse_move', coordinate: [420, 240] });
        after = await rpc('input', { action: 'cursor_position' });
        landed = after.x === 420 && after.y === 240;
      }
      ok(landed, `the pointer is where we put it (last read ${after.x},${after.y})`);

      await rpc('input', { action: 'mouse_move', coordinate: [before.x, before.y] });
      return `pointer moved ${before.x},${before.y} → 420,240 and back`;
    });

    await check('the human-takeover event tap starts and stops', async () => {
      if (!grants.accessibility) skip('Accessibility is not granted, so the event tap cannot be created.');
      eq((await rpc('watch_input', {})).watching, true, 'tap started');
      eq((await rpc('unwatch_input', {})).watching, false, 'tap stopped');
      return 'listen-only tap on the session tap, filtered by BUDDY_MAGIC';
    });

    await check('the event tap ignores buddy’s own events but sees another process’s', async () => {
      if (!grants.accessibility) skip('Accessibility is not granted, so the event tap cannot be created.');

      // F19 has no default binding anywhere in macOS. It is the one keystroke
      // that can be synthesized on someone's real machine without doing
      // anything to it.
      const before = await rpc('input', { action: 'cursor_position' });
      await rpc('watch_input', {});
      // The tap deliberately ignores everything for its first 0.6s, so the
      // Return that confirmed the run in the HUD is not read as the user taking
      // over from it. Wait that out, or both halves of this check pass
      // vacuously — which is exactly what happened the first time it was
      // written.
      await new Promise((r) => setTimeout(r, 900));
      notes.length = 0;

      await rpc('input', { action: 'key', text: 'F19' });
      await new Promise((r) => setTimeout(r, 350));
      eq(
        notes.filter((n) => n.method === 'human_input').length,
        0,
        'buddy’s own keystroke did NOT trip the takeover switch',
      );

      // Now the same keystroke from a different process, which carries no
      // BUDDY_MAGIC. This is what a human hand looks like to the tap.
      await new Promise<void>((resolve) => {
        const osa = spawn('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 80']);
        osa.on('exit', () => resolve());
        osa.on('error', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 450));
      const fired = notes.filter((n) => n.method === 'human_input');
      await rpc('unwatch_input', {});
      await rpc('input', { action: 'mouse_move', coordinate: [before.x, before.y] });

      ok(fired.length >= 1, `an untagged keystroke DID trip it (got ${fired.length} notifications)`);
      eq(fired[0].params.kind, 'key', 'and it is reported as a key');
      return 'BUDDY_MAGIC discriminates: own events filtered, another process’s caught';
    });

    await check('target_info reads the real accessibility tree', async () => {
      if (!grants.accessibility) skip('Accessibility is not granted, so there is no AX tree to read.');
      const t = await rpc('target_info', { x: 12, y: 8 });
      ok(typeof t.bundleId === 'string' && t.bundleId.length > 0, `a frontmost app was identified: ${t.bundleId}`);
      ok('focused' in t && 'url' in t && 'element' in t, 'all three guardrail signals are present');
      // (12, 8) is the menu bar, which every app has and nothing destructive
      // lives on.
      ok(t.element === null || typeof t.element.role === 'string', 'the hit test returns an element or null');
      return `frontmost ${t.appName || t.bundleId}; element at 12,8 → ${t.element?.role ?? 'none'}`;
    });

    await check('capture reports the scale factor and the display origin', async () => {
      if (!grants.screenRecording) skip('Screen Recording is not granted to this buddyd.');
      const out = path.join(tmp, 'cap.png');
      const r = await rpc('capture', { path: out, target: 'display' });
      ok(typeof r.scale === 'number', 'scale is present');
      ok(typeof r.originX === 'number' && typeof r.originY === 'number', 'origin is present');
      eq(fs.existsSync(out), true, 'the PNG was written');
      const expected = Math.min(1, 2576 / Math.max(r.logicalWidth, r.logicalHeight), Math.sqrt(3_750_000 / (r.logicalWidth * r.logicalHeight)));
      eq(Number(r.scale.toFixed(6)), Number(expected.toFixed(6)), 'scale matches the §6.2 formula');
      return `${r.width}x${r.height} @ scale ${r.scale} from ${r.logicalWidth}x${r.logicalHeight}, origin ${r.originX},${r.originY}`;
    });
  });

  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => r.state === 'fail');
  const skipped = results.filter((r) => r.state === 'skip');
  const ran = results.filter((r) => r.state !== 'skip');
  const pad = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: '✓', fail: '✗', skip: '–' } as const;

  let report =
    '\nM2 checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${ran.length - failed.length}/${ran.length} passed`;
  if (skipped.length) {
    report +=
      `, ${skipped.length} skipped\n\n` +
      'Skipped because of what this machine has or has not granted — the\n' +
      'reason is on each line. Nothing skipped is a failure, and nothing\n' +
      'skipped is counted as a pass.\n';
  } else {
    report += '\n';
  }
  report +=
    '\nNever covered here: a live model call. The loop is exercised through a\n' +
    'scripted ModelClient — see README "What M2 verifies".\n\n';

  // Same reason as M1: `app.exit()` waits on Electron's network-service
  // teardown, which took minutes on a run whose checks finished in milliseconds.
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const baseTarget = (): TargetInfo => ({
  bundleId: 'com.apple.TextEdit',
  appName: 'TextEdit',
  pid: 42,
  windowTitle: 'Untitled',
  secureInput: false,
  focused: null,
  url: null,
  element: null,
});

const el = (role: string, title: string) => ({
  role,
  subrole: '',
  title,
  description: '',
  value: '',
  help: '',
  isSecureTextField: false,
});

const sendEl = () => el('AXButton', 'Send');

/** The tool_result blocks of a request's newest user message — where a batch's
 *  results land, and the only place they are allowed to land. */
function resultsOf(req: Anthropic.Messages.MessageCreateParamsNonStreaming): Record<string, unknown>[] {
  const last = req.messages[req.messages.length - 1];
  ok(last.role === 'user', 'the newest message is the user results message');
  return (last.content as unknown as Record<string, unknown>[]).filter((b) => b.type === 'tool_result');
}

/**
 * Start a long-running run and fire a kill switch part-way through, then assert
 * on what actually happened. "A kill switch that was never fired mid-run is not
 * tested" — so the switch fires while the loop is genuinely between turns with
 * more scripted work queued behind it.
 */
async function killDuringRun(
  fire: (r: AgentRunner) => void,
): Promise<{ view: RunView; dispatched: number; turns: number }> {
  const exec = new FakeExecutor();
  const kill = new KillSwitches();
  let turns = 0;
  let r!: AgentRunner;
  const m = new ScriptedModel((t) => {
    turns = t + 1;
    if (t === 2) setImmediate(() => fire(r));
    // Twenty turns of work queued behind the kill: a run that stops because it
    // ran out of script proves nothing.
    return t < 20 ? turn([toolUse('left_click', { coordinate: [1, 1] })]) : finishTurn();
  });
  r = runner(m, exec, kill);
  const view = await start(r, 'a long run', 'attended', { maxSteps: 500 });
  return { view, dispatched: exec.dispatched.length, turns };
}

// ── The real sidecar, over the real RPC ──────────────────────────────────────

type Rpc = (method: string, params: Record<string, unknown>) => Promise<any>;

/** Notifications buddyd pushed, newest last. `human_input` is the one that
 *  matters: it is kill switch 3's entire signal. */
type Notes = { method: string; params: any }[];

/** The error message from a call that is expected to fail, or null if it did
 *  not. Reads better at the call site than a try/catch per assertion. */
async function rpcErr(rpc: Rpc, method: string, params: Record<string, unknown>): Promise<string | null> {
  try {
    await rpc(method, params);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Spawns the real `buddyd` for the duration of `fn`. If the binary is missing
 *  the sidecar checks are recorded as failures rather than skipped silently —
 *  `npm run build:sidecar` is one command and an unbuilt sidecar is a broken
 *  build, not an environment quirk. */
async function withSidecar(
  fn: (
    rpc: Rpc,
    grants: { accessibility: boolean; screenRecording: boolean },
    notes: Notes,
  ) => Promise<void>,
) {
  const bin = path.join(process.cwd(), 'sidecar', 'build', 'buddyd');
  if (!fs.existsSync(bin)) {
    results.push({
      name: 'buddyd is built',
      state: 'fail',
      detail: `not found at ${bin} — run: npm run build:sidecar`,
    });
    return;
  }

  const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const notes: Notes = [];
  let id = 1;
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id == null && msg.method) {
        notes.push({ method: msg.method, params: msg.params ?? {} });
        continue;
      }
      const p = msg.id != null ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });

  const rpc: Rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = id++;
      pending.set(mine, { resolve, reject });
      // hold_key and wait can legitimately take a while; nothing here does.
      const t = setTimeout(() => {
        pending.delete(mine);
        reject(new Error(`timed out: ${method}`));
      }, 20_000);
      t.unref?.();
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
    });

  try {
    await new Promise((r) => setTimeout(r, 400));
    const grants = await rpc('permissions', {});
    await fn(rpc, grants, notes);
  } finally {
    proc.kill('SIGKILL');
  }
}

app.whenReady().then(run);
