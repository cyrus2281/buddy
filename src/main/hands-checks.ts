/**
 * Hands-off checks, run against the real modules.
 *
 *   npm run check:hands
 *
 * Same shape as the milestone checks: inside Electron, against a throwaway
 * userData directory. Three layers, each as real as it can be without lying
 * about what it proves:
 *
 *   1. **The tool surface, the prompt and the guardrails** — pure, so every
 *      rule is asserted directly against the real classifier.
 *   2. **The loop** — the real `AgentRunner` and the real `Executor`, with the
 *      model scripted and buddyd's hands-off RPCs answered by a fake at the
 *      supervisor boundary, which records exactly what would have reached the
 *      machine.
 *   3. **The real buddyd, against a real window** — a small window this
 *      process opens itself, behind everything, so a press and a value and a
 *      keystroke can be delivered for real and read back from the page without
 *      touching anything the person running the suite has open. Skipped, and
 *      said so, where Accessibility is not granted.
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, getDb, closeDb } from './store/db.js';
import { SCHEMA, SCHEMA_VERSION } from './store/schema.js';
import { runs } from './store/runs.js';
import { settings } from './settings.js';
import { sidecar, type AxActResult, type AxLook, type AppWindows } from './sidecar/supervisor.js';
import { AgentRunner } from './agent/runner.js';
import { Executor, parseRef, renderLook } from './agent/executor.js';
import { KillSwitches } from './agent/killswitch.js';
import { classify, type TargetInfo, type AxElement } from './agent/guardrails.js';
import { operator } from './agent/orchestrator.js';
import { runContext } from './agent/context.js';
import { buildHandsOffTools, COMPUTER_TOOLSET_NAME, HANDS_OFF_TOOLS } from './agent/tools.js';
import { buildSystemPrompt } from './agent/prompt.js';
import type { ModelClient, ModelResponse } from './agent/client.js';
import type { Allowlist, RunProfile } from '../shared/types.js';

// The suite opens one window of its own and closes it before reporting.
// Electron's default for the last window closing is to quit — which it did,
// mid-teardown, with exit code 0 and no report.
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hands-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };
const results: Result[] = [];
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

class ScriptedModel implements ModelClient {
  turn = 0;
  requests: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  constructor(
    private script: (turn: number, req: Anthropic.Messages.MessageCreateParamsNonStreaming) => ModelResponse,
  ) {}
  async create(req: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    this.requests.push(structuredClone(req) as typeof req);
    return this.script(this.turn++, req);
  }
}

let nextId = 1;
const call = (name: string, input: unknown, toolset = false): Anthropic.Messages.ContentBlock =>
  ({
    type: 'tool_use',
    id: `toolu_${nextId++}`,
    name,
    input,
    caller: { type: 'direct' },
    ...(toolset ? { toolset_name: COMPUTER_TOOLSET_NAME } : {}),
  }) as Anthropic.Messages.ContentBlock;
const turn = (content: Anthropic.Messages.ContentBlock[]): ModelResponse => ({
  content,
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});
const finish = (summary = 'Done.', status: 'done' | 'waiting' | 'needs_human' = 'done', wake?: unknown) =>
  turn([call('finish', { status, summary, ...(wake ? { wake } : {}) })]);

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const SLACK = 'com.tinyspeck.slackmacgap';
const ALLOW: Allowlist = { apps: [SLACK, 'com.apple.TextEdit'], domains: ['notion.so'] };

const el = (over: Partial<AxElement> = {}): AxElement => ({
  role: 'AXButton',
  subrole: '',
  title: '',
  description: '',
  value: '',
  help: '',
  isSecureTextField: false,
  ...over,
});

const target = (over: Partial<TargetInfo> = {}): TargetInfo => ({
  bundleId: SLACK,
  appName: 'Slack',
  pid: 77,
  windowTitle: '#sam-eng',
  secureInput: false,
  focused: null,
  url: null,
  element: null,
  ...over,
});

/**
 * buddyd's hands-off surface, faked at the supervisor boundary. Everything
 * above it — the executor's classify-then-dispatch, the runner, the guardrails
 * — is the shipping code. Records every call so the checks can say what would
 * have reached the machine, and that the pointer path never did.
 */
class FakeHands {
  calls: { method: string; params: unknown }[] = [];
  elements = new Map<number, { app: string; element: AxElement }>([
    [12, { app: SLACK, element: el({ title: 'Send' }) }],
    [14, { app: SLACK, element: el({ role: 'AXTextArea', description: 'Message #sam-eng' }) }],
    [15, { app: SLACK, element: el({ role: 'AXSecureTextField', isSecureTextField: true, title: 'Password' }) }],
    [20, { app: 'com.apple.TextEdit', element: el({ title: 'Bold' }) }],
  ]);
  stale = new Set<number>();
  verifyValues = true;
  private saved: Partial<Record<keyof typeof sidecar, unknown>> = {};

  install() {
    const s = sidecar as unknown as Record<string, unknown>;
    for (const k of ['axTarget', 'axAct', 'axLook', 'keysToApp', 'openApp', 'appWindows', 'capture', 'input', 'targetInfo', 'axTree'] as const) {
      this.saved[k as keyof typeof sidecar] = s[k];
    }
    s.axTarget = async (p: { ref?: number; bundleId?: string }) => {
      this.calls.push({ method: 'ax_target', params: p });
      if (p.ref != null) {
        if (this.stale.has(p.ref) || !this.elements.has(p.ref)) {
          throw new Error(`stale_element: e${p.ref} is not from a recent reading of the window. Look at the window again. (code -32602)`);
        }
        const e = this.elements.get(p.ref)!;
        return target({ bundleId: e.app, appName: e.app === SLACK ? 'Slack' : 'TextEdit', element: e.element });
      }
      return target({ bundleId: p.bundleId ?? '', appName: p.bundleId === SLACK ? 'Slack' : p.bundleId ?? '' });
    };
    s.axAct = async (p: { ref: number; action: string; value?: string }): Promise<AxActResult> => {
      this.calls.push({ method: 'ax_act', params: p });
      const e = this.elements.get(p.ref)!;
      return {
        ok: true,
        ref: p.ref,
        action: p.action,
        role: e.element.role,
        title: e.element.title || e.element.description,
        ...(p.action === 'set_value'
          ? { value: this.verifyValues ? p.value : '', verified: this.verifyValues }
          : {}),
        stoleFocus: false,
        tookFocusTo: '',
        restoredFocus: false,
        pointerMoved: false,
      };
    };
    s.axLook = async (p: { bundleId: string }): Promise<AxLook> => {
      this.calls.push({ method: 'ax_look', params: p });
      return {
        pid: 77,
        bundleId: p.bundleId,
        appName: 'Slack',
        active: false,
        windowTitle: '#sam-eng',
        minimized: false,
        truncated: false,
        windowId: 9001,
        tree: {
          role: 'AXWindow',
          title: '#sam-eng',
          id: 10,
          children: [
            { role: 'AXTextArea', description: 'Message #sam-eng', id: 14, frame: { x: 1, y: 2, w: 3, h: 4 } },
            { role: 'AXButton', title: 'Send', id: 12 },
          ],
        },
      };
    };
    s.keysToApp = async (p: { bundleId: string; key?: string; text?: string }) => {
      this.calls.push({ method: 'keys_to_app', params: p });
      return { ok: true, stoleFocus: false, characters: p.text?.length, key: p.key };
    };
    s.openApp = async (p: { bundleId: string }) => {
      this.calls.push({ method: 'open_app', params: p });
      return { ok: true, pid: 99, appName: p.bundleId };
    };
    s.appWindows = async (): Promise<{ apps: AppWindows[] }> => {
      this.calls.push({ method: 'app_windows', params: {} });
      return {
        apps: [
          { pid: 1, bundleId: 'com.microsoft.VSCode', appName: 'Code', active: true, hidden: false, bundlePath: '', windows: [{ title: 'runner.ts — buddy', minimized: false, fullscreen: false, main: true, focused: true, subrole: 'AXStandardWindow' }] },
          { pid: 77, bundleId: SLACK, appName: 'Slack', active: false, hidden: false, bundlePath: '', windows: [{ title: '#sam-eng', minimized: false, fullscreen: false, main: true, focused: true, subrole: 'AXStandardWindow' }] },
        ],
      };
    };
    s.capture = async (p: { path: string; target?: string }) => {
      this.calls.push({ method: `capture:${p.target ?? 'display'}`, params: p });
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, Buffer.from(ONE_PIXEL_PNG, 'base64'));
      return { path: p.path, width: 640, height: 480, scale: 1, originX: 100, originY: 80, displayId: 1 };
    };
    // The pointer path. A hands-off run must never reach any of these.
    s.input = async (p: unknown) => {
      this.calls.push({ method: 'input', params: p });
      return {};
    };
    s.targetInfo = async (p: unknown) => {
      this.calls.push({ method: 'target_info', params: p });
      return target();
    };
    s.axTree = async (p: unknown) => {
      this.calls.push({ method: 'ax_tree', params: p });
      return { tree: {} };
    };
  }

  restore() {
    const s = sidecar as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(this.saved)) s[k] = v;
  }

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

function runner(model: ModelClient, kill = new KillSwitches()) {
  return new AgentRunner({ client: model, executor: new Executor(), killSwitches: kill });
}

const handsOffRun = (r: AgentRunner, goal: string, profile: RunProfile = 'attended', allowlist = ALLOW) =>
  r.run({ goal, profile, allowlist, handsOff: true });

/** Every tool_result block the runner sent, in order. */
function toolResults(m: ScriptedModel): Record<string, unknown>[] {
  const last = m.requests[m.requests.length - 1];
  const out: Record<string, unknown>[] = [];
  for (const msg of last?.messages ?? []) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content as unknown as Record<string, unknown>[]) if (b.type === 'tool_result') out.push(b);
  }
  return out;
}
const textOf = (b: Record<string, unknown>) =>
  ((b.content as { type: string; text?: string }[]) ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n');

// ── The checks ───────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());

  // ══ Schema — before anything opens the database the normal way ═══════════

  await check('a v2 database gains runs.hands_off and keeps its runs', () => {
    // v2 is today's schema without the one column v3 added.
    const v2 = SCHEMA.replace(/,\s*-- Hands-off[^\n]*\n\s*hands_off\s+INTEGER NOT NULL DEFAULT 0/, '');
    ok(v2 !== SCHEMA, 'the v2 shape was derived (the column is where this check expects it)');
    const raw = new Database(paths.db());
    raw.exec(v2);
    raw.pragma('user_version = 2');
    raw.prepare(`INSERT INTO runs (started_at, profile, goal, status) VALUES (1, 'attended', 'old run', 'done')`).run();
    raw.close();

    openDb();
    const db = getDb();
    eq(db.pragma('user_version', { simple: true }), SCHEMA_VERSION, 'migrated to the current version');
    const row = db.prepare(`SELECT goal, hands_off FROM runs`).get() as { goal: string; hands_off: number };
    eq(row.goal, 'old run', 'the v2 run survived');
    eq(row.hands_off, 0, 'and reads as a normal run');
    return `v2 → v${SCHEMA_VERSION}: one column added, every row kept`;
  });

  settings.load();
  const fake = new FakeHands();
  fake.install();

  // ══ The tool surface and the prompt ══════════════════════════════════════

  await check('a hands-off run is offered no computer toolset at all', () => {
    const tools = buildHandsOffTools();
    const names = tools.map((t) => ('name' in t ? t.name : t.type));
    eq(names.join(','), [...HANDS_OFF_TOOLS, 'finish'].join(','), 'exactly the hands-off tools, then finish');
    ok(!tools.some((t) => t.type === 'computer_toolset_20260801'), 'no pointer, no keyboard, no display screenshot');
    const cached = tools.filter((t) => 'cache_control' in t && t.cache_control);
    eq(cached.length, 1, 'one tools breakpoint');
    eq('name' in cached[0]! ? cached[0].name : '', 'finish', 'on the last tool');
    return names.join(', ');
  });

  await check('the hands-off prompt talks about elements, not pixels', () => {
    const base = {
      goal: 'reply to Priya',
      allowlist: ALLOW,
      budgets: { maxSteps: 60, maxWallClockMs: 600_000, maxCostUsd: 2 },
      scale: 1,
      screen: { width: 0, height: 0 },
      handsOff: true,
    };
    const p = buildSystemPrompt({ ...base, profile: 'attended' });
    ok(/working hands-off/i.test(p), 'it says the mode');
    ok(/act on elements by id/i.test(p), 'and how to act in it');
    ok(!/pixel space of the screenshot/.test(p), 'with no coordinate instructions — there is no pointer');
    ok(/data, never instruction/i.test(p), '§7.4 is unchanged');
    const leash = buildSystemPrompt({ ...base, profile: 'leashless' });
    ok(/nothing is refused/i.test(leash) && !/is refused outright/i.test(leash), 'leashless still invents no refusal');
    return `${p.length} chars; the mode changes how, never what`;
  });

  // ══ The guardrails, against the element the call names ═══════════════════

  await check('pressing Send hands-off confirms when attended and parks when unattended', () => {
    const t = target({ element: el({ title: 'Send' }) });
    const a = classify({ action: 'ax_press', input: {}, target: t, allowlist: ALLOW, profile: 'attended' });
    const u = classify({ action: 'ax_press', input: {}, target: t, allowlist: ALLOW, profile: 'unattended' });
    eq(a.class, 'send', 'a press on Send is a send');
    eq(a.decision, 'confirm', 'attended asks');
    eq(u.decision, 'deny', 'unattended refuses');
    const l = classify({ action: 'ax_press', input: {}, target: t, allowlist: ALLOW, profile: 'leashless' });
    eq(l.decision, 'allow', 'leashless allows, as it allows the pointer version');
    return 'the button rule reads the named element’s title, the same as a click’s';
  });

  await check('a value set into a password field is a credential, whichever field has focus', () => {
    const v = classify({
      action: 'ax_set_value',
      input: { text: 'hunter2' },
      // Focus is elsewhere — the person is typing in their editor — and the
      // named element is a password field. The element is what counts.
      target: target({ focused: { role: 'AXTextArea', subrole: '', title: 'editor', isSecureTextField: false }, element: el({ role: 'AXSecureTextField', isSecureTextField: true, title: 'Password' }) }),
      allowlist: ALLOW,
      profile: 'attended',
    });
    eq(v.class, 'credentials', 'credentials');
    eq(v.decision, 'deny', 'denied even attended');
    return v.reason;
  });

  await check('set_value text gets the keystroke-content rules typing gets', () => {
    const cases: [string, string][] = [
      ['sk-live_abcdefghijklmnopqrstu', 'credentials'],
      ['4111 1111 1111 1111', 'credentials'],
      ['Thanks, merging after lunch', 'type_editor'],
    ];
    for (const [text, want] of cases) {
      const v = classify({ action: 'ax_set_value', input: { text }, target: target({ element: el({ role: 'AXTextArea' }) }), allowlist: ALLOW, profile: 'attended' });
      eq(v.class, want, `"${text.slice(0, 12)}…"`);
    }
    return 'keys and cards are refused; prose is typing';
  });

  await check('Return sent to a chat app in the background is a send', () => {
    const v = classify({ action: 'key', input: { text: 'Return' }, target: target(), allowlist: ALLOW, profile: 'unattended' });
    eq(v.class, 'send', 'send');
    eq(v.decision, 'deny', 'refused unattended');
    const shift = classify({ action: 'key', input: { text: 'shift+Return' }, target: target(), allowlist: ALLOW, profile: 'unattended' });
    eq(shift.class, 'type_editor', 'shift+Return is a line break');
    return 'the app is the one the keys go to, not the one in front';
  });

  await check('opening an app or a site off the list gates, and an installer is an install', () => {
    const offApp = classify({ action: 'ax_open', input: {}, target: target({ bundleId: 'com.spotify.client', appName: 'Spotify' }), allowlist: ALLOW, profile: 'attended' });
    eq(offApp.class, 'off_allowlist', 'an app not on the list');
    eq(offApp.decision, 'confirm', 'asks when attended');
    const site = classify({ action: 'ax_open', input: {}, target: target({ bundleId: 'com.apple.Safari', url: 'https://evil.example/x' }), allowlist: { ...ALLOW, apps: [...ALLOW.apps, 'com.apple.Safari'] }, profile: 'unattended' });
    eq(site.class, 'off_allowlist', 'a site not on the list');
    eq(site.decision, 'deny', 'refused unattended');
    const store = classify({ action: 'ax_open', input: {}, target: target({ bundleId: 'com.apple.AppStore' }), allowlist: ALLOW, profile: 'attended' });
    eq(store.class, 'install', 'the App Store is an install surface');
    return 'open is classified like every other action — by where it goes';
  });

  // ══ The loop ═════════════════════════════════════════════════════════════

  await check('a hands-off run opens on what is running, not on a picture of the display', async () => {
    fake.calls.length = 0;
    const m = new ScriptedModel(() => finish());
    const v = await handsOffRun(runner(m), 'reply to Priya');
    eq(fake.count('capture:display'), 0, 'no display screenshot');
    const opening = JSON.stringify(m.requests[0]!.messages[0]);
    ok(opening.includes(SLACK), 'the opening lists the running apps by bundle id');
    ok(opening.includes('in front: the person'), 'and marks the one that is the person’s');
    eq(v.handsOff, true, 'the view says hands-off');
    ok(v.steps.some((s) => s.tool === 'hands-off'), 'and the log opens with a line saying so');
    return 'the display is the person’s; the first look is aimed at an app';
  });

  await check('look returns the window and its tree with ids, as a custom tool result', async () => {
    fake.calls.length = 0;
    const m = new ScriptedModel((t) => (t === 0 ? turn([call('look', { app: SLACK })]) : finish()));
    await handsOffRun(runner(m), 'look at slack');
    const r = toolResults(m)[0]!;
    ok(!('toolset_name' in r), 'no toolset_name — it is not a computer toolset member');
    const content = r.content as { type: string; text?: string }[];
    eq(content[0]!.type, 'image', 'a picture of the window');
    ok(/e14 AXTextArea "Message #sam-eng"/.test(content[1]!.text ?? ''), 'and the tree, with ids');
    ok(!/@\d+,\d+/.test(content[1]!.text ?? ''), 'and no coordinates — there is nothing to aim');
    ok(/in the background; it stays there/.test(content[1]!.text ?? ''), 'it says the app stays behind');
    eq(fake.count('capture:window'), 1, 'photographed by window id');
    return 'one look: one window, one tree';
  });

  await check('act and set_value go through accessibility, never through input', async () => {
    fake.calls.length = 0;
    const m = new ScriptedModel((t) =>
      t === 0
        ? turn([call('set_value', { element: 'e14', text: 'Merging after lunch' }), call('act', { element: 'e20', action: 'press' })])
        : finish(),
    );
    const v = await handsOffRun(runner(m), 'reply', 'attended');
    eq(fake.count('input'), 0, 'the pointer and keyboard path was never called');
    eq(fake.count('target_info'), 0, 'nor the frontmost-app hit test');
    const acts = fake.calls.filter((c) => c.method === 'ax_act').map((c) => c.params as { ref: number; action: string });
    eq(acts.map((a) => `${a.action}:${a.ref}`).join(','), 'set_value:14,press:20', 'both dispatched by element');
    ok(/now reads what you set/.test(textOf(toolResults(m)[0]!)), 'the value was verified');
    eq(v.status, 'done', 'and the run finished');
    return 'e14 filled, e20 pressed; input() called 0 times';
  });

  await check('the guardrail is told the app buddy acts in, not the app in front', async () => {
    fake.calls.length = 0;
    // TextEdit is NOT on this run's list; Slack is. The press names a TextEdit
    // element, so it is off the allowlist — whatever is frontmost.
    const m = new ScriptedModel((t) => (t === 0 ? turn([call('act', { element: 'e20', action: 'press' })]) : finish()));
    const v = await handsOffRun(runner(m), 'bold it', 'unattended', { apps: [SLACK], domains: [] });
    eq(v.status, 'needs_human', 'parked');
    const blocked = v.steps.find((s) => s.verdict?.decision === 'deny');
    eq(blocked?.verdict?.class, 'off_allowlist', 'off the allowlist');
    eq(blocked?.verdict?.appKey, 'com.apple.TextEdit', 'judged against TextEdit, the app the element is in');
    eq(fake.count('ax_act'), 0, 'and nothing was pressed');
    return v.haltReason ?? '';
  });

  await check('a gate approved at the HUD re-dispatches through the hands-off path', async () => {
    fake.calls.length = 0;
    const m = new ScriptedModel((t) => (t === 0 ? turn([call('act', { element: 'e12', action: 'press' })]) : finish()));
    const r = runner(m);
    r.on('gate', () => setImmediate(() => r.resolveGate('approve')));
    const v = await handsOffRun(r, 'send it', 'attended');
    eq(fake.count('ax_act'), 1, 'pressed exactly once, after the approval');
    const press = fake.calls.find((c) => c.method === 'ax_act')!.params as { ref: number };
    eq(press.ref, 12, 'the Send button');
    eq(v.status, 'done', 'and the run carried on');
    return 'confirm → approve → AXPress, with no pointer involved';
  });

  await check('a stale element is something the model can fix, not a crash', async () => {
    fake.calls.length = 0;
    fake.stale.add(14);
    const m = new ScriptedModel((t) => (t === 0 ? turn([call('set_value', { element: 'e14', text: 'hi' })]) : finish()));
    await handsOffRun(runner(m), 'reply');
    fake.stale.delete(14);
    const r = toolResults(m)[0]!;
    eq(r.is_error, true, 'an error result');
    ok(/Look at the window again/.test(textOf(r)), `with the fix in it: ${textOf(r)}`);
    ok(!/code -3/.test(textOf(r)), 'and without the RPC plumbing');
    return textOf(r);
  });

  await check('a value the app did not keep is reported, with the way around it', async () => {
    fake.calls.length = 0;
    fake.verifyValues = false;
    const m = new ScriptedModel((t) => (t === 0 ? turn([call('set_value', { element: 'e14', text: 'hi' })]) : finish()));
    await handsOffRun(runner(m), 'reply');
    fake.verifyValues = true;
    ok(/did not keep it\. Focus the field and use send_keys/.test(textOf(toolResults(m)[0]!)), 'says so and says what to do');
    return 'accepted by AX ≠ honoured by the page, and the model is told which';
  });

  await check('a computer action in a hands-off run is an unknown tool', async () => {
    fake.calls.length = 0;
    const m = new ScriptedModel((t) => (t === 0 ? turn([call('left_click', { coordinate: [10, 10] }, true)]) : finish()));
    await handsOffRun(runner(m), 'click');
    ok(/Unknown tool: left_click/.test(textOf(toolResults(m)[0]!)), 'reported');
    eq(fake.count('input'), 0, 'and never dispatched');
    return 'the toolset is not there to be reached for';
  });

  await check('the person using the machine is counted, never narrated as a takeover', async () => {
    const kill = new KillSwitches();
    const m = new ScriptedModel((t) => {
      if (t === 0) {
        kill.emit('human-input', { kind: 'key', t: Date.now() });
        kill.emit('human-input', { kind: 'click', t: Date.now() });
        return turn([call('look', { app: SLACK })]);
      }
      return finish();
    });
    const v = await handsOffRun(runner(m, kill), 'reply');
    ok(v.humanInputs >= 2, `counted (${v.humanInputs})`);
    ok(!v.steps.some((s) => s.tool === 'human-input'), 'no "you used the keyboard" line — that is the point of the mode');
    return `${v.humanInputs} inputs seen, 0 takeover notes`;
  });

  await check('a hands-off run that waits comes back hands-off', async () => {
    const m = new ScriptedModel((t) =>
      t === 0 ? finish('Asked Priya; waiting.', 'waiting', { after_s: 300, condition: 'Priya replied', max_attempts: 3 }) : finish(),
    );
    const v = await handsOffRun(runner(m), 'wait for priya');
    eq(v.status, 'waiting', 'parked waiting');
    const saved = runContext.load(v.id)!;
    eq(saved.handsOff, true, 'the saved context says hands-off');

    fake.calls.length = 0;
    const m2 = new ScriptedModel(() => finish('Replied.'));
    const r2 = runner(m2);
    const resumed = await r2.resume({
      runId: v.id,
      goal: saved.goal,
      profile: saved.profile,
      handsOff: saved.handsOff,
      allowlist: saved.allowlist,
      budgets: saved.budgets,
      messages: saved.messages,
      condition: 'Priya replied',
      why: 'a new message from Priya',
      attempt: 1,
      priorSteps: saved.priorSteps,
      priorCostUsd: saved.priorCostUsd,
      resumes: saved.resumes,
    });
    eq(resumed.handsOff, true, 'resumed hands-off');
    eq(fake.count('capture:display'), 0, 'without photographing the display');
    ok(JSON.stringify(m2.requests[0]!.messages).includes('still working hands-off'), 'and the model is told');
    ok((m2.requests[0]!.tools ?? []).every((t) => (t as { type?: string }).type !== 'computer_toolset_20260801'), 'with the hands-off tools');
    return 'standby keeps how the run was asked to work, as it keeps the profile';
  });

  await check('the run row and the Run Log record hands-off', async () => {
    const m = new ScriptedModel(() => finish());
    const v = await handsOffRun(runner(m), 'row');
    eq(runs.get(v.id)?.hands_off, 1, 'the row');
    eq(operator.history(5).find((h) => h.id === v.id)?.handsOff, true, 'and the history the Run Log reads');
    return 'visible after the fact, not only while it runs';
  });

  await check('element ids parse the ways a model writes them, and nothing else', () => {
    eq(parseRef('e42'), 42, '"e42"');
    eq(parseRef('E7'), 7, '"E7"');
    eq(parseRef(' 9 '), 9, '" 9 "');
    eq(parseRef(42), 42, '42');
    eq(parseRef('Send'), null, 'a title is not an id');
    eq(parseRef('e0'), null, 'ids start at 1');
    eq(parseRef(-3), null, 'no negatives');
    const text = renderLook({ pid: 1, bundleId: SLACK, appName: 'Slack', active: true, windowTitle: 'x', minimized: true, truncated: false, tree: { role: 'AXWindow', id: 3 } }, '(note)');
    ok(/in front/.test(text) && /minimised/.test(text) && /e3 AXWindow/.test(text), 'and a reading renders ids, state and notes');
    return 'e42 · E7 · 9 · 42';
  });

  fake.restore();

  // ══ The real buddyd, against a window this process owns ══════════════════

  let up = false;
  try {
    await sidecar.start();
    up = true;
  } catch (e) {
    log.warn('checks', 'buddyd did not start', { error: (e as Error).message });
  }
  const granted = up ? (await sidecar.permissions()).accessibility : false;
  const needs = () => {
    if (!up) skip('buddyd is not built — npm run build:sidecar');
    if (!granted) skip('Accessibility is not granted to this buddyd, so nothing can be pressed.');
  };

  await check('buddyd speaks the hands-off RPC surface', async () => {
    if (!up) skip('buddyd is not built — npm run build:sidecar');
    for (const method of ['app_windows', 'ax_look', 'ax_act', 'ax_target', 'keys_to_app', 'open_app']) {
      let err = '';
      try {
        await (sidecar as unknown as { require(): { call(m: string, p: unknown, t: number): Promise<unknown> } })
          .require()
          .call(method, {}, 5_000);
      } catch (e) {
        err = (e as Error).message;
      }
      ok(!/unknown method/.test(err), `${method} exists (got: ${err || 'ok'})`);
    }
    let stale = '';
    try {
      await sidecar.axAct({ ref: 987_654_321, action: 'press' });
    } catch (e) {
      stale = (e as Error).message;
    }
    ok(/stale_element|accessibility_not_granted/.test(stale), `an unknown element is named as stale: ${stale}`);
    return 'six methods; an id that was never issued is "stale", not a crash';
  });

  // A window of our own, behind everything, holding a button, a field and a
  // keystroke log. Everything below acts on it and reads the result back from
  // the page, so nothing the person running the suite has open is touched.
  let win: BrowserWindow | null = null;
  const page = async <T,>(js: string): Promise<T> => win!.webContents.executeJavaScript(js) as Promise<T>;
  let tree: AxLook | null = null;
  const find = (pred: (n: Record<string, unknown>) => boolean): number | null => {
    const walk = (n: unknown): number | null => {
      if (!n || typeof n !== 'object') return null;
      const o = n as Record<string, unknown>;
      if (pred(o) && typeof o.id === 'number') return o.id;
      for (const k of (o.children as unknown[]) ?? []) {
        const hit = walk(k);
        if (hit != null) return hit;
      }
      return null;
    };
    return walk(tree?.tree);
  };
  const named = (n: Record<string, unknown>, s: string) =>
    [n.title, n.description, n.value].some((v) => typeof v === 'string' && v.includes(s));

  if (up && granted) {
    app.setAccessibilitySupportEnabled(true);
    win = new BrowserWindow({ width: 420, height: 240, x: 40, y: 80, show: false, title: 'buddy hands-off check' });
    await win.loadURL(
      'data:text/html,' +
        encodeURIComponent(`<!doctype html><title>buddy hands-off check</title>
<body style="font:14px system-ui;padding:16px">
<button id="b" onclick="window.__pressed=(window.__pressed||0)+1">Press me hands-off</button>
<input id="f" aria-label="Hands-off field" oninput="window.__inputs=(window.__inputs||0)+1">
<input id="k" aria-label="Keys field">
</body>`),
    );
    win.showInactive();
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 0; i < 6 && !find((n) => n.role === 'AXButton' && named(n, 'Press me')); i++) {
      // Chromium builds the web tree lazily, on the first AX client's request.
      tree = await sidecar.axLook({ pid: process.pid, windowTitle: 'buddy hands-off check' });
      if (!find((n) => n.role === 'AXButton' && named(n, 'Press me'))) await new Promise((r) => setTimeout(r, 400));
    }
  }

  await check('a background button is pressed without moving the pointer or the focus', async () => {
    needs();
    const id = find((n) => n.role === 'AXButton' && named(n, 'Press me'));
    ok(id != null, 'the button is in the tree with an id');
    const front = (await sidecar.frontmost()).bundleId;
    const before = (await sidecar.input({ action: 'cursor_position' })) as { x: number; y: number };
    const r = await sidecar.axAct({ ref: id!, action: 'press', restoreFocus: false });
    await new Promise((res) => setTimeout(res, 150));
    const after = (await sidecar.input({ action: 'cursor_position' })) as { x: number; y: number };
    eq(await page<number>('window.__pressed || 0'), 1, 'the page saw exactly one press');
    eq(r.stoleFocus, false, 'the app in front did not change');
    eq((await sidecar.frontmost()).bundleId, front, `and it is still ${front}`);
    // Not "the pointer did not move": the person running this suite may be
    // using the mouse — which, in hands-off, is the point. What a pointer click
    // would leave behind is the pointer *on the button*; that is what must not
    // have happened.
    const b = win!.getBounds();
    const onWindow = (p: { x: number; y: number }) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    ok(onWindow(before) || !onWindow(after), `the pointer never went to the button (before ${before.x},${before.y} · after ${after.x},${after.y})`);
    const moved = Math.hypot(after.x - before.x, after.y - before.y) >= 2;
    return (
      `pressed e${id} in a window behind ${front}; the pointer ` +
      (moved ? `moved ${before.x},${before.y} → ${after.x},${after.y}, nowhere near the button — that was you` : `stayed at ${before.x},${before.y}`)
    );
  });

  await check('a background field takes a value through AX, and reads it back', async () => {
    needs();
    const id = find((n) => n.role === 'AXTextField' && named(n, 'Hands-off field'));
    ok(id != null, 'the field is in the tree with an id');
    const r = await sidecar.axAct({ ref: id!, action: 'set_value', value: 'filled hands-off' });
    eq(await page<string>(`document.getElementById('f').value`), 'filled hands-off', 'the page has the value');
    eq(r.verified, true, 'and buddyd verified it by reading it back');
    return `e${id} = "filled hands-off"; ${(await page<number>('window.__inputs || 0')) > 0 ? 'the page saw an input event' : 'no input event fired — a React field would not notice; send_keys is the fallback'}`;
  });

  await check('the classifier facts for an element come from that element’s app', async () => {
    needs();
    const id = find((n) => n.role === 'AXButton' && named(n, 'Press me'));
    const t = await sidecar.axTarget({ ref: id! });
    eq(t.pid, process.pid, 'the pid is this window’s process, not the frontmost app’s');
    ok(/Press me/.test(t.element?.title || t.element?.description || ''), `the element is named: ${JSON.stringify(t.element?.title)}`);
    return `${t.appName} (${t.bundleId || 'no bundle id'}), pid ${t.pid}`;
  });

  await check('keystrokes posted to one process reach its focused field', async () => {
    needs();
    await page(`document.getElementById('k').focus()`);
    const front = (await sidecar.frontmost()).bundleId;
    // By pid, never by bundle id: every app built on stock Electron shares
    // this one, and keys addressed to it could land in someone else's window.
    await sidecar.keysToApp({ pid: process.pid, text: 'abc' });
    await new Promise((r) => setTimeout(r, 300));
    const got = await page<string>(`document.getElementById('k').value`);
    eq((await sidecar.frontmost()).bundleId, front, 'the app in front did not change');
    if (got !== 'abc') {
      // Chromium only routes key events to a window that is key. The check is
      // honest about which apps this reaches rather than claiming all of them.
      skip(`Chromium in a background window ignored process-posted keys (field reads "${got}") — set_value is the path for web views`);
    }
    return 'typed "abc" into a window that never came forward';
  });

  await check('a window is photographed at its own size, not the display’s', async () => {
    needs();
    const id = tree?.windowId;
    ok(!!id, 'the reading carried a window id');
    const p = path.join(paths.root(), 'hands-window.png');
    const shot = await sidecar.capture({ path: p, target: 'window', windowId: id! });
    const [w] = win!.getSize();
    ok(Math.abs(shot.width - w!) <= 2, `width ${shot.width} ≈ window ${w}`);
    ok(fs.statSync(p).size > 500, 'a real picture');
    return `${shot.width}×${shot.height} for a ${win!.getSize().join('×')} window`;
  });

  win?.destroy();
  if (up) await sidecar.stop();

  // ── Report ────────────────────────────────────────────────────────────────

  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => r.state === 'fail');
  const skipped = results.filter((r) => r.state === 'skip');
  const ran = results.filter((r) => r.state !== 'skip');
  const pad = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: '✓', fail: '✗', skip: '–' } as const;
  let report =
    '\nHands-off checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${ran.length - failed.length}/${ran.length} passed`;
  report += skipped.length ? `, ${skipped.length} skipped\n` : '\n';
  report +=
    '\nNever covered here: a live model choosing hands-off actions, and apps\n' +
    'other than the window this suite opens. How much an app exposes through\n' +
    'accessibility is the app’s decision; see README, "Hands-off".\n\n';
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
