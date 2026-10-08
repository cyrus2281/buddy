/**
 * The cua spike's comparison runs: `live-run.ts`'s TextEdit + Calculator task,
 * on each Operator configuration, measured the same way.
 *
 *   npm run live:cua -- --config <name> [--runs 3]
 *
 * Configs — every model call goes through the LiteLLM gateway, with its key
 * (`LITELLM_API_KEY`) and a model id it serves (`LITELLM_MODEL`); no other
 * provider key is read. `LITELLM_BASE_URL` defaults to https://lite-llm.mymaas.net.
 *
 *   toolset-gateway   Claude + computer_toolset_20260801 through the gateway
 *   cua-gateway       Claude + cua-driver tools through the gateway (Messages API)
 *   cua-gateway-chat  the same model + cua-driver tools through the gateway's
 *                     OpenAI-compatible /v1/chat/completions — the OpenAI adapter
 *   gateway-probe     the gateway's model list, then one tiny request each with
 *                     the toolset, the cua tools, the toolset over LiteLLM's
 *                     /anthropic pass-through, and the chat route
 *                     (`--probe <text>` runs only the matching ones)
 *   smoke             no model: the real cua-driver and the real buddyd guardrail
 *                     path against Calculator. Costs nothing.
 *
 * Each run appends one JSON line to spike/cua-driver/results.jsonl: success,
 * steps, wall time, cost, guardrail verdicts and the failure mode. Gates are
 * auto-denied, as in `live-run.ts`, so nothing waits holding the keyboard.
 *
 * This spends money and drives the machine. It is run by hand, with the
 * person's go-ahead, one batch at a time.
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
import { Executor } from './agent/executor.js';
import { AnthropicClient, type ModelClient, type ModelResponse } from './agent/client.js';
import { OpenAIChatModelClient } from './agent/openai-client.js';
import { operatorPricer, type Pricer } from './agent/budget.js';
import { killSwitches } from './agent/killswitch.js';
import { buildCuaTools, buildTools } from './agent/tools.js';
import { CUA_PROMPT_VERSION } from './agent/prompt.js';
import { anthropicModel } from './notes/model.js';
import { CuaExecutor } from './cua/executor.js';
import { cuaDriver } from './cua/driver.js';
import type { Allowlist, PendingGate, RunView } from '../shared/types.js';

const ALLOWLIST: Allowlist = { apps: ['com.apple.TextEdit', 'com.apple.calculator'], domains: [] };
const BUDGETS = { maxSteps: 60, maxWallClockMs: 5 * 60_000, maxCostUsd: 1.0 };
const FIRST_PARTY = 'https://api.anthropic.com';

const task = (doc: string) =>
  `The TextEdit document "${doc}" is open. It has two numbers in it and a line ` +
  'reading "TOTAL:". Add the two numbers together using the Calculator app, then switch back to ' +
  'TextEdit and type the total immediately after "TOTAL:" on that line. Do not change anything ' +
  'else in the document. Call finish when the total is written.';

interface Config {
  backend: 'toolset' | 'cua';
  client: () => ModelClient;
  model: string;
  price: Pricer;
  endpoint: string;
}

/** A missing input. Thrown rather than `process.exit`ed: Electron's exit does
 *  not stop the caller on the spot, so the run would carry on without it. */
class Missing extends Error {}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Missing(`${name} is not set. Nothing to run against.`);
  return v;
}

function config(name: string): Config {
  // LiteLLM only: every model call in this harness goes through the gateway,
  // with the gateway's key. No direct provider keys are read.
  const gateway = process.env.LITELLM_BASE_URL?.trim() || 'https://lite-llm.mymaas.net';
  const key = need('LITELLM_API_KEY');
  const model = need('LITELLM_MODEL');
  switch (name) {
    case 'toolset-gateway':
    case 'cua-gateway':
      return {
        backend: name === 'toolset-gateway' ? 'toolset' : 'cua',
        client: () => new AnthropicClient(key, gateway),
        model,
        price: operatorPricer('anthropic', model).price,
        endpoint: gateway,
      };
    case 'cua-gateway-chat':
      // The OpenAI-compatible adapter, end to end, through the gateway's own
      // /v1/chat/completions — the only live test of it that needs no other key.
      return {
        backend: 'cua',
        client: () =>
          new OpenAIChatModelClient({ baseUrl: `${gateway.replace(/\/$/, '')}/v1`, apiKey: key, label: 'LiteLLM (chat)', flavor: 'openai' }),
        model,
        price: operatorPricer('openai', model).price,
        endpoint: `${gateway}/v1/chat/completions`,
      };
    default:
      throw new Missing(`Unknown --config ${name}. Use toolset-gateway, cua-gateway, cua-gateway-chat, gateway-probe or smoke.`);
  }
}

class ObservedClient implements ModelClient {
  turns = 0;
  errors: string[] = [];
  maxCacheRead = 0;
  constructor(private inner: ModelClient) {}
  async create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    try {
      const res = await this.inner.create(params);
      this.turns++;
      this.maxCacheRead = Math.max(this.maxCacheRead, res.usage.cache_read_input_tokens ?? 0);
      return res;
    } catch (e) {
      this.errors.push((e as Error).message.slice(0, 300));
      throw e;
    }
  }
}

function prepareDocument(name: string): { a: number; b: number; file: string } {
  const a = 1_000 + Math.floor(Math.random() * 8_000);
  const b = 1_000 + Math.floor(Math.random() * 8_000);
  const file = path.join(paths.scratch(), name);
  fs.mkdirSync(paths.scratch(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    ['buddy cua spike — scratch document. Safe to delete.', '', `First number: ${a}`, `Second number: ${b}`, '', 'TOTAL:', ''].join('\n'),
  );
  return { a, b, file };
}

/** The document as TextEdit has it — typed text that was never saved counts. */
function documentText(name: string, file: string): string {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', `tell application "TextEdit" to get text of document "${name}"`], {
      encoding: 'utf8',
    });
  } catch {
    return fs.readFileSync(file, 'utf8');
  }
}

function osa(script: string) {
  try {
    execFileSync('/usr/bin/osascript', ['-e', script]);
  } catch {
    /* tidy-up is best effort */
  }
}

async function one(cfgName: string, cfg: Config, n: number): Promise<Record<string, unknown>> {
  const doc = `buddy-cua-${cfgName}-${n}-${Date.now().toString(36)}.txt`;
  const { a, b, file } = prepareDocument(doc);
  const expected = a + b;
  execFileSync('/usr/bin/open', ['-a', 'Calculator']);
  execFileSync('/usr/bin/open', ['-a', 'TextEdit', file]);
  await new Promise((r) => setTimeout(r, 1_500));
  osa('tell application "TextEdit" to activate');
  await new Promise((r) => setTimeout(r, 1_500));

  const observed = new ObservedClient(cfg.client());
  const runner = new AgentRunner({
    client: observed,
    killSwitches,
    executor: cfg.backend === 'cua' ? new CuaExecutor() : new Executor(),
    model: cfg.model,
    price: cfg.price,
  });
  const gates: PendingGate[] = [];
  runner.on('gate', (g: PendingGate) => {
    gates.push(g);
    fs.writeSync(1, `  GATE  ${g.verdict.class} on ${g.verdict.target} — denying\n`);
    runner.resolveGate('deny');
  });
  runner.on('step', (s: { idx: number; tool: string; result: unknown; isError: boolean }) => {
    fs.writeSync(1, `  ${String(s.idx).padStart(3)} ${s.isError ? '✗' : ' '} ${s.tool.padEnd(18)} ${String(s.result).replace(/\s+/g, ' ').slice(0, 90)}\n`);
  });

  fs.writeSync(1, `\n── ${cfgName} #${n} — ${cfg.model} @ ${cfg.endpoint}\n   ${a} + ${b} = ${expected}\n`);
  const t0 = Date.now();
  const view: RunView = await runner.run({ goal: task(doc), profile: 'attended', allowlist: ALLOWLIST, budgets: BUDGETS });
  const wallMs = Date.now() - t0;

  const text = documentText(doc, file);
  const totalLine = text.split(/\r?\n|\r/).find((l) => l.startsWith('TOTAL:')) ?? '';
  const wrote = totalLine.replace('TOTAL:', '').replace(/[^0-9]/g, '');
  const correct = wrote === String(expected);
  osa(`tell application "TextEdit" to close (every document whose name is "${doc}") saving no`);
  fs.rmSync(file, { force: true });

  const verdicts: Record<string, number> = {};
  for (const s of view.steps) {
    if (!s.verdict) continue;
    const k = `${s.verdict.decision}:${s.verdict.class}`;
    verdicts[k] = (verdicts[k] ?? 0) + 1;
  }
  const input = (s: { input: unknown }) => (s.input ?? {}) as Record<string, unknown>;
  const row = {
    at: new Date().toISOString(),
    config: cfgName,
    run: n,
    prompt: cfg.backend === 'cua' ? CUA_PROMPT_VERSION : 'toolset',
    model: cfg.model,
    endpoint: cfg.endpoint,
    status: view.status,
    correct,
    wrote: totalLine.trim(),
    expected,
    steps: view.usage.steps,
    turns: observed.turns,
    wallS: Math.round(wallMs / 100) / 10,
    costUsd: Number(view.usage.costUsd.toFixed(4)),
    maxCacheRead: observed.maxCacheRead,
    verdicts,
    gates: gates.map((g) => `${g.verdict.class}/${g.verdict.target}`),
    toolErrors: view.steps.filter((s) => s.isError).length,
    foreground: view.steps.filter((s) => input(s).delivery_mode === 'foreground' || s.tool === 'drag').length,
    elementTokens: view.steps.filter((s) => typeof input(s).element_token === 'string').length,
    pixelActions: view.steps.filter((s) => typeof input(s).x === 'number').length,
    failure: correct && view.status === 'done' ? null : (view.haltReason ?? view.outcome?.summary ?? view.status),
    apiErrors: observed.errors,
  };
  fs.writeSync(
    1,
    `   → ${row.status}, ${correct ? 'CORRECT' : 'WRONG'} ("${row.wrote}"), ${row.steps} steps, ${row.wallS}s, $${row.costUsd}` +
      `${row.apiErrors.length ? `, API errors: ${row.apiErrors.join(' | ')}` : ''}\n`,
  );
  fs.appendFileSync(path.join(process.cwd(), 'spike/cua-driver/results.jsonl'), JSON.stringify(row) + '\n');
  return row;
}

/** The gateway question on its own: does the same endpoint reject the toolset
 *  entry and accept the cua function tools? One request each, a few tokens. */
async function gatewayProbe() {
  const gateway = process.env.LITELLM_BASE_URL?.trim() || 'https://lite-llm.mymaas.net';
  const key = need('LITELLM_API_KEY');
  const model = need('LITELLM_MODEL');
  fs.writeSync(1, `\ngateway probe — ${model} @ ${gateway}\n\n`);

  // What the gateway serves. Free; tells us which ids exist before spending.
  try {
    const res = await fetch(`${gateway.replace(/\/$/, '')}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    const json = (await res.json()) as { data?: { id: string }[] };
    const ids = (json.data ?? []).map((m) => m.id).sort();
    fs.writeSync(1, `  models (${ids.length}): ${ids.join(', ').slice(0, 1500)}\n\n`);
  } catch (e) {
    fs.writeSync(1, `  models: could not list (${(e as Error).message})\n\n`);
  }

  const rows: Record<string, unknown>[] = [];
  const messages = [{ role: 'user' as const, content: 'Reply with OK.' }];
  const system = [{ type: 'text' as const, text: 'This is a connection test. Reply with OK and do not call any tool.' }];
  const attempts: [string, () => Promise<{ usage: Anthropic.Messages.Usage | ModelResponse['usage'] }>][] = [
    [
      'messages + toolset',
      () => new AnthropicClient(key, gateway).create({ model, max_tokens: 1024, system, tools: buildTools(), messages } as Anthropic.Messages.MessageCreateParamsNonStreaming),
    ],
    [
      'messages + cua function tools',
      () => new AnthropicClient(key, gateway).create({ model, max_tokens: 1024, system, tools: buildCuaTools(), messages } as Anthropic.Messages.MessageCreateParamsNonStreaming),
    ],
    [
      // LiteLLM's Anthropic pass-through forwards the body as sent, so the
      // `name` it injects on its own /v1/messages route should not happen here.
      'passthrough /anthropic + toolset',
      () =>
        new AnthropicClient(key, `${gateway.replace(/\/$/, '')}/anthropic`).create({
          model,
          max_tokens: 1024,
          system,
          tools: buildTools(),
          messages,
        } as Anthropic.Messages.MessageCreateParamsNonStreaming),
    ],
    [
      'chat/completions + cua tools',
      () =>
        new OpenAIChatModelClient({ baseUrl: `${gateway.replace(/\/$/, '')}/v1`, apiKey: key, label: 'LiteLLM (chat)', flavor: 'openai' }).create({
          model,
          max_tokens: 1024,
          system,
          tools: buildCuaTools(),
          messages,
        } as Anthropic.Messages.MessageCreateParamsNonStreaming),
    ],
  ];
  // `--probe <text>` runs only the attempts whose label contains it.
  const only = process.argv.includes('--probe') ? process.argv[process.argv.indexOf('--probe') + 1] : null;
  for (const [label, run] of attempts.filter(([l]) => !only || l.includes(only))) {
    const t0 = Date.now();
    try {
      const res = await run();
      const cost = operatorPricer('anthropic', model).price(res.usage);
      fs.writeSync(1, `  ${label.padEnd(32)} ACCEPTED in ${Date.now() - t0} ms — $${cost.toFixed(4)}\n`);
      rows.push({ label, ok: true, usage: res.usage, costUsd: cost });
    } catch (e) {
      const msg = (e as Error).message.replace(/\s+/g, ' ').slice(0, 300);
      fs.writeSync(1, `  ${label.padEnd(32)} REJECTED — ${msg}\n`);
      rows.push({ label, ok: false, error: msg });
    }
  }
  fs.appendFileSync(
    path.join(process.cwd(), 'spike/cua-driver/results.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), config: 'gateway-probe', model, endpoint: gateway, rows }) + '\n',
  );
}

/** The real executor against the real cua-driver and buddyd, with no model.
 *  What the fake in `check:m5` stands in for, checked once for real. */
async function smoke() {
  const runId = 999_999;
  const exec = new CuaExecutor();
  const ctx = { runId, profile: 'attended' as const, allowlist: ALLOWLIST, lastFrame: null };
  const out = (k: string, v: unknown) => fs.writeSync(1, `  ${k.padEnd(28)} ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
  execFileSync('/usr/bin/open', ['-g', '-a', 'Calculator']);
  await new Promise((r) => setTimeout(r, 1_500));

  const first = await exec.observeFrontmost(runId);
  out('opening frame', first.frame ? `${first.frame.width}x${first.frame.height} ${first.frame.mediaType ?? 'image/png'} @ ${first.frame.scale.toFixed(2)} px/pt` : 'none');
  out('opening header', first.text.split('\n')[0]);

  const lw = await exec.execute('list_windows', { on_screen_only: false }, ctx);
  const m = lw.kind === 'ok' ? /pid (\d+) window (\d+) — Calculator/.exec(lw.text) : null;
  if (!m) throw new Error(`no Calculator window: ${lw.kind === 'ok' ? lw.text.slice(0, 300) : lw.kind}`);
  const [pid, win] = [Number(m[1]), Number(m[2])];
  const snap = await exec.execute('get_window_state', { pid, window_id: win }, ctx);
  if (snap.kind !== 'ok') throw new Error(`get_window_state: ${snap.kind} ${'text' in snap ? snap.text : ''}`);
  const idm = /snapshot (s[0-9a-f]{8})/.exec(snap.text);
  if (!idm) throw new Error(`no snapshot id in: ${snap.text.slice(0, 600)}`);
  const id = idm[1];
  out('snapshot', `${id}, ${snap.frame?.width}x${snap.frame?.height}, verdict ${snap.verdict.decision}:${snap.verdict.class}`);
  const idx = (label: string) => Number(new RegExp(`\\[(\\d+)\\] AXButton \\(${label}\\)`).exec(snap.text)?.[1] ?? -1);
  const seven = idx('7');
  const clear = idx('All Clear') >= 0 ? idx('All Clear') : idx('Delete');
  if (clear >= 0) await exec.execute('click', { pid, element_token: `${id}:${clear}` }, ctx);
  const tok = await exec.execute('click', { pid, element_token: `${id}:${seven}` }, ctx);
  out('token click on 7', tok.kind === 'ok' ? `${tok.verdict.decision}:${tok.verdict.class} on ${tok.verdict.target} — ${tok.text.slice(0, 80)}` : tok.kind);

  // The pixel path: re-snapshot (tokens stale after acting), then click 8 by
  // the centre of its screenshot frame. The guardrail resolves the pixel to a
  // screen point and asks Calculator's own hit test what is there.
  const snap2 = await exec.execute('get_window_state', { pid, window_id: win }, ctx);
  const res = await cuaDriver.call('get_window_state', { pid, window_id: win }, 15_000);
  const eight = ((res.structuredContent?.elements ?? []) as { label?: string; screenshot_frame?: { x: number; y: number; w: number; h: number } }[]).find((e) => e.label === '8');
  // That last call replaced the snapshot the executor holds, so take one more
  // through the executor to make its screenshot the current one.
  await exec.execute('get_window_state', { pid, window_id: win }, ctx);
  out('raw snapshot', `${res.isError ? 'error' : 'ok'}, ${(res.structuredContent?.elements as unknown[] | undefined)?.length ?? 0} elements, 8 ${eight ? 'found' : 'missing'}`);
  if (eight?.screenshot_frame) {
    const f = eight.screenshot_frame;
    const k = (snap2.kind === 'ok' && snap2.frame ? snap2.frame.width : 1) / ((res.structuredContent?.screenshot_width as number) || 1);
    const px = await exec.execute('click', { pid, window_id: win, x: (f.x + f.w / 2) * k, y: (f.y + f.h / 2) * k }, ctx);
    out('pixel click on 8', px.kind === 'ok' ? `${px.verdict.decision}:${px.verdict.class} on ${px.verdict.target} — ${px.text.slice(0, 80)}` : `${px.kind} ${'text' in px ? px.text : ''}`);
  }
  const deny = await exec.execute('type_text', { pid, text: 'sk-abcdefghijklmnopqrstuvwxyz0123' }, ctx);
  out('type an sk- key', deny.kind === 'denied' ? `denied: ${deny.verdict.reason}` : deny.kind);
  const after = await exec.execute('get_window_state', { pid, window_id: win }, ctx);
  out('Calculator now shows', after.kind === 'ok' ? (/AXStaticText = "([^"]*)"/.exec(after.text)?.[1] ?? '?') : after.kind);
  fs.rmSync(path.join(paths.root(), 'runs', String(runId)), { recursive: true, force: true });
}

async function main() {
  // A throwaway data directory, not the person's: the real one may be on a
  // newer schema than this branch, and these runs are measurements, not history.
  const data = path.join(process.cwd(), 'spike/cua-driver/out/live-appdata');
  fs.mkdirSync(data, { recursive: true });
  app.setPath('appData', data);
  app.setPath('userData', path.join(data, 'buddy'));
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();
  const args = process.argv.slice(2);
  const cfgName = args[args.indexOf('--config') + 1] ?? '';
  const runsArg = args.indexOf('--runs');
  const runs = runsArg >= 0 ? Math.max(1, Number(args[runsArg + 1]) || 1) : 3;
  if (cfgName === 'gateway-probe') {
    await gatewayProbe();
    closeDb();
    process.exit(0);
    return;
  }
  if (cfgName === 'smoke') {
    await sidecar.start();
    await cuaDriver.ensureStarted();
    fs.writeSync(1, '\ncua smoke — real cua-driver, real buddyd, no model\n\n');
    await smoke();
    await cuaDriver.stop();
    await sidecar.stop();
    closeDb();
    // Electron's process.exit does not stop this function on the spot.
    process.exit(0);
    return;
  }
  const cfg = config(cfgName);

  await sidecar.start();
  const perms = await sidecar.permissions();
  if (!perms.accessibility || (cfg.backend === 'toolset' && !perms.screenRecording)) {
    fs.writeSync(1, `\nbuddyd needs its grants: accessibility=${perms.accessibility} screenRecording=${perms.screenRecording}\n`);
    process.exit(2);
  }
  if (cfg.backend === 'cua') await cuaDriver.ensureStarted();

  const rows = [];
  for (let n = 1; n <= runs; n++) {
    const row = await one(cfgName, cfg, n);
    rows.push(row);
    // The very first call failing — no credit, a bad key, a model id the
    // endpoint does not serve, a gateway that rejects the request shape — will
    // fail every run the same way. Stop rather than repeat it.
    const errors = row.apiErrors as string[];
    if (row.turns === 0 && errors.length) {
      fs.writeSync(1, `\nStopping the batch: the first model call failed — ${errors[0].slice(0, 200)}\n`);
      break;
    }
  }

  const ok = rows.filter((r) => r.status === 'done' && r.correct).length;
  fs.writeSync(1, `\n${cfgName}: ${ok}/${rows.length} correct. Rows appended to spike/cua-driver/results.jsonl\n`);
  await cuaDriver.stop();
  await sidecar.stop();
  closeDb();
  process.exit(0);
}

app.whenReady().then(main).catch((e) => {
  if (e instanceof Missing) {
    fs.writeSync(1, `\n${e.message}\n`);
    process.exit(2);
    return;
  }
  fs.writeSync(1, `\nlive cua run failed: ${(e as Error).stack}\n`);
  process.exit(1);
});
