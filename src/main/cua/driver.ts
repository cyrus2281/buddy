import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

/// `cua-driver mcp`, spawned and supervised the way `sidecar/supervisor.ts`
/// supervises buddyd: restarted with backoff when it dies, given up on after a
/// burst of immediate failures, and failing with one sentence a person can act
/// on when the binary is missing or has no grants.
///
/// **Minimal JSON-RPC rather than `@modelcontextprotocol/sdk`.** buddy uses
/// three MCP methods — `initialize`, `tools/call`, `tools/list` — over
/// newline-delimited JSON on stdio, which is the same framing buddyd already
/// speaks. The SDK would bring its own zod major and transport layer for that,
/// and its stdio transport owns the child process, which is the thing this file
/// exists to own: the kill switch cancels in-flight calls here, and a restart
/// has to be visible to the executor because it ends the MCP session and every
/// element token with it. Same reasoning as `OpenAICompatibleClient` in
/// `providers.ts`: no dependency for a one-call surface.
///
/// **Proxy mode, not `--direct`.** Plain `cua-driver mcp` proxies to the
/// CuaDriver.app daemon, which LaunchServices starts as its own responsible
/// process, so macOS attributes Accessibility and Screen Recording to
/// `com.trycua.driver` — not to buddy. Rebuilding buddy cannot revoke them.
/// The price is a second pair of grants; see spike/cua-driver/FINDINGS.md.

/** One sentence each, with one author: `providers.operatorAvailability()`
 *  shows the user these exact strings, and the executor fails with them. */
export const CUA_DRIVER_MISSING =
  'cua-driver is not installed, and the cua Operator backend runs through it. Install it ' +
  '(spike/cua-driver/FINDINGS.md has the command) or set Settings → Operator backend back to ' +
  'the toolset.';

export const CUA_DRIVER_UNGRANTED =
  'cua-driver does not have Accessibility and Screen Recording. Those grants belong to ' +
  'CuaDriver.app, not to buddy — run `cua-driver permissions grant` once, or set Settings → ' +
  'Operator backend back to the toolset.';

/** Where the binary is. `BUDDY_CUA_DRIVER` first, so a check can point at a
 *  stand-in; then the installer's two locations. */
export function cuaBinaryPath(): string | null {
  const candidates = [
    process.env.BUDDY_CUA_DRIVER,
    '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
    path.join(os.homedir(), '.local/bin/cua-driver'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export type CuaContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

export interface CuaToolResult {
  content: CuaContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface CuaDriverStatus {
  running: boolean;
  pid: number | null;
  version: string | null;
  restarts: number;
  lastError: string | null;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const MAX_BACKOFF_MS = 30_000;
const CRASH_BURST = 5;
const CRASH_WINDOW_MS = 60_000;
const PROTOCOL_VERSION = '2025-06-18';

export interface CuaDriverOptions {
  /** Defaults to `cuaBinaryPath()`. */
  bin?: string | null;
  /** Defaults to `['mcp']`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Skip the permission preflight — for a stand-in that has no TCC to ask. */
  skipPermissionCheck?: boolean;
}

export class CuaDriver extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private starting: Promise<void> | null = null;
  private stopping = false;
  private version: string | null = null;
  private restarts = 0;
  private recentCrashes: number[] = [];
  private backoff = 500;
  private lastError: string | null = null;
  private givenUp = false;
  private session = 0;

  constructor(private opts: CuaDriverOptions = {}) {
    super();
  }

  /** Bumped each time an MCP session is established. Snapshots and element
   *  tokens belong to one session; anything older is gone on the other side. */
  get generation(): number {
    return this.session;
  }

  status(): CuaDriverStatus {
    return {
      running: !!this.proc,
      pid: this.proc?.pid ?? null,
      version: this.version,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  /** Spawn, `initialize`, and check the grants — once; concurrent callers
   *  share the attempt. */
  ensureStarted(): Promise<void> {
    if (this.proc && !this.starting) return Promise.resolve();
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.givenUp) throw new Error(this.lastError ?? 'cua-driver is not restarting.');
    const bin = this.opts.bin === undefined ? cuaBinaryPath() : this.opts.bin;
    if (!bin || !fs.existsSync(bin)) {
      this.lastError = CUA_DRIVER_MISSING;
      throw new Error(CUA_DRIVER_MISSING);
    }
    this.stopping = false;
    const args = this.opts.args ?? ['mcp'];
    log.info('cua', 'spawning', { bin, args });
    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Telemetry off for every process buddy starts, whatever the user's
      // persisted preference — buddy's runs are buddy's to report on.
      env: { ...process.env, ...this.opts.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    this.buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) log.debug('cua', 'stderr', { line: line.slice(0, 400) });
    });
    proc.on('error', (e) => {
      this.lastError = e.message;
      log.error('cua', 'spawn error', { error: e.message });
    });
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));

    try {
      const init = await this.request<{ serverInfo?: { version?: string } }>(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'buddy', version: '0.1.0' } },
        20_000,
      );
      this.version = init?.serverInfo?.version ?? null;
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (!this.opts.skipPermissionCheck) {
        const perm = await this.request<CuaToolResult>(
          'tools/call',
          { name: 'check_permissions', arguments: { prompt: false } },
          20_000,
        );
        const sc = perm?.structuredContent ?? {};
        if (sc.accessibility !== true || sc.screen_recording !== true) {
          this.lastError = CUA_DRIVER_UNGRANTED;
          log.warn('cua', 'cua-driver is not granted', { source: sc.source });
          throw new Error(CUA_DRIVER_UNGRANTED);
        }
      }
      this.backoff = 500;
      this.lastError = null;
      this.session++;
      log.info('cua', 'ready', { version: this.version, pid: proc.pid });
      this.emit('ready');
    } catch (e) {
      // A process that will not initialise or has no grants is not one to keep
      // around half-started; the next call starts it again.
      this.stopping = true;
      proc.kill('SIGKILL');
      if (this.proc === proc) this.proc = null;
      throw e;
    }
  }

  /** One `tools/call`. A refusal (`isError: true`) resolves — it is a result
   *  the executor reads; only transport failures reject. */
  async call(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<CuaToolResult> {
    await this.ensureStarted();
    return this.request<CuaToolResult>('tools/call', { name, arguments: args }, timeoutMs);
  }

  async listTools(): Promise<{ tools: { name: string }[] }> {
    await this.ensureStarted();
    return this.request('tools/list', {}, 20_000);
  }

  /**
   * The kill switch's hand on cua-driver: every in-flight call is cancelled
   * (MCP `notifications/cancelled`) and rejected now, so the run halts within
   * the step it was in rather than after a long `type_text` finishes. What the
   * daemon has already posted to an app cannot be taken back; this stops buddy
   * waiting for it and sending anything more.
   */
  cancelInFlight(reason: string): number {
    let n = 0;
    for (const [id, p] of this.pending) {
      if (p.method === 'initialize') continue;
      this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
      clearTimeout(p.timer);
      p.reject(new Error(`cancelled: ${reason}`));
      this.pending.delete(id);
      n++;
    }
    if (n) log.warn('cua', 'cancelled in-flight calls', { n, reason });
    return n;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const p = this.proc;
    if (!p) return;
    p.stdin.end();
    p.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 2_000);
      t.unref?.();
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  private write(msg: Record<string, unknown>) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.proc?.stdin.writable) return Promise.reject(new Error(`cua-driver is not running; cannot call ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } });
        reject(new Error(`cua-driver did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn('cua', 'dropped a line that is not JSON', { line: line.slice(0, 200) });
        continue;
      }
      if (msg.method && msg.id != null) {
        // A request from the server. buddy declares no client capabilities, so
        // the only one it can expect is a ping.
        this.write(
          msg.method === 'ping'
            ? { jsonrpc: '2.0', id: msg.id, result: {} }
            : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `buddy does not serve ${msg.method}` } },
        );
        continue;
      }
      if (msg.id == null) continue; // a notification; buddy subscribes to none
      const p = this.pending.get(Number(msg.id));
      if (!p) continue;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`cua-driver ${p.method}: ${msg.error.message ?? 'error'} (code ${msg.error.code ?? '?'})`));
      else p.resolve(msg.result);
    }
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`cua-driver exited (pending ${p.method})`));
      this.pending.delete(id);
    }
    if (this.proc !== proc) return;
    this.proc = null;
    this.version = null;
    // Whatever the reason, the MCP session is gone, and every snapshot and
    // element token it held with it.
    this.emit('session-lost');
    if (this.stopping) {
      log.info('cua', 'stopped', { code, signal });
      return;
    }
    this.lastError = `cua-driver exited code=${code} signal=${signal}`;
    log.warn('cua', 'exited unexpectedly', { code, signal });
    this.scheduleRestart();
  }

  private scheduleRestart() {
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.recentCrashes.push(now);
    if (this.recentCrashes.length >= CRASH_BURST) {
      this.givenUp = true;
      this.lastError = `cua-driver crashed ${CRASH_BURST} times in ${CRASH_WINDOW_MS / 1000}s — not restarting`;
      log.error('cua', 'crash loop, giving up', { crashes: this.recentCrashes.length });
      return;
    }
    this.restarts++;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    log.info('cua', 'restarting', { inMs: delay, restarts: this.restarts });
    setTimeout(() => {
      this.ensureStarted().catch((e) => log.error('cua', 'restart failed', { error: (e as Error).message }));
    }, delay).unref?.();
  }
}

/** The one the app uses. Started lazily by the first run on the cua backend,
 *  so a person who never turns it on never has the process running. */
export const cuaDriver = new CuaDriver();
