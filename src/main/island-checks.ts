/**
 * The island and the ghost cursor, checked against the real modules.
 *
 *   npm run check:island
 *   BUDDY_ISLAND_TOUR=/some/dir npm run check:island   # also saves screenshots
 *
 * Three layers, as in the hands-off checks:
 *
 *   1. **Where the island goes and what it says** — pure functions, pinned
 *      against this Mac's real display geometry shape (a 185-point notch at the
 *      top of a 1728-point built-in panel) and against a display with none.
 *   2. **The ghost's contract with the executor** — the real `Executor` and the
 *      real `Operator`, with buddyd faked at the supervisor: an intent arrives
 *      *before* the event, the lead is actually waited, a gate holds the ghost
 *      over the thing being asked about, a deny never previews anything, and a
 *      hands-off run never draws on the person's screen at all.
 *   3. **Real windows, real captures** — buddy's own windows really are left
 *      out of its screenshots (a magenta window this suite opens is in the
 *      picture only when asked for), and the island really sits over the menu
 *      bar, unfocusable. With `BUDDY_ISLAND_TOUR` set, every island state and
 *      the ghost are photographed on this screen and written to that directory.
 */
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb } from './store/db.js';
import { settings } from './settings.js';
import { sidecar } from './sidecar/supervisor.js';
import { Executor, type Frame } from './agent/executor.js';
import { Operator } from './agent/orchestrator.js';
import { island, toIslandDisplay } from './island.js';
import {
  DONE_LINGER_MS,
  ISLAND_WINDOW,
  STEP_LINGER_MS,
  islandModel,
  islandShape,
  placeIsland,
  type IslandDisplay,
  type IslandInput,
} from '../shared/island.js';
import { CH } from '../shared/ipc.js';
import type { ModelClient, ModelResponse } from './agent/client.js';
import type { TargetInfo } from './agent/guardrails.js';
import {
  DEFAULT_SETTINGS,
  type DisplayInfo,
  type GhostIntent,
  type InferenceState,
  type RunStep,
  type RunView,
  type WakeupView,
} from '../shared/types.js';

app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-island-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));
const TOUR = process.env.BUDDY_ISLAND_TOUR ? path.resolve(process.env.BUDDY_ISLAND_TOUR) : null;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** This Mac's shape: a notched built-in panel at the origin, and a monitor
 *  to its right that is AppKit's "main". */
const BUILT_IN: IslandDisplay = {
  id: 1,
  x: 0,
  y: 0,
  width: 1728,
  height: 1117,
  notch: { x: 771, width: 185, height: 32 },
  menuBarHeight: 38,
  builtIn: true,
  isMain: false,
};
const MONITOR: IslandDisplay = {
  id: 37,
  x: 1728,
  y: -323,
  width: 2560,
  height: 1440,
  notch: null,
  menuBarHeight: 25,
  builtIn: false,
  isMain: true,
};

const NOW = 1_800_000_000_000;

function step(over: Partial<RunStep> = {}): RunStep {
  return {
    runId: 1,
    idx: 3,
    tool: 'left_click',
    input: { coordinate: [400, 300] },
    result: 'OK',
    framePath: null,
    isError: false,
    ts: NOW - 500,
    verdict: {
      decision: 'allow',
      class: 'read',
      reason: '',
      signal: 'action-kind',
      target: 'the “Send” button',
      appKey: 'com.tinyspeck.slackmacgap',
      appName: 'Slack',
    },
    scale: 1,
    ...over,
  };
}

function runView(over: Partial<RunView> = {}): RunView {
  return {
    id: 1,
    goal: 'Reply to Priya in #sam-eng that the fix ships Tuesday',
    profile: 'attended',
    handsOff: false,
    status: 'running',
    startedAt: NOW - 30_000,
    endedAt: null,
    budgets: { maxSteps: 60, maxWallClockMs: 600_000, maxCostUsd: 2 },
    usage: { steps: 7, elapsedMs: 30_000, costUsd: 0.21, exceeded: null },
    allowlist: { apps: [], domains: [] },
    steps: [step()],
    outcome: null,
    haltReason: null,
    gate: null,
    cacheReadTokens: 0,
    humanInputs: 0,
    sessionGrants: [],
    resumes: 0,
    ...over,
  };
}

const base = (over: Partial<IslandInput> = {}): IslandInput => ({
  state: 'OBSERVING',
  run: null,
  inference: null,
  wakeups: [],
  stepText: 'Clicked the “Send” button',
  dismissed: new Set(),
  hovered: false,
  notice: null,
  now: NOW,
  ...over,
});

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** buddyd's pointer path, faked at the supervisor, with a clock on every call
 *  so "the intent came first, and the lead was waited" is a measurement. */
class FakeInput {
  log: { what: string; t: number; detail?: unknown }[] = [];
  element: TargetInfo['element'] = null;
  private saved: Record<string, unknown> = {};
  install() {
    const s = sidecar as unknown as Record<string, unknown>;
    for (const k of ['targetInfo', 'input', 'capture', 'axTree', 'axTarget', 'axAct', 'watchInput', 'unwatchInput']) this.saved[k] = s[k];
    s.targetInfo = async (): Promise<TargetInfo> => ({
      bundleId: 'com.apple.TextEdit',
      appName: 'TextEdit',
      pid: 1,
      windowTitle: 'Untitled',
      secureInput: false,
      focused: null,
      url: null,
      element: this.element,
    });
    s.input = async (p: Record<string, unknown>) => {
      this.log.push({ what: `input:${p.action}`, t: Date.now(), detail: p });
      return {};
    };
    s.capture = async (p: { path: string }) => {
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, Buffer.from(ONE_PIXEL_PNG, 'base64'));
      return { path: p.path, width: 1728, height: 1117, scale: 1, originX: 0, originY: 0, displayId: 1 };
    };
    s.axTree = async () => ({ tree: {} });
    s.axTarget = async () => ({
      bundleId: 'com.tinyspeck.slackmacgap',
      appName: 'Slack',
      pid: 2,
      windowTitle: '',
      secureInput: false,
      focused: null,
      url: null,
      element: { role: 'AXButton', subrole: '', title: 'Bold', description: '', value: '', help: '', isSecureTextField: false },
    });
    s.axAct = async (p: { ref: number; action: string }) => {
      this.log.push({ what: `ax:${p.action}`, t: Date.now() });
      return { ok: true, ref: p.ref, action: p.action, role: 'AXButton', title: 'Bold', stoleFocus: false, tookFocusTo: '', restoredFocus: false, pointerMoved: false };
    };
    s.watchInput = async () => ({ watching: false });
    s.unwatchInput = async () => ({ watching: false });
  }
  restore() {
    const s = sidecar as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(this.saved)) s[k] = v;
  }
}

const frame: Frame = { path: '', base64: '', width: 1728, height: 1117, scale: 1, originX: 0, originY: 0, displayId: 1 };
const ctx = (profile: 'attended' | 'unattended' = 'attended') => ({
  runId: 1,
  profile,
  allowlist: { apps: ['com.apple.TextEdit', 'com.tinyspeck.slackmacgap'], domains: [] },
  lastFrame: frame,
});

function sinkInto(e: Executor, lead: number, sent: (Omit<GhostIntent, 'runId'> & { t: number })[]) {
  e.intents = { send: (i) => sent.push({ ...i, t: Date.now() }), leadMs: () => lead };
}

// ── The checks ───────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  // ══ Where the island goes ════════════════════════════════════════════════

  await check('on a notched Mac the island sits exactly on the notch', () => {
    const p = placeIsland([MONITOR, BUILT_IN], 'notch')!;
    eq(p.displayId, 1, 'the notched display, not AppKit’s "main"');
    eq(p.real, true, 'a real notch');
    eq(p.window.y, 0, 'the window starts at the top edge — over the menu bar');
    eq(p.window.width, ISLAND_WINDOW.width, 'a fixed-size window');
    const centre = p.window.x + p.notch.x + p.notch.width / 2;
    eq(centre, 771 + 185 / 2, 'centred on the camera housing');
    eq(p.notch.width, 185, 'and exactly as wide as it');
    const rest = islandShape('rest', p.notch);
    eq(rest.width, 185, 'at rest the island IS the notch');
    eq(rest.height, 32, 'to the point');
    return `window ${p.window.width}×${p.window.height} at ${p.window.x},${p.window.y}; notch ${p.notch.width}×${p.notch.height} at ${p.notch.x}`;
  });

  await check('with no notch, or asked for the main display, it is a pill under the menu bar', () => {
    const p = placeIsland([MONITOR, BUILT_IN], 'main')!;
    eq(p.displayId, 1, '"main" is the display at the origin, which carries the menu bar');
    const solo = placeIsland([MONITOR], 'notch')!;
    eq(solo.real, false, 'a display without a notch gets a virtual one');
    eq(solo.notch.top, 25 + 6, 'tucked under its 25-point menu bar');
    eq(solo.window.x + solo.notch.x + solo.notch.width / 2, MONITOR.x + MONITOR.width / 2, 'centred');
    eq(placeIsland([], 'notch'), null, 'no displays, no island');
    return 'virtual notch 180×30, 6 pt under the menu bar';
  });

  // ══ What it says ═════════════════════════════════════════════════════════

  await check('nothing going on is nothing drawn', () => {
    const m = islandModel(base());
    eq(m.mode, 'idle', 'idle');
    eq(m.size, 'rest', 'and at rest — black on black, invisible on a real notch');
    return 'rest';
  });

  await check('a fresh step opens the island; it settles to wings a moment later', () => {
    const fresh = islandModel(base({ run: runView() }));
    eq(fresh.mode, 'acting', 'acting');
    eq(fresh.size, 'expanded', 'a new step gets a sentence');
    eq(fresh.badge, '7/60', 'and the step count');
    eq(fresh.detail, 'Clicked the “Send” button', 'the step, in words');
    const later = islandModel(base({ run: runView(), now: NOW + STEP_LINGER_MS + 1 }));
    eq(later.size, 'compact', 'then folds back to wings');
    eq(islandModel(base({ run: runView(), now: NOW + STEP_LINGER_MS + 1, hovered: true })).size, 'expanded', 'and opens on hover');
    return `${STEP_LINGER_MS} ms of sentence per step, then the wings`;
  });

  await check('a question beats everything, and does not fold away', () => {
    const gate = {
      runId: 1,
      stepIdx: 4,
      action: 'left_click',
      verdict: { ...step().verdict!, decision: 'confirm' as const, class: 'send' as const, reason: 'That click targets the “Send” button in Slack.' },
      sessionScope: 'sending in Slack',
      askedBefore: 0,
    };
    const m = islandModel(base({ run: runView({ status: 'gated', gate }), notice: { id: 'n', title: 'x', detail: '', tone: 'go', action: null, actionLabel: null, expiresAt: NOW + 9e9 }, now: NOW + 60_000 }));
    eq(m.mode, 'gated', 'gated, even with a notice waiting');
    eq(m.size, 'expanded', 'expanded');
    eq(m.until, null, 'until it is answered');
    ok(/Send/.test(m.detail), 'saying what it is asking about');
    return m.detail;
  });

  await check('done lingers, then goes; needs-you stays until it is dismissed', () => {
    const done = runView({ status: 'done', endedAt: NOW, outcome: { status: 'done', summary: 'Replied in the thread.' } });
    eq(islandModel(base({ run: done, now: NOW + 1000 })).mode, 'done', 'done shows');
    eq(islandModel(base({ run: done, now: NOW + DONE_LINGER_MS + 1 })).mode, 'idle', `and is gone after ${DONE_LINGER_MS} ms`);
    const needs = runView({ status: 'needs_human', endedAt: NOW, haltReason: 'Blocked: Slack is not on this run’s allowlist.' });
    eq(islandModel(base({ run: needs, now: NOW + 3_600_000 })).mode, 'needs', 'needs-you is still there an hour later');
    eq(islandModel(base({ run: needs, dismissed: new Set([1]) })).mode, 'idle', 'until dismissed');
    return 'an ending nobody saw is the one that matters';
  });

  await check('reading, notices and standby each get their turn, in that order', () => {
    const reading: InferenceState = { phase: 'provisional', goal: 'File SAM-4412', source: 'task-note', reading: null, error: null, ms: null, costUsd: null, requestId: 1 };
    eq(islandModel(base({ state: 'ARMED', inference: reading })).mode, 'reading', 'reading while the HUD is armed');
    const wake: WakeupView = { id: 1, runId: 9, goal: 'g', fireAt: NOW + 4 * 60_000, condition: 'Priya replied in #sam-eng', intervalS: 300, attempts: 1, maxAttempts: 12, runStatus: 'waiting' };
    const notice = { id: 'welcome', title: 'Welcome back', detail: 'Pick up where you left off?', tone: 'go' as const, action: 'restore', actionLabel: 'Restore', expiresAt: NOW + 60_000 };
    eq(islandModel(base({ wakeups: [wake], notice })).mode, 'notice', 'a notice beats standby');
    const w = islandModel(base({ wakeups: [wake] }));
    eq(w.mode, 'waiting', 'standby on its own');
    eq(w.size, 'compact', 'as wings');
    eq(w.badge, '1', 'with a count');
    ok(/in 4 min/.test(w.detail), `and when it looks next: ${w.detail}`);
    return w.detail;
  });

  // ══ The ghost and the executor ═══════════════════════════════════════════

  const fake = new FakeInput();
  fake.install();

  await check('the ghost hears about a click before the click happens, and the lead is waited', async () => {
    fake.log.length = 0;
    fake.element = { role: 'AXButton', subrole: '', title: 'Save', description: '', value: '', help: '', isSecureTextField: false };
    const e = new Executor();
    const sent: (Omit<GhostIntent, 'runId'> & { t: number })[] = [];
    sinkInto(e, 120, sent);
    const r = await e.execute('left_click', { coordinate: [400, 300] }, ctx());
    eq(r.kind, 'ok', 'dispatched');
    eq(sent.length, 1, 'one intent');
    const click = fake.log.find((l) => l.what === 'input:left_click')!;
    ok(sent[0]!.t <= click.t, 'sent before the event');
    ok(click.t - sent[0]!.t >= 110, `and the event waited the lead (${click.t - sent[0]!.t} ms of 120)`);
    eq(`${sent[0]!.x},${sent[0]!.y}`, '400,300', 'at the translated screen point');
    eq(sent[0]!.label, 'Save', 'naming what it is aiming at');
    return `intent → ${click.t - sent[0]!.t} ms → click`;
  });

  await check('a gate holds the ghost over the thing being asked about; a deny previews nothing', async () => {
    fake.log.length = 0;
    fake.element = { role: 'AXButton', subrole: '', title: 'Send', description: '', value: '', help: '', isSecureTextField: false };
    const e = new Executor();
    const sent: (Omit<GhostIntent, 'runId'> & { t: number })[] = [];
    sinkInto(e, 120, sent);
    const gated = await e.execute('left_click', { coordinate: [500, 500] }, ctx('attended'));
    eq(gated.kind, 'gate', 'gated');
    eq(sent[0]?.kind, 'pending', 'the ghost waits there');
    eq(sent[0]?.leadMs, 0, 'with no lead — nothing is about to happen');
    eq(fake.log.filter((l) => l.what.startsWith('input')).length, 0, 'and nothing was dispatched');
    sent.length = 0;
    const denied = await e.execute('left_click', { coordinate: [500, 500] }, ctx('unattended'));
    eq(denied.kind, 'denied', 'denied unattended');
    eq(sent.length, 0, 'no ghost for an action buddy will not take');
    return 'pending over “Send”; nothing for a deny';
  });

  await check('typing is previewed where the text is going, without slowing the typing', async () => {
    fake.log.length = 0;
    fake.element = null;
    const e = new Executor();
    const sent: (Omit<GhostIntent, 'runId'> & { t: number })[] = [];
    sinkInto(e, 400, sent);
    await e.execute('left_click', { coordinate: [640, 220] }, ctx());
    const t0 = Date.now();
    await e.execute('type', { text: 'Merging after lunch' }, ctx());
    const typed = Date.now() - t0;
    eq(sent[1]?.kind, 'type', 'a type intent');
    eq(`${sent[1]!.x},${sent[1]!.y}`, '640,220', 'at the field the last click focused');
    eq(sent[1]!.label, 'Merging after lunch', 'with the text');
    ok(typed < 300, `typing did not wait the 400 ms lead (${typed} ms)`);
    await e.execute('screenshot', {}, ctx());
    eq(sent.length, 2, 'and a screenshot is not previewed at all');
    return `click previewed with its lead; "type" in ${typed} ms`;
  });

  await check('a hands-off run never draws on the person’s screen', async () => {
    fake.log.length = 0;
    const e = new Executor();
    const sent: (Omit<GhostIntent, 'runId'> & { t: number })[] = [];
    sinkInto(e, 300, sent);
    const r = await e.executeHands('act', { element: 'e5', action: 'press' }, ctx());
    eq(r.kind, 'ok', 'pressed');
    eq(fake.log.filter((l) => l.what.startsWith('ax:')).length, 1, 'through AX');
    eq(sent.length, 0, 'with no ghost — hands-off promises to leave the screen alone');
    return 'the island says what it is doing instead';
  });

  await check('the Operator wires the ghost, and the setting turns it off with no delay left behind', async () => {
    const intents: GhostIntent[] = [];
    const scripted = (): ModelClient => {
      let t = 0;
      return {
        async create(): Promise<ModelResponse> {
          const content =
            t++ === 0
              ? [{ type: 'tool_use', id: 'toolu_a', name: 'left_click', input: { coordinate: [10, 10] }, toolset_name: 'computer', caller: { type: 'direct' } }]
              : [{ type: 'tool_use', id: 'toolu_b', name: 'finish', input: { status: 'done', summary: 'ok' }, caller: { type: 'direct' } }];
          return {
            content: content as unknown as Anthropic.Messages.ContentBlock[],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          };
        },
      };
    };
    const op = new Operator();
    op.setClientFactory(scripted);
    op.setIntentSink((i) => intents.push(i));
    settings.update({ ghostCursor: true, ghostLeadMs: 50 });
    const v = await op.start({ goal: 'click', profile: 'attended', allowlist: { apps: ['com.apple.TextEdit'], domains: [] } });
    eq(intents.length, 1, 'one intent from a real run');
    eq(intents[0]!.runId, v.id, 'carrying the run’s id');
    eq(intents[0]!.leadMs, 50, 'and the configured lead');

    intents.length = 0;
    settings.update({ ghostCursor: false });
    const t0 = Date.now();
    await op.start({ goal: 'click', profile: 'attended', allowlist: { apps: ['com.apple.TextEdit'], domains: [] } });
    eq(intents.length, 0, 'off means no intents');
    ok(Date.now() - t0 < 2_000, 'and no lead is waited for a ghost nobody will see');
    settings.update({ ghostCursor: true, ghostLeadMs: DEFAULT_SETTINGS.ghostLeadMs });
    return 'operator → executor → sink, gated by the setting at send time';
  });

  fake.restore();

  // ══ Real windows, real captures ══════════════════════════════════════════

  let up = false;
  try {
    await sidecar.start();
    up = true;
  } catch (e) {
    log.warn('checks', 'buddyd did not start', { error: (e as Error).message });
  }
  const screenOk = up ? (await sidecar.permissions()).screenRecording : false;
  let displays: DisplayInfo[] = [];
  if (up) displays = (await sidecar.displays()).displays;

  await check('buddyd reports the notch geometry the island is placed from', async () => {
    if (!up) skip('buddyd is not built');
    ok(displays.length > 0, 'displays');
    ok(displays.every((d) => typeof d.menuBarHeight === 'number' && 'notch' in d), 'every display says whether it has one');
    const n = displays.find((d) => d.notch);
    return n
      ? `display ${n.id}: notch ${n.notch!.width}×${n.notch!.height} at x=${n.notch!.x}, menu bar ${n.menuBarHeight} pt`
      : 'no notched display on this Mac — the island will be a pill under the menu bar';
  });

  await check('buddy’s own windows are not in its screenshots unless asked for', async () => {
    if (!up) skip('buddyd is not built');
    if (!screenOk) skip('Screen Recording is not granted to this buddyd');
    const d = displays.find((x) => x.originX === 0 && x.originY === 0) ?? displays[0]!;
    const win = new BrowserWindow({
      x: d.originX + 220,
      y: d.originY + 320,
      width: 140,
      height: 90,
      show: false,
      frame: false,
      focusable: false,
      backgroundColor: '#ff00ff',
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    await win.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff"></body>');
    win.showInactive();
    await sleep(500);
    const sample = async (includeSelf: boolean) => {
      const p = path.join(tmp, `self-${includeSelf}.png`);
      await (sidecar as unknown as { require(): { call(m: string, p: unknown, t: number): Promise<{ scale: number }> } })
        .require()
        .call('capture', { path: p, target: 'display', displayId: d.id, includeSelf }, 20_000);
      const img = nativeImage.createFromPath(p);
      const { width } = img.getSize();
      const bmp = img.toBitmap();
      const x = 220 + 70;
      const y = 320 + 45;
      const i = (y * width + x) * 4;
      return { b: bmp[i]!, g: bmp[i + 1]!, r: bmp[i + 2]! };
    };
    const withSelf = await sample(true);
    const without = await sample(false);
    win.destroy();
    // Colour-managed on the way to the PNG (the panel is Display P3), so
    // #ff00ff arrives as roughly 234,51,247 — magenta, not exactly it.
    const magenta = (c: { r: number; g: number; b: number }) => c.r > 200 && c.g < 100 && c.b > 200;
    ok(magenta(withSelf), `with includeSelf the window is in the picture (rgb ${withSelf.r},${withSelf.g},${withSelf.b})`);
    ok(!magenta(without), `by default it is not (rgb ${without.r},${without.g},${without.b})`);
    return `magenta with includeSelf; rgb ${without.r},${without.g},${without.b} without — the model never sees buddy`;
  });

  // The island, for real: the module's own window, placed from buddyd's own
  // display list. The snapshot handler is all of the IPC it needs.
  ipcMain.handle(CH.getSnapshot, () => ({
    state: 'OBSERVING',
    settings: settings.get(),
    activeRun: null,
    inference: null,
    wakeups: [],
  }));
  ipcMain.handle(CH.setIslandInteractive, (_e, on: boolean) => island.setInteractive(!!on));
  ipcMain.handle(CH.getIsland, () => island.current());
  if (up) await island.start();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) log.warn('checks', 'renderer said', { message });
    });
  }
  const islandWin = () =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('#/island')) ?? null;
  if (up) {
    for (let i = 0; i < 20 && (!islandWin() || islandWin()!.webContents.isLoading()); i++) await sleep(150);
    await sleep(400);
  }

  await check('the island sits over the menu bar and can never take focus', async () => {
    if (!up) skip('buddyd is not built');
    const w = islandWin();
    ok(!!w, 'the island window exists');
    const p = placeIsland(displays.map(toIslandDisplay), settings.get().islandPlacement)!;
    const b = w!.getBounds();
    eq(b.y, p.window.y, `its top edge is the display's top edge (${b.y}), not pushed below the menu bar`);
    eq(b.x, p.window.x, 'centred where the placement says');
    eq(w!.isFocusable(), false, 'not focusable');
    ok(w!.isAlwaysOnTop(), 'above everything');
    return `${b.width}×${b.height} at ${b.x},${b.y} on display ${p.displayId}${p.real ? ' (over the notch)' : ''}`;
  });

  // ── The tour: every state, photographed on this screen ─────────────────────

  if (TOUR && up && screenOk) {
    fs.mkdirSync(TOUR, { recursive: true });
    const w = islandWin()!;
    const p = placeIsland(displays.map(toIslandDisplay), settings.get().islandPlacement)!;
    let shots = 0;
    const shoot = async (name: string, region: { x: number; y: number; w: number; h: number }) => {
      const t0 = Date.now();
      try {
        await (sidecar as unknown as { require(): { call(m: string, p: unknown, t: number): Promise<unknown> } })
          .require()
          .call('capture', { path: path.join(TOUR, `${name}.png`), target: 'region', region, includeSelf: true }, 8_000);
        shots++;
        log.info('checks', 'tour shot', { name, ms: Date.now() - t0 });
      } catch (e) {
        log.warn('checks', 'tour shot failed', { name, ms: Date.now() - t0, error: (e as Error).message });
      }
    };
    const islandRegion = { x: p.window.x - 40, y: p.window.y, w: p.window.width + 80, h: p.window.height };
    const now = Date.now();
    const states: [string, Partial<RunView> | null, unknown?][] = [
      ['1-rest', null],
      ['2-acting-step', { steps: [step({ ts: now })], usage: { steps: 7, elapsedMs: 1, costUsd: 0.2, exceeded: null } }],
      ['3-acting-wings', { steps: [step({ ts: now - 10_000 })] }],
      ['4-hands-off', { handsOff: true, steps: [step({ tool: 'act', input: { element: 'e12', action: 'press' }, result: 'OK — press on AXButton "Send" (e12).', ts: now })] }],
      ['5-gated', { status: 'gated', gate: { runId: 1, stepIdx: 4, action: 'left_click', verdict: { ...step().verdict!, decision: 'confirm', class: 'send', reason: 'That click targets the “Send” button in Slack. A sent message cannot be recalled.' }, sessionScope: 'sending in Slack', askedBefore: 0 } }],
      ['6-done', { status: 'done', endedAt: now, outcome: { status: 'done', summary: 'Replied to Priya in the thread: the fix ships Tuesday.' } }],
      ['7-needs-you', { id: 2, status: 'needs_human', endedAt: now, haltReason: 'Blocked: Spotify is not on this run’s allowlist.' }],
    ];
    for (const [name, over] of states) {
      w.webContents.send(CH.onRun, over ? runView({ startedAt: now - 20_000, ...over }) : runView({ id: 99, status: 'done', endedAt: now - 3_600_000 }));
      await sleep(900);
      await shoot(name, islandRegion);
    }
    w.webContents.send(CH.onRun, runView({ id: 3, status: 'done', endedAt: now - 3_600_000 }));
    w.webContents.send(CH.onWakeups, [{ id: 1, runId: 9, goal: 'g', fireAt: now + 4 * 60_000, condition: 'Priya replied in #sam-eng', intervalS: 300, attempts: 1, maxAttempts: 12, runStatus: 'waiting' }]);
    await sleep(900);
    await shoot('8-waiting', islandRegion);
    w.webContents.send(CH.onWakeups, []);
    island.showNotice({ id: 'welcome', title: 'Welcome back', detail: 'You were filing SAM-4412 from Priya’s thread. Put everything back where it was?', tone: 'go', action: 'restore', actionLabel: 'Restore', expiresAt: now + 60_000 });
    await sleep(900);
    await shoot('9-notice', islandRegion);
    island.showNotice(null);

    // The ghost, on the island's display, mid-glide and as the click lands.
    const d = displays.find((x) => x.id === p.displayId)!;
    const gx = d.originX + 520;
    const gy = d.originY + 420;
    const ghostRegion = { x: gx - 60, y: gy - 40, w: 420, h: 150 };
    island.intent({ runId: 1, kind: 'move', x: gx - 200, y: gy - 120, label: '', leadMs: 0, at: Date.now() });
    await sleep(800);
    island.intent({ runId: 1, kind: 'click', x: gx, y: gy, label: 'the “Send” button', leadMs: 600, at: Date.now() });
    await sleep(650);
    await shoot('10-ghost-click', ghostRegion);
    island.intent({ runId: 1, kind: 'pending', x: gx, y: gy, label: 'the “Send” button', leadMs: 0, at: Date.now() });
    await sleep(700);
    await shoot('11-ghost-gate', ghostRegion);
    island.intent({ runId: 1, kind: 'key', x: gx, y: gy, label: 'cmd+shift+k', leadMs: 0, at: Date.now() });
    await sleep(500);
    await shoot('12-ghost-key', ghostRegion);
    island.intent({ runId: 1, kind: 'type', x: gx, y: gy, label: 'Merging after lunch — the fix ships Tuesday', leadMs: 0, at: Date.now() });
    await sleep(500);
    await shoot('13-ghost-type', ghostRegion);
    results.push({ name: 'tour', state: shots === 13 ? 'pass' : 'fail', detail: `${shots} of 13 screenshots in ${TOUR}` });
  }

  island.stop();
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
    '\nIsland and ghost checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${ran.length - failed.length}/${ran.length} passed`;
  report += skipped.length ? `, ${skipped.length} skipped\n` : '\n';
  report +=
    '\nNot asserted here: how the island looks. Run with BUDDY_ISLAND_TOUR=<dir>\n' +
    'and it photographs every state on this screen.\n\n';
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
