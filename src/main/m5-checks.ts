/**
 * cua backend checks (spike), run against the real modules.
 *
 *   npm run check:m5
 *
 * Same shape as `m4-checks.ts`: inside Electron, against a throwaway userData
 * directory. Two things are replaced. The **model** is scripted, as in every
 * suite. **cua-driver** is a fake MCP server — a small Node script speaking the
 * same newline-delimited JSON-RPC, with the result shapes recorded from the real
 * one (`spike/cua-driver/FINDINGS.md`) — spawned by the real `CuaDriver` client,
 * so the transport, the restart, the cancellation and the refusal parsing are
 * the shipping code. buddyd's guardrail facts are a stub, injected through the
 * same seam the executor uses, because they are AX readings of apps this suite
 * does not have.
 *
 * What it pins: the guard runs before every dispatch; a deny and a gate are
 * never dispatched; stale tokens are handled; a missing or ungranted binary
 * fails with its one sentence; the kill switch halts mid-batch; no cua
 * `tool_result` carries `toolset_name`; and the OpenAI-compatible adapter and
 * its metering.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb } from './store/db.js';
import { runPaths } from './store/runs.js';
import { settings } from './settings.js';
import { AgentRunner } from './agent/runner.js';
import { KillSwitches } from './agent/killswitch.js';
import type { ModelClient, ModelResponse } from './agent/client.js';
import type { ExecContext } from './agent/executor.js';
import { FINISH_TOOL, buildCuaTools, buildTools, COMPUTER_TOOLSET } from './agent/tools.js';
import { CuaDriver, CUA_DRIVER_MISSING, CUA_DRIVER_UNGRANTED, type CuaDriverOptions, type CuaToolResult } from './cua/driver.js';
import { CuaExecutor, IMAGE_MAX_LONG_EDGE, IMAGE_MAX_PIXELS, type TargetFacts } from './cua/executor.js';
import { OpenAIChatModelClient, fromChatResponse, toChatRequest } from './agent/openai-client.js';
import { costOf, operatorPricer } from './agent/budget.js';
import { CAPABILITIES, NO_ANTHROPIC_KEY, NO_OPERATOR_PROVIDER, canOperate, operatorAvailability } from './providers.js';
import { Operator } from './agent/orchestrator.js';
import { DEFAULT_SETTINGS, type Allowlist, type PendingGate, type RunProfile } from '../shared/types.js';
import type { TargetInfo, AxElement } from './agent/guardrails.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-m5-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };
const results: Result[] = [];

function check(name: string, fn: () => string | Promise<string>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((detail) => void results.push({ name, state: 'pass', detail }))
    .catch((e: Error) => void results.push({ name, state: 'fail', detail: e.message }));
}
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

// ── The fake cua-driver ──────────────────────────────────────────────────────

/** The world the fake serves. Slack is in front (the person's); TextEdit is
 *  behind it; buddy's own HUD is on top of both and must never be the opening
 *  observation. Frames are screen points. */
const WORLD = {
  windows: [
    { pid: 999, window_id: 9, app_name: 'buddy', title: 'HUD', bounds: { x: 0, y: 0, width: 600, height: 300 }, z_index: 9 },
    { pid: 4242, window_id: 77, app_name: 'Slack', title: 'general', bounds: { x: 100, y: 100, width: 800, height: 600 }, z_index: 5 },
    { pid: 5151, window_id: 88, app_name: 'TextEdit', title: 'notes.txt', bounds: { x: 200, y: 150, width: 3008, height: 1692 }, z_index: 3 },
  ],
  apps: [
    { name: 'buddy', bundle_id: 'com.cyrus.buddy', pid: 999, active: false },
    { name: 'Slack', bundle_id: 'com.tinyspeck.slackmacgap', pid: 4242, active: true },
    { name: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 5151, active: false },
  ],
  /** [index, role, label, x, y, w, h]. cua-driver reports no subrole, so the
   *  password field is an ordinary AXTextField here — exactly as the real one
   *  reports it. Only buddyd's reading (the stub below) knows better. */
  elements: {
    4242: [
      [0, 'AXWindow', 'general', 100, 100, 800, 600],
      [1, 'AXButton', 'Send', 800, 620, 60, 30],
      [2, 'AXTextField', 'Message', 120, 620, 600, 30],
      [3, 'AXTextField', 'Password', 120, 500, 300, 30],
    ],
    5151: [
      [0, 'AXWindow', 'notes.txt', 200, 150, 3008, 1692],
      [1, 'AXTextArea', 'body', 220, 200, 2900, 1500],
    ],
  } as Record<number, [number, string, string, number, number, number, number][]>,
};

const FAKE_SERVER = `
import fs from 'node:fs';
import readline from 'node:readline';
const WORLD = ${JSON.stringify(WORLD)};
const LOG = process.env.FAKE_LOG;
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let seq = 0;
const latest = new Map();
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  return b.toString('base64');
}
function jpeg(w, h) {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return b.toString('base64');
}
const refuse = (code, text, extra = {}) => ({ isError: true, content: [{ type: 'text', text }], structuredContent: { code, ...extra } });
function snapshot(a) {
  const w = WORLD.windows.find((x) => x.pid === a.pid && x.window_id === a.window_id);
  if (!w) return refuse('window_id_not_found', 'no such window');
  const nw = w.bounds.width * 2, nh = w.bounds.height * 2;
  const long = Math.max(nw, nh);
  const k = a.max_image_dimension && a.max_image_dimension < long ? a.max_image_dimension / long : 1;
  const sw = Math.round(nw * k), sh = Math.round(nh * k);
  const id = 's' + String(++seq).padStart(8, '0');
  const key = a.pid + ':' + a.window_id;
  const prev = latest.get(key);
  latest.set(key, id);
  const px = sw / w.bounds.width;
  const elements = (WORLD.elements[a.pid] || []).map(([i, role, label, x, y, ww, hh]) => ({
    element_index: i, element_token: id + ':' + i, role, label,
    frame: { x, y, w: ww, h: hh },
    screenshot_frame: { x: (x - w.bounds.x) * px, y: (y - w.bounds.y) * px, w: ww * px, h: hh * px },
  }));
  return {
    content: [
      { type: 'text', text: 'window_id=' + a.window_id + ' pid=' + a.pid + ' elements=' + elements.length + '\\n\\n' + elements.map((e) => '- [' + e.element_index + '] ' + e.role + ' "' + e.label + '"').join('\\n') },
      { type: 'image', data: png(sw, sh), mimeType: 'image/png' },
    ],
    structuredContent: {
      snapshot_id: id, pid: a.pid, window_id: a.window_id, app_name: w.app_name, window_title: w.title,
      window_bounds: w.bounds, screenshot_width: sw, screenshot_height: sh, screenshot_scale: 2, elements,
      ...(prev ? { invalidated_snapshot_ids: [prev] } : {}),
    },
  };
}
async function call(name, a) {
  if (name === 'check_permissions') {
    const g = process.env.FAKE_UNGRANTED !== '1';
    return { content: [{ type: 'text', text: g ? 'granted' : 'NOT granted' }], structuredContent: { accessibility: g, screen_recording: g, source: { attribution: 'driver-daemon' } } };
  }
  if (name === 'list_windows') return { content: [{ type: 'text', text: 'windows' }], structuredContent: { windows: WORLD.windows.filter((w) => a.pid == null || w.pid === a.pid).map((w) => ({ ...w, is_on_screen: true })) } };
  if (name === 'list_apps') return { content: [{ type: 'text', text: 'apps' }], structuredContent: { apps: WORLD.apps.map((x) => ({ ...x, running: true })) } };
  if (name === 'get_window_state') return snapshot(a);
  if (name === 'zoom') return { content: [{ type: 'image', data: jpeg(500, 300), mimeType: 'image/jpeg' }] };
  if (name === 'launch_app') return { content: [{ type: 'text', text: 'launched' }], structuredContent: { pid: 6161, bundle_id: a.bundle_id, windows: [] } };
  if (a.element_token) {
    const snap = String(a.element_token).split(':')[0];
    if (![...latest.values()].includes(snap)) {
      return { isError: true, content: [{ type: 'text', text: 'element_token is stale; call get_window_state again to refresh' }], structuredContent: { status: 'refused', refusal: { code: 'stale_element_token', message: 'stale' } } };
    }
  } else if (typeof a.x === 'number' && ![...latest.keys()].some((k) => k.startsWith(a.pid + ':'))) {
    return refuse('screenshot_context_missing', 'No current snapshot for this window contains a screenshot owned by this session.');
  }
  if (a.text === 'CRASH') process.exit(3);
  if (a.text === 'SLOW') await new Promise((r) => setTimeout(r, 4000));
  const effect = a.text === 'NOOP' ? 'suspected_noop' : 'unverifiable';
  return { content: [{ type: 'text', text: '✅ ' + name }], structuredContent: { summary: '✅ ' + name, effect, delivery: { mode: a.delivery_mode || 'background' } } };
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === 'notifications/cancelled') { log({ cancelled: m.params.requestId }); return; }
  if (m.id == null) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-cua-driver', version: '0.0.0-fake' }, capabilities: { tools: {} } } });
  if (m.method === 'tools/call') {
    log({ call: m.params.name, args: m.params.arguments });
    const result = await call(m.params.name, m.params.arguments || {});
    return send({ jsonrpc: '2.0', id: m.id, result });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } });
});
`;

const fakeDir = path.join(tmp, 'fake-cua');
fs.mkdirSync(fakeDir, { recursive: true });
const FAKE = path.join(fakeDir, 'fake-cua-driver.mjs');
fs.writeFileSync(FAKE, FAKE_SERVER);

/** The real client, with every call it makes written down in order alongside
 *  the guardrail's reads, so "facts before dispatch" is an ordering in one
 *  array rather than a race between two processes' clocks. */
class RecordingDriver extends CuaDriver {
  constructor(
    readonly events: string[],
    opts: CuaDriverOptions,
  ) {
    super(opts);
  }
  override call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CuaToolResult> {
    this.events.push(`dispatch:${name}`);
    return super.call(name, args, timeoutMs);
  }
}

function fakeDriver(events: string[], extraEnv: Record<string, string> = {}) {
  const logFile = path.join(fakeDir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(logFile, '');
  const driver = new RecordingDriver(events, {
    bin: process.execPath,
    args: [FAKE],
    env: { ELECTRON_RUN_AS_NODE: '1', FAKE_LOG: logFile, ...extraEnv },
  });
  const served = () =>
    fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { call?: string; args?: Record<string, unknown>; cancelled?: number; t: number });
  return { driver, served };
}

// ── buddyd's reading, stubbed ────────────────────────────────────────────────

const BUNDLE: Record<number, { bundleId: string; appName: string; title: string }> = {
  4242: { bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack', title: 'general' },
  5151: { bundleId: 'com.apple.TextEdit', appName: 'TextEdit', title: 'notes.txt' },
};

/** What buddyd's `ax_target {pid, x, y}` would say: the target app's own hit
 *  test, with the subrole — which is how the password field is known. */
function factsStub(events: string[]): TargetFacts {
  return async ({ pid, point }) => {
    events.push(`facts:${pid}`);
    const app = BUNDLE[pid] ?? { bundleId: '', appName: '', title: '' };
    let element: AxElement | null = null;
    if (point) {
      const hit = (WORLD.elements[pid] ?? [])
        .filter(([, , , x, y, w, h]) => point.x >= x && point.y >= y && point.x <= x + w && point.y <= y + h)
        .sort((a, b) => a[5] * a[6] - b[5] * b[6])[0];
      if (hit) {
        const secure = hit[2] === 'Password';
        element = {
          role: hit[1],
          subrole: secure ? 'AXSecureTextField' : '',
          title: hit[1] === 'AXButton' ? hit[2] : '',
          description: hit[1] === 'AXButton' ? '' : hit[2],
          value: '',
          help: '',
          isSecureTextField: secure,
          frame: { x: hit[3], y: hit[4], w: hit[5], h: hit[6] },
        };
      }
    }
    const info: TargetInfo = {
      bundleId: app.bundleId,
      appName: app.appName,
      pid,
      windowTitle: app.title,
      secureInput: false,
      focused: { role: 'AXTextField', subrole: '', title: 'Message', isSecureTextField: false },
      url: null,
      element,
    };
    return info;
  };
}

// ── The scripted model ───────────────────────────────────────────────────────

type Blocks = Record<string, unknown>[];
class ScriptedModel implements ModelClient {
  sent: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  constructor(private script: (turn: number, snap: string) => Blocks) {}
  async create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    this.sent.push(JSON.parse(JSON.stringify(params)));
    return {
      content: this.script(this.sent.length - 1, lastSnapshot(params.messages)) as never,
      stop_reason: 'tool_use',
      usage: { input_tokens: 2_000, output_tokens: 200, cache_read_input_tokens: 1_500 },
    };
  }
}

/** The newest snapshot id the model has been shown, read the way a model
 *  would: out of the text. */
function lastSnapshot(messages: Anthropic.Messages.MessageParam[]): string {
  const text = JSON.stringify(messages);
  const all = [...text.matchAll(/snapshot (s\d{8})/g)].map((m) => m[1]);
  return all[all.length - 1] ?? 's????????';
}

const use = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
  name,
  input,
  ...extra,
});
const finish = (summary = 'done') => use(FINISH_TOOL, { status: 'done', summary });

const ATTENDED_ALLOW: Allowlist = { apps: ['com.tinyspeck.slackmacgap', 'com.apple.TextEdit'], domains: [] };

async function cuaRun(opts: {
  script: (turn: number, snap: string) => Blocks;
  profile?: RunProfile;
  allowlist?: Allowlist;
  onGate?: (runner: AgentRunner, g: PendingGate) => void;
  during?: (runner: AgentRunner, events: string[]) => void;
}) {
  const events: string[] = [];
  const { driver, served } = fakeDriver(events);
  const executor = new CuaExecutor({ driver, facts: factsStub(events), selfPid: 999 });
  const model = new ScriptedModel(opts.script);
  const runner = new AgentRunner({ client: model, executor, killSwitches: new KillSwitches() });
  if (opts.onGate) runner.on('gate', (g: PendingGate) => opts.onGate!(runner, g));
  opts.during?.(runner, events);
  const t0 = Date.now();
  const view = await runner.run({
    goal: 'scripted cua run',
    profile: opts.profile ?? 'attended',
    allowlist: opts.allowlist ?? ATTENDED_ALLOW,
    budgets: { maxSteps: 30, maxWallClockMs: 60_000, maxCostUsd: 5 },
  });
  const ms = Date.now() - t0;
  // Let the fake log anything still in its pipe (a cancel notification) before
  // it is stopped; the log is what the checks read.
  await new Promise((r) => setTimeout(r, 300));
  await driver.stop();
  return { view, events, served: served(), model, runner, ms };
}

/** Executor-level: one call, classified and maybe dispatched, against a fresh
 *  fake with a snapshot of `pid`'s window already taken. */
async function oneCall(
  tool: string,
  input: (snap: string) => Record<string, unknown>,
  o: { profile?: RunProfile; allowlist?: Allowlist; snapPid?: number; preApproved?: boolean } = {},
) {
  const events: string[] = [];
  const { driver, served } = fakeDriver(events);
  const exec = new CuaExecutor({ driver, facts: factsStub(events), selfPid: 999 });
  const ctx: ExecContext = {
    runId: 0,
    profile: o.profile ?? 'attended',
    allowlist: o.allowlist ?? ATTENDED_ALLOW,
    lastFrame: null,
    ...(o.preApproved ? { preApproved: true } : {}),
  };
  const pid = o.snapPid ?? 4242;
  const win = pid === 4242 ? 77 : 88;
  const snap = await exec.execute('get_window_state', { pid, window_id: win }, ctx);
  const snapId = /snapshot (s\d{8})/.exec(snap.kind === 'ok' ? snap.text : '')?.[1] ?? 's????????';
  events.length = 0;
  const out = await exec.execute(tool, input(snapId), ctx);
  const calls = served().filter((s) => s.call === tool);
  await driver.stop();
  return { out, events, calls, exec };
}

// ── The run ──────────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  // ═══ 1. The surface, and that the default did not move ═══════════════════

  await check('the default backend is the toolset, and its surface is unchanged', () => {
    eq(DEFAULT_SETTINGS.operatorBackend, 'toolset', 'DEFAULT_SETTINGS.operatorBackend');
    eq(settings.get().operatorBackend, 'toolset', 'a fresh settings store');
    settings.update({ operatorBackend: 'nonsense' as never });
    eq(settings.get().operatorBackend, 'toolset', 'an unknown value normalises to the toolset');
    const t = buildTools();
    eq((t[0] as { type?: string }).type, COMPUTER_TOOLSET, 'buildTools still leads with the toolset');
    return 'operatorBackend defaults to toolset; buildTools() is the toolset + describe + finish';
  });

  await check('buildCuaTools: the curated subset from tools.json, stable, finish last and cached', () => {
    const tools = buildCuaTools() as unknown as Record<string, unknown>[];
    const names = tools.map((t) => t.name);
    const want = [
      'get_window_state', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
      'press_key', 'hotkey', 'zoom', 'list_apps', 'list_windows', 'launch_app', FINISH_TOOL,
    ];
    eq(names.join(','), want.join(','), 'names and order');
    ok(tools.every((t) => !('type' in t) || t.type !== COMPUTER_TOOLSET), 'no toolset entry');
    ok(tools.slice(0, -1).every((t) => !('cache_control' in t)), 'only the last carries cache_control');
    ok('cache_control' in tools[tools.length - 1], 'finish carries the breakpoint');
    eq(JSON.stringify(buildCuaTools()), JSON.stringify(buildCuaTools()), 'byte-identical across calls');
    const stripped = ['scope', 'target', 'from_zoom', 'capture_id', 'session', 'max_image_dimension', 'screenshot_out_file'];
    for (const t of tools.slice(0, -1)) {
      const props = Object.keys(((t.input_schema as { properties?: object }).properties ?? {}) as object);
      for (const k of stripped) ok(!props.includes(k), `${t.name} still offers ${k}`);
    }
    // Built from cua-driver's own tools/list, not from the docs.
    const source = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'spike/cua-driver/tools.json'), 'utf8')) as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    };
    const srcClick = source.tools.find((t) => t.name === 'click')!.inputSchema.properties.element_token;
    const ours = (tools[1].input_schema as { properties: Record<string, unknown> }).properties.element_token;
    eq(JSON.stringify(ours), JSON.stringify(srcClick), 'click.element_token is cua-driver’s own definition');
    const bytes = JSON.stringify(tools).length;
    return `${names.length} tools, ${bytes} bytes of schema (≈${Math.round(bytes / 4 / 1000)}k tokens, cached)`;
  });

  await check('the image ceiling and the one coordinate translation', () => {
    const big = CuaExecutor.imageCap({ width: 3008, height: 1692 });
    ok(big <= IMAGE_MAX_LONG_EDGE, 'long edge within 2576');
    ok(big * Math.round((big * 1692) / 3008) <= IMAGE_MAX_PIXELS, `area within 3.75 MP at ${big}`);
    const square = CuaExecutor.imageCap({ width: 1000, height: 1000 });
    ok(square * square <= IMAGE_MAX_PIXELS && square > 1900, `a square window caps on area (${square})`);
    const p = CuaExecutor.toScreen({ x: 800, y: 600 }, { bounds: { x: 100, y: 100, width: 800, height: 600 }, shotW: 1600, shotH: 1200 });
    eq(`${p.x},${p.y}`, '500,400', 'window pixel (800,600) of a 2× shot → screen point');
    return `3008×1692 pt → ${big} px long edge; 1000² → ${square}`;
  });

  // ═══ 2. The process ═════════════════════════════════════════════════════

  await check('a missing binary fails with the one sentence', async () => {
    const d = new CuaDriver({ bin: '/nonexistent/cua-driver' });
    const err = await d.ensureStarted().then(() => null, (e: Error) => e.message);
    eq(err, CUA_DRIVER_MISSING, 'the error');
    return 'CUA_DRIVER_MISSING, the same string operatorAvailability() shows';
  });

  await check('an ungranted cua-driver fails with the one sentence', async () => {
    const { driver } = fakeDriver([], { FAKE_UNGRANTED: '1' });
    const err = await driver.ensureStarted().then(() => null, (e: Error) => e.message);
    eq(err, CUA_DRIVER_UNGRANTED, 'the error');
    ok(!driver.status().running, 'and the half-started process is not kept');
    return 'checked with check_permissions {prompt:false} before anything is dispatched';
  });

  await check('a crash restarts cua-driver, and tokens from the old session are refused', async () => {
    const events: string[] = [];
    const { driver, served } = fakeDriver(events);
    const exec = new CuaExecutor({ driver, facts: factsStub(events), selfPid: 999 });
    const ctx: ExecContext = { runId: 0, profile: 'attended', allowlist: ATTENDED_ALLOW, lastFrame: null };
    const s = await exec.execute('get_window_state', { pid: 4242, window_id: 77 }, ctx);
    const snap = /snapshot (s\d{8})/.exec(s.kind === 'ok' ? s.text : '')![1];
    const gen = driver.generation;
    const ready = new Promise<void>((r) => driver.once('ready', () => r()));
    const crash = await exec.execute('type_text', { pid: 4242, element_token: `${snap}:2`, text: 'CRASH' }, ctx);
    eq(crash.kind, 'error', 'the call that killed it is an error');
    await ready;
    ok(driver.generation > gen, 'a new session');
    const before = served().filter((x) => x.call === 'click').length;
    const stale = await exec.execute('click', { pid: 4242, element_token: `${snap}:2` }, ctx);
    eq(stale.kind, 'error', 'the old token');
    ok(stale.kind === 'error' && /stale/.test(stale.text), 'is called stale');
    eq(served().filter((x) => x.call === 'click').length, before, 'and never dispatched');
    await driver.stop();
    return `restarted (restarts=${driver.status().restarts}); old token refused before dispatch`;
  });

  // ═══ 3. Guardrails before dispatch ══════════════════════════════════════

  await check('the guard reads buddyd before every dispatch', async () => {
    const r = await cuaRun({
      script: (turn, snap) =>
        turn === 0
          ? [
              // TextEdit, so the opening's Slack snapshot (and `snap`) stays current.
              use('get_window_state', { pid: 5151, window_id: 88 }),
              use('click', { pid: 4242, element_token: `${snap}:2` }),
              use('type_text', { pid: 4242, element_token: `${snap}:2`, text: 'hello' }),
              use('press_key', { pid: 4242, key: 'tab' }),
            ]
          : [finish()],
    });
    eq(r.view.status, 'done', 'the run finished');
    const acting = ['get_window_state', 'click', 'type_text', 'press_key'];
    // The opening observation is buddy's own and unclassified; skip to the
    // model's calls, which start after the first `facts:` read.
    const first = r.events.findIndex((e) => e.startsWith('facts:'));
    const modelEvents = r.events.slice(first);
    let n = 0;
    modelEvents.forEach((e, i) => {
      const tool = e.replace('dispatch:', '');
      if (e.startsWith('dispatch:') && acting.includes(tool)) {
        // A snapshot may look its window's bounds up first (to size the image);
        // that listing is part of the same dispatch, after the guard.
        const prior = modelEvents.slice(0, i).filter((x) => x !== 'dispatch:list_windows');
        ok(prior[prior.length - 1]?.startsWith('facts:'), `${tool} was dispatched without a guardrail read before it`);
        n++;
      }
    });
    ok(n >= 4, `four guarded dispatches (saw ${n})`);
    return `${n} dispatches, each immediately after buddyd's reading of its target`;
  });

  await check('deny: a password field is never typed into, though cua-driver calls it AXTextField', async () => {
    const r = await cuaRun({
      script: (turn, snap) =>
        turn === 0 ? [use('type_text', { pid: 4242, element_token: `${snap}:3`, text: 'hunter2' })] : [finish()],
    });
    eq(r.view.status, 'needs_human', 'the run parks');
    ok(!r.served.some((s) => s.call === 'type_text'), 'type_text never reached cua-driver');
    const v = r.view.steps.find((s) => s.tool === 'type_text')?.verdict;
    eq(v?.class, 'credentials', 'class');
    eq(v?.decision, 'deny', 'decision');
    eq(v?.signal, 'ax-tree', 'signal');
    return `parked: ${r.view.haltReason}`;
  });

  await check('deny: keystroke content in type_text, press_key and hotkey', async () => {
    const key = await oneCall('type_text', (s) => ({ pid: 4242, element_token: `${s}:2`, text: 'here: sk-abcdefghijklmnopqrstuvwx' }));
    eq(key.out.kind, 'denied', 'an sk- key');
    eq(key.calls.length, 0, 'not dispatched');
    const card = await oneCall('type_text', () => ({ pid: 5151, text: '4111 1111 1111 1111' }), { snapPid: 5151 });
    eq(card.out.kind, 'denied', 'a card number');
    const seed = await oneCall('type_text', () => ({
      pid: 5151,
      text: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
    }), { snapPid: 5151 });
    eq(seed.out.kind, 'denied', 'a seed phrase');
    const pk = await oneCall('press_key', () => ({ pid: 5151, key: 'ghp_abcdefghijklmnopqrstuvwxyz' }), { snapPid: 5151 });
    eq(pk.out.kind, 'denied', 'a token shape through press_key');
    const hk = await oneCall('hotkey', () => ({ pid: 5151, keys: ['cmd', 'v'] }), { snapPid: 5151 });
    eq(hk.out.kind, 'ok', 'an ordinary hotkey is allowed');
    return 'sk-, card, seed phrase and ghp_ denied before dispatch; ⌘V allowed';
  });

  await check('gate: the Send button asks first; denying parks with nothing dispatched', async () => {
    const r = await cuaRun({
      script: (turn, snap) => (turn === 0 ? [use('click', { pid: 4242, element_token: `${snap}:1` })] : [finish()]),
      onGate: (runner) => runner.resolveGate('deny'),
    });
    eq(r.view.status, 'needs_human', 'parked');
    ok(!r.served.some((s) => s.call === 'click'), 'the click never reached cua-driver');
    const v = r.view.steps.find((s) => s.tool === 'click')?.verdict;
    eq(v?.class, 'send', 'classified as a send');
    return `gated on ${v?.target}`;
  });

  await check('gate: approving dispatches the click exactly once', async () => {
    let gates = 0;
    const r = await cuaRun({
      script: (turn, snap) => (turn === 0 ? [use('click', { pid: 4242, element_token: `${snap}:1` })] : [finish()]),
      onGate: (runner) => {
        gates++;
        runner.resolveGate('approve');
      },
    });
    eq(r.view.status, 'done', 'finished');
    eq(gates, 1, 'asked once');
    eq(r.served.filter((s) => s.call === 'click').length, 1, 'dispatched once');
    return 'one ask, one click';
  });

  await check('gate: a pixel click on Send resolves through toScreen to the same button', async () => {
    // Send is at screen (800,620,60,30); Slack's window is at (100,100) and
    // the fake sends it at 2×, so its centre is window pixel (1460, 1070).
    const r = await oneCall('click', () => ({ pid: 4242, window_id: 77, x: 1460, y: 1070 }));
    eq(r.out.kind, 'gate', 'gated');
    ok(r.out.kind === 'gate' && /Send/.test(r.out.verdict.target), 'on the Send button');
    eq(r.calls.length, 0, 'not dispatched');
    return 'pixels → screen point → buddyd hit test → "Send"';
  });

  await check('gate: Return in Slack is a send, through press_key', async () => {
    const r = await oneCall('press_key', () => ({ pid: 4242, key: 'return' }));
    eq(r.out.kind, 'gate', 'gated');
    ok(r.out.kind === 'gate' && r.out.verdict.class === 'send', 'as a send');
    return r.out.kind === 'gate' ? r.out.verdict.reason : '';
  });

  await check('the allowlist is checked against the target app, not the frontmost', async () => {
    const allow: Allowlist = { apps: ['com.apple.TextEdit'], domains: [] };
    // Slack is frontmost in the fake world; TextEdit is behind it.
    const te = await oneCall('type_text', () => ({ pid: 5151, text: 'notes' }), { profile: 'unattended', allowlist: allow, snapPid: 5151 });
    eq(te.out.kind, 'ok', 'typing into background TextEdit is allowed');
    eq(te.calls.length, 1, 'and dispatched');
    // No token: under unattended a snapshot of Slack is itself off the list.
    const sl = await oneCall('type_text', () => ({ pid: 4242, text: 'hi' }), { profile: 'unattended', allowlist: allow, snapPid: 5151 });
    eq(sl.out.kind, 'denied', 'typing into Slack (frontmost, not listed) is denied');
    ok(sl.out.kind === 'denied' && sl.out.verdict.class === 'off_allowlist', 'as off_allowlist');
    return 'TextEdit in the background: allowed; Slack in front: off_allowlist';
  });

  await check('properties outside the curated schema never reach cua-driver', async () => {
    const r = await oneCall('click', (s) => ({ pid: 5151, element_token: `${s}:1`, scope: 'desktop', session: 'x' }), { snapPid: 5151 });
    eq(r.out.kind, 'ok', 'dispatched');
    const args = r.calls[0]?.args ?? {};
    ok(!('scope' in args) && !('session' in args), `stripped: ${JSON.stringify(args)}`);
    return 'a hallucinated scope:"desktop" is dropped before dispatch';
  });

  await check('stale tokens: buddy refuses a replaced snapshot; cua-driver’s own refusal reads as an error', async () => {
    const events: string[] = [];
    const { driver, served } = fakeDriver(events);
    const a = new CuaExecutor({ driver, facts: factsStub(events), selfPid: 999 });
    const b = new CuaExecutor({ driver, facts: factsStub(events), selfPid: 999 });
    const ctx: ExecContext = { runId: 0, profile: 'attended', allowlist: ATTENDED_ALLOW, lastFrame: null };
    const idOf = (o: Awaited<ReturnType<CuaExecutor['execute']>>) => /snapshot (s\d{8})/.exec(o.kind === 'ok' ? o.text : '')![1];
    const s1 = idOf(await a.execute('get_window_state', { pid: 5151, window_id: 88 }, ctx));
    const s2 = idOf(await a.execute('get_window_state', { pid: 5151, window_id: 88 }, ctx));
    ok(s1 !== s2, 'two snapshots');
    const own = await a.execute('click', { pid: 5151, element_token: `${s1}:1` }, ctx);
    ok(own.kind === 'error' && /stale/.test(own.text), 'buddy refuses the replaced token itself');
    eq(served().filter((x) => x.call === 'click').length, 0, 'without dispatching');
    // Another snapshot on the same session that `a` never saw: cua-driver is
    // the one that knows s2 is gone.
    await b.execute('get_window_state', { pid: 5151, window_id: 88 }, ctx);
    const theirs = await a.execute('click', { pid: 5151, element_token: `${s2}:1` }, ctx);
    ok(theirs.kind === 'error' && /stale_element_token/.test(theirs.text), `cua-driver's refusal surfaces: ${theirs.kind === 'error' ? theirs.text : ''}`);
    await driver.stop();
    return 'both directions end as a tool error telling the model to snapshot again';
  });

  await check('suspected_noop tells the model to escalate to foreground', async () => {
    const r = await oneCall('type_text', () => ({ pid: 5151, text: 'NOOP' }), { snapPid: 5151 });
    ok(r.out.kind === 'ok' && /delivery_mode: "foreground"/.test(r.out.text), 'the escalation hint');
    return r.out.kind === 'ok' ? r.out.text.slice(0, 90) : '';
  });

  // ═══ 4. The loop ════════════════════════════════════════════════════════

  await check('the opening is get_window_state of the frontmost window that is not buddy’s', async () => {
    const r = await cuaRun({ script: () => [finish()] });
    const first = r.model.sent[0].messages[0].content as unknown as Record<string, unknown>[];
    ok(first.some((b) => b.type === 'image'), 'an image');
    const text = first.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n');
    ok(/pid 4242, window 77/.test(text), 'of Slack, the active app');
    const opening = r.served.find((s) => s.call === 'get_window_state')!;
    eq(opening.args?.pid, 4242, 'not buddy’s HUD on top');
    eq(opening.args?.max_image_dimension, CuaExecutor.imageCap({ width: 800, height: 600 }), 'sized to the ceiling');
    const dir = runPaths.dir(r.view.id);
    ok(fs.readdirSync(dir).some((f) => f.endsWith('.png')), 'its frame is in the run directory');
    ok(r.view.steps[1]?.framePath, 'and on the Run Log step');
    return `Slack, max_image_dimension ${opening.args?.max_image_dimension}`;
  });

  await check('no cua tool_result carries toolset_name — not even one a gateway echoed', async () => {
    const r = await cuaRun({
      script: (turn, snap) =>
        turn === 0
          ? [
              use('get_window_state', { pid: 5151, window_id: 88 }),
              // As if a gateway had decorated the tool_use.
              use('zoom', { window_id: 88, x1: 0, y1: 0, x2: 100, y2: 100 }, { toolset_name: 'computer' }),
              use('scroll', { pid: 5151, direction: 'down' }),
              use('click', { pid: 5151, element_token: `${snap}:1` }),
            ]
          : [finish()],
    });
    eq(r.view.status, 'done', 'finished');
    const results = r.model.sent
      .flatMap((p) => p.messages)
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as Record<string, unknown>[]) : []))
      .filter((b) => b.type === 'tool_result');
    ok(results.length >= 4, `tool_results sent (${results.length})`);
    ok(results.every((b) => !('toolset_name' in b)), 'none carries toolset_name');
    const zoom = results.find((b) => JSON.stringify(b).includes('image/jpeg'));
    ok(zoom, 'the zoom went back as image/jpeg');
    ok(fs.readdirSync(runPaths.dir(r.view.id)).some((f) => f.endsWith('.jpg')), 'and its frame is a .jpg in the run dir');
    return `${results.length} tool_results, zero toolset_name`;
  });

  await check('the kill switch halts mid-batch, inside the step', async () => {
    let stoppedAt = 0;
    const r = await cuaRun({
      script: (turn, snap) =>
        turn === 0
          ? [
              use('type_text', { pid: 5151, text: 'SLOW' }),
              use('click', { pid: 5151, element_token: `${snap}:1` }),
              use('click', { pid: 5151, element_token: `${snap}:1` }),
            ]
          : [finish()],
      during: (runner, events) => {
        const timer = setInterval(() => {
          if (events.includes('dispatch:type_text')) {
            clearInterval(timer);
            setTimeout(() => {
              stoppedAt = Date.now();
              runner.stop('hotkey');
            }, 200);
          }
        }, 20);
      },
    });
    const waited = Date.now() - stoppedAt;
    eq(r.view.status, 'needs_human', 'parked');
    ok(/abort hotkey/.test(r.view.haltReason ?? ''), `by the hotkey: ${r.view.haltReason}`);
    ok(!r.served.some((s) => s.call === 'click'), 'nothing after the in-flight call was dispatched');
    ok(r.served.some((s) => s.cancelled != null), 'cua-driver was sent notifications/cancelled');
    ok(waited < 2_000, `halted ${waited} ms after the switch, not after the 4 s call`);
    return `halted ${waited} ms after the hotkey; the in-flight type_text was cancelled`;
  });

  // ═══ 5. Providers ═══════════════════════════════════════════════════════

  await check('availability: one sentence per backend, one author', async () => {
    const before = settings.get();
    try {
      eq(operatorAvailability().reason?.startsWith(NO_ANTHROPIC_KEY), true, 'toolset with no key still says Claude-only');
      ok(!canOperate('openai', 'toolset') && canOperate('openai', 'cua') && canOperate('local', 'cua'), 'canOperate');
      ok(CAPABILITIES.anthropic.computerUse && !CAPABILITIES.openai.computerUse, 'computerUse is still Claude-only');
      settings.update({ operatorBackend: 'cua', operatorProvider: 'openai' });
      const reason = operatorAvailability().reason;
      ok(reason === NO_OPERATOR_PROVIDER.openai || reason === CUA_DRIVER_MISSING, `cua says what is missing: ${reason}`);
      const op = new Operator();
      const thrown = await op
        .start({ goal: 'x', profile: 'attended', allowlist: ATTENDED_ALLOW })
        .then(() => null, (e: Error) => e.message);
      eq(thrown, reason, 'orchestrator.start() throws the same sentence');
      return `cua/openai with no key: "${reason?.slice(0, 60)}…"`;
    } finally {
      settings.update({ operatorBackend: before.operatorBackend, operatorProvider: before.operatorProvider });
    }
  });

  await check('OpenAI adapter: image tool results become image_url parts after the tool messages', () => {
    const body = toChatRequest(
      {
        model: 'gpt-5',
        max_tokens: 64_000,
        system: [{ type: 'text', text: 'sys' }],
        tools: buildCuaTools(),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Begin' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hm', signature: 'x' },
              { type: 'tool_use', id: 'call_1', name: 'get_window_state', input: { pid: 1, window_id: 2 } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
                  { type: 'text', text: 'snapshot s1' },
                ],
              },
            ],
          },
        ],
        output_config: { effort: 'high' },
      } as never,
      'openai',
    ) as { messages: Record<string, unknown>[]; tools: unknown[]; max_completion_tokens: number; reasoning_effort?: string };
    const roles = body.messages.map((m) => m.role).join(',');
    eq(roles, 'system,user,assistant,tool,user', 'message order');
    const tool = body.messages[3];
    eq(tool.tool_call_id, 'call_1', 'tool_call_id');
    ok(String(tool.content).includes('snapshot s1'), 'tool text kept');
    const parts = body.messages[4].content as Record<string, unknown>[];
    ok(parts.some((p) => p.type === 'image_url' && String((p.image_url as { url: string }).url).startsWith('data:image/png;base64,AAAA')), 'image as image_url');
    eq(body.tools.length, buildCuaTools().length, 'every tool a function');
    eq(body.max_completion_tokens, 32_000, 'output capped');
    eq(body.reasoning_effort, 'high', 'effort carried for a reasoning model');
    ok(!JSON.stringify(body).includes('cache_control'), 'no cache_control');
    ok(!JSON.stringify(body).includes('thinking'), 'no thinking');
    return 'system, user, assistant(tool_calls), tool, user(image_url)';
  });

  await check('OpenAI adapter: tool_calls come back as tool_use, cached tokens as cache reads', () => {
    const r = fromChatResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'click', arguments: '{"pid":1}' } }] },
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    });
    eq(r.stop_reason, 'tool_use', 'stop_reason');
    const tu = r.content[0] as unknown as { type: string; name: string; input: { pid: number } };
    eq(tu.type, 'tool_use', 'block');
    eq(tu.input.pid, 1, 'input parsed');
    eq(r.usage.cache_read_input_tokens, 800, 'cached');
    eq(r.usage.input_tokens, 200, 'uncached input');
    const refused = (() => {
      try {
        toChatRequest({ model: 'x', max_tokens: 1, messages: [], tools: buildTools() } as never, 'openai');
        return false;
      } catch {
        return true;
      }
    })();
    ok(refused, 'the toolset is refused rather than dropped');
    return 'and the toolset entry cannot be sent to an OpenAI model';
  });

  await check('metering: an OpenAI Operator is not $0; an unknown id meters at Opus; local is $0 and says so', () => {
    const u = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 5_000 };
    const gpt = operatorPricer('openai', 'gpt-5-2025-08-07');
    ok(gpt.price(u) > 0, 'gpt-5 is priced');
    const mini = operatorPricer('openai', 'gpt-5-mini');
    ok(mini.price(u) < gpt.price(u), 'gpt-5-mini is matched before gpt-5');
    const unknown = operatorPricer('openai', 'corp-gateway-alias');
    eq(unknown.price(u), costOf(u), 'an unknown id is metered at Opus 5');
    const gw = operatorPricer('anthropic', 'anthropic.claude-sonnet-5-v1:0');
    ok(gw.price(u) > 0 && gw.price(u) < costOf(u), 'a gateway alias for Sonnet is priced as Sonnet');
    const local = operatorPricer('local', 'qwen2.5vl');
    eq(local.price(u), 0, 'local');
    ok(/step and time/.test(local.basis), 'and says what bounds it instead');
    return `gpt-5 $${gpt.price(u).toFixed(4)}, unknown $${unknown.price(u).toFixed(4)}, local $0`;
  });

  await check('a whole cua run on an OpenAI-compatible endpoint, metered', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        bodies.push(body);
        const turn = bodies.length - 1;
        const msg =
          turn === 0
            ? { content: null, tool_calls: [{ id: 'c_gws', type: 'function', function: { name: 'get_window_state', arguments: '{"pid":5151,"window_id":88}' } }] }
            : turn === 1
              ? { content: 'Typing.', tool_calls: [{ id: 'c_type', type: 'function', function: { name: 'type_text', arguments: '{"pid":5151,"text":"hello"}' } }] }
              : { content: null, tool_calls: [{ id: 'c_fin', type: 'function', function: { name: 'finish', arguments: '{"status":"done","summary":"typed hello"}' } }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: msg }], usage: { prompt_tokens: 3000, completion_tokens: 100 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const events: string[] = [];
    const { driver, served } = fakeDriver(events);
    const spent: number[] = [];
    const { price } = operatorPricer('openai', 'gpt-5');
    const runner = new AgentRunner({
      client: new OpenAIChatModelClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', label: 'OpenAI', flavor: 'openai' }),
      executor: new CuaExecutor({ driver, facts: factsStub(events), selfPid: 999 }),
      killSwitches: new KillSwitches(),
      model: 'gpt-5',
      price,
      onSpend: (usd) => spent.push(usd),
    });
    const view = await runner.run({ goal: 'type hello', profile: 'attended', allowlist: ATTENDED_ALLOW });
    server.close();
    await driver.stop();
    eq(view.status, 'done', `finished: ${view.haltReason ?? ''}`);
    ok(served().some((s) => s.call === 'type_text'), 'typed through cua-driver');
    const second = bodies[1].messages as Record<string, unknown>[];
    ok(second.some((m) => m.role === 'tool' && m.tool_call_id === 'c_gws'), 'the tool result went back as a tool message');
    ok(JSON.stringify(second).includes('image_url'), 'with the screenshot as an image_url part');
    ok(view.usage.costUsd > 0 && spent.length === 3, `metered: $${view.usage.costUsd.toFixed(4)} over ${spent.length} turns`);
    return `3 turns on a fake /chat/completions, $${view.usage.costUsd.toFixed(4)} on the meter`;
  });

  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => r.state === 'fail');
  const pad = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: '✓', fail: '✗', skip: '–' } as const;
  let report =
    '\nM5 (cua backend spike) checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${results.length - failed.length}/${results.length} passed\n`;
  report +=
    '\nNever covered here: the real cua-driver and a live model. cua-driver is a\n' +
    'fake MCP server with the result shapes recorded from 0.34.0, and buddyd’s\n' +
    'reading is a stub — so what is asserted is buddy’s side: what is classified,\n' +
    'what is dispatched, in what order, and what goes back to the model. See\n' +
    'spike/cua-driver/FINDINGS.md for the live runs.\n\n';
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
