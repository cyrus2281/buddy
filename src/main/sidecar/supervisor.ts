import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RpcClient } from './client.js';
import { log } from '../log.js';
import type {
  CaptureResult,
  DisplayInfo,
  FrontmostSnapshot,
  Permissions,
  SidecarStatus,
} from '../../shared/types.js';
import type { TargetInfo } from '../agent/guardrails.js';

/// Spawns and supervises `buddyd`. Restarts it on crash with backoff, gives up
/// after a burst of immediate failures rather than spinning, and surfaces the
/// state so Settings can show "sidecar down" instead of the app just going
/// quiet.

const HEALTH_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** More than this many restarts inside the window means the binary is broken,
 *  not unlucky; restarting harder will not fix it. */
const CRASH_BURST = 5;
const CRASH_WINDOW_MS = 60_000;

export class Sidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rpc: RpcClient | null = null;
  private restarts = 0;
  private recentCrashes: number[] = [];
  private backoff = 500;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private version: string | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private givenUp = false;

  /** Resolved once the sidecar has answered a ping, so callers can await
   *  readiness instead of racing the spawn. */
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;

  binaryPath(): string {
    // Packaged: Contents/MacOS/buddyd, beside the Electron executable and under
    // the same code signature — the arrangement R1 tests.
    const packaged = path.join(path.dirname(process.execPath), 'buddyd');
    if (fs.existsSync(packaged)) return packaged;

    // Development. `app.getAppPath()` is the project root under electron-vite
    // dev but the entry's own directory when the built main is run directly, so
    // walk up rather than assuming either. M2 cannot do anything at all without
    // buddyd; guessing one path and failing was a launch-mode trap.
    let dir = app.getAppPath();
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'sidecar', 'build', 'buddyd');
      if (fs.existsSync(candidate)) return candidate;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return path.join(app.getAppPath(), 'sidecar', 'build', 'buddyd');
  }

  async start(): Promise<void> {
    if (this.proc) return this.ready ?? Promise.resolve();
    this.stopping = false;
    const bin = this.binaryPath();

    if (!fs.existsSync(bin)) {
      this.lastError = `buddyd not found at ${bin} — run: npm run build:sidecar`;
      log.error('sidecar', 'binary missing', { path: bin });
      this.emit('status', this.status());
      throw new Error(this.lastError);
    }

    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });

    log.info('sidecar', 'spawning', { path: bin });
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.startedAt = Date.now();
    this.rpc = new RpcClient(this.proc);

    this.rpc.onNotification('human_input', (p) => {
      for (const fn of this.humanInputHandlers) fn(p);
    });

    this.rpc.onNotification('ready', (p) => {
      this.version = p?.version ?? null;
      this.backoff = 500;
      log.info('sidecar', 'ready', { version: this.version, pid: this.proc?.pid });
      this.markReady?.();
      this.emit('status', this.status());
    });

    this.proc.on('error', (e) => {
      this.lastError = e.message;
      log.error('sidecar', 'spawn error', { error: e.message });
      this.emit('status', this.status());
    });

    this.proc.on('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.rpc?.rejectAll('sidecar exited');
      this.proc = null;
      this.rpc = null;
      this.version = null;
      this.startedAt = null;
      if (wasStopping) {
        log.info('sidecar', 'stopped', { code, signal });
        this.emit('status', this.status());
        return;
      }
      this.lastError = `exited code=${code} signal=${signal}`;
      log.warn('sidecar', 'exited unexpectedly', { code, signal });
      this.emit('status', this.status());
      this.scheduleRestart();
    });

    // Don't hang start() forever if the binary spawns but never says ready.
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('sidecar did not report ready within 10s')), 10_000).unref?.(),
    );
    await Promise.race([this.ready, timeout]);

    this.startHealthChecks();
  }

  private scheduleRestart() {
    if (this.stopping || this.givenUp) return;

    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.recentCrashes.push(now);
    if (this.recentCrashes.length >= CRASH_BURST) {
      this.givenUp = true;
      this.lastError = `buddyd crashed ${CRASH_BURST} times in ${CRASH_WINDOW_MS / 1000}s — not restarting`;
      log.error('sidecar', 'crash loop, giving up', { crashes: this.recentCrashes.length });
      this.emit('status', this.status());
      this.emit('gave-up');
      return;
    }

    this.restarts++;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    log.info('sidecar', 'restarting', { inMs: delay, restarts: this.restarts });
    setTimeout(() => {
      this.start().catch((e) => log.error('sidecar', 'restart failed', { error: (e as Error).message }));
    }, delay).unref?.();
  }

  private startHealthChecks() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (!this.rpc || this.stopping) return;
      try {
        await this.rpc.call('ping', {}, 5_000);
      } catch (e) {
        log.warn('sidecar', 'health check failed, killing for restart', { error: (e as Error).message });
        this.proc?.kill('SIGKILL');
      }
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  /** Clears the crash-loop latch. Wired to the Settings "restart sidecar"
   *  button so a user who fixes the underlying problem is not told to relaunch
   *  the whole app. */
  async restartNow(): Promise<void> {
    this.givenUp = false;
    this.recentCrashes = [];
    this.backoff = 500;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const p = this.proc;
    if (!p) return;
    try {
      await this.rpc?.call('shutdown', {}, 1_000);
    } catch {
      /* it may already be gone; SIGTERM covers that */
    }
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

  status(): SidecarStatus {
    return {
      running: !!this.proc,
      pid: this.proc?.pid ?? null,
      version: this.version,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
      captureBackend: 'sidecar',
    };
  }

  private require(): RpcClient {
    if (!this.rpc) throw new Error('sidecar is not running');
    return this.rpc;
  }

  // --- The RPC surface. Everything macOS-specific goes through here. ---

  permissions = () => this.require().call<Permissions>('permissions', {}, 5_000);
  requestPermission = (kind: 'screenRecording' | 'accessibility') =>
    this.require().call<{ requested: boolean; granted: boolean }>('request_permission', { kind }, 30_000);
  frontmost = () => this.require().call<FrontmostSnapshot>('frontmost', {}, 5_000);
  secureInput = () =>
    this.require().call<{ enabled: boolean; likelyHolder: string }>('secure_input', {}, 5_000);
  focusedElement = () =>
    this.require().call<{ focused: unknown; isSecureTextField: boolean }>('focused_element', {}, 5_000);
  displays = () => this.require().call<{ displays: DisplayInfo[] }>('displays', {}, 10_000);
  axTree = (params: { pid?: number; depth?: number; maxNodes?: number } = {}) =>
    this.require().call('ax_tree', params, 10_000);
  input = (action: Record<string, unknown>) => this.require().call('input', action, 45_000);

  /** The one call the guardrail makes immediately before every dispatch: the
   *  frontmost app, the focused element, the page URL, and the element under
   *  the pointer, in one round trip (PRD §7.2). */
  targetInfo = (point?: { x: number; y: number }) =>
    this.require().call<TargetInfo>('target_info', point ? { x: point.x, y: point.y } : {}, 8_000);

  /** §7.3 kill switch 3. buddyd runs a listen-only event tap and filters out
   *  buddy's own events by their `BUDDY_MAGIC` tag, so this only fires on real
   *  human input. */
  watchInput = () => this.require().call<{ watching: boolean }>('watch_input', {}, 5_000);
  unwatchInput = () => this.require().call<{ watching: boolean }>('unwatch_input', {}, 5_000);

  /** Survives a sidecar restart: the handler is registered against the
   *  supervisor, and re-attached to each new RpcClient in `start()`. */
  onHumanInput(fn: (p: { kind: string; t: number }) => void) {
    this.humanInputHandlers.add(fn);
    return () => this.humanInputHandlers.delete(fn);
  }
  private humanInputHandlers = new Set<(p: { kind: string; t: number }) => void>();
  capture = (params: {
    path: string;
    target?: 'display' | 'window' | 'region';
    displayId?: number;
    windowId?: number;
    region?: { x: number; y: number; w: number; h: number };
    maxWidth?: number;
    maxHeight?: number;
  }) => this.require().call<CaptureResult>('capture', params, 20_000);
}

export const sidecar = new Sidecar();
