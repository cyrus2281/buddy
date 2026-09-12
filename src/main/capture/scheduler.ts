import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sidecar } from '../sidecar/supervisor.js';
import { frames } from '../store/frames.js';
import { paths } from '../paths.js';
import { log } from '../log.js';
import { Exclusions } from './exclusions.js';
import { phashDistance } from './phash.js';
import type { CaptureStats, FrontmostSnapshot, Settings } from '../../shared/types.js';

/// The Observer's cheap half (PRD §5). Two tiers run in M1:
///
///   T0 — every 2 s, free: frontmost app, window title, idle seconds. This is
///        what detects context switches, and in M3 it is also the event log T2
///        reads.
///   T1 — every 15 s: screenshot, perceptual hash, discard if it looks like the
///        last kept frame *and* the app has not changed. Expect to keep 20–35 %.
///
/// The "and the app has not changed" half matters: two different apps can hash
/// close together (two dark editors, two terminal windows), and throwing away a
/// context switch is exactly the frame that was worth keeping.

export interface T0Signal {
  ts: number;
  bundleId: string;
  appName: string;
  windowTitle: string;
  idleSeconds: number;
  secureInput: boolean;
  /** True when this signal differs from the previous one in app or title. */
  contextSwitch: boolean;
}

const SIGNAL_BUFFER = 300; // 10 minutes at 2 s — what the Context Bundle asks for

export class CaptureScheduler extends EventEmitter {
  private signalTimer: NodeJS.Timeout | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private running = false;
  private capturing = false;
  private settings: Settings;
  private exclusions: Exclusions;
  private signals: T0Signal[] = [];
  private lastSignal: T0Signal | null = null;
  private lastKept: { phash: string; bundleId: string } | null = null;
  private startedAt: number | null = null;

  private stats: CaptureStats = {
    considered: 0,
    kept: 0,
    skippedDuplicate: 0,
    skippedExcluded: 0,
    skippedSecureInput: 0,
    skippedIdle: 0,
    errors: 0,
    lastCaptureAt: null,
    lastKeptAt: null,
    framesOnDisk: 0,
    bytesOnDisk: 0,
    observingSinceMs: null,
  };

  constructor(settings: Settings) {
    super();
    this.settings = settings;
    this.exclusions = new Exclusions(settings.exclusions);
  }

  updateSettings(s: Settings) {
    const intervalChanged =
      s.captureIntervalMs !== this.settings.captureIntervalMs ||
      s.signalIntervalMs !== this.settings.signalIntervalMs;
    const wasPaused = this.settings.paused;
    this.settings = s;
    this.exclusions.update(s.exclusions);

    if (s.paused && !wasPaused) this.stop();
    else if (!s.paused && wasPaused) this.start();
    else if (intervalChanged && this.running) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (this.running || this.settings.paused) return;
    this.running = true;
    this.startedAt = Date.now();
    this.refreshDiskStats();

    this.signalTimer = setInterval(() => void this.tickSignal(), this.settings.signalIntervalMs);
    this.frameTimer = setInterval(() => void this.tickFrame(), this.settings.captureIntervalMs);
    this.signalTimer.unref?.();
    this.frameTimer.unref?.();

    log.info('capture', 'observing', {
      signalMs: this.settings.signalIntervalMs,
      frameMs: this.settings.captureIntervalMs,
    });
    void this.tickSignal();
    this.emit('stats', this.getStats());
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.signalTimer) clearInterval(this.signalTimer);
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.signalTimer = this.frameTimer = null;
    this.startedAt = null;
    log.info('capture', 'stopped observing');
    this.emit('stats', this.getStats());
  }

  isRunning() {
    return this.running;
  }

  recentSignals(sinceMs = 300_000): T0Signal[] {
    const cutoff = Date.now() - sinceMs;
    return this.signals.filter((s) => s.ts >= cutoff);
  }

  getStats(): CaptureStats {
    return {
      ...this.stats,
      observingSinceMs: this.startedAt,
    };
  }

  /** Keep rate, the number PRD §5 says to watch. Null until there is something
   *  to divide by, so the UI shows "—" rather than a confident 0 %. */
  keepRate(): number | null {
    return this.stats.considered === 0 ? null : this.stats.kept / this.stats.considered;
  }

  // --- T0 -----------------------------------------------------------------

  private async tickSignal() {
    if (!this.running) return;
    let front: FrontmostSnapshot;
    try {
      front = await sidecar.frontmost();
    } catch (e) {
      log.debug('capture', 'T0 signal failed', { error: (e as Error).message });
      return;
    }

    const contextSwitch =
      !this.lastSignal ||
      this.lastSignal.bundleId !== front.bundleId ||
      this.lastSignal.windowTitle !== front.windowTitle;

    const signal: T0Signal = {
      ts: Date.now(),
      bundleId: front.bundleId,
      appName: front.appName,
      windowTitle: front.windowTitle,
      idleSeconds: front.idleSeconds,
      secureInput: front.secureInput,
      contextSwitch,
    };

    this.signals.push(signal);
    if (this.signals.length > SIGNAL_BUFFER) this.signals.shift();
    this.lastSignal = signal;
    this.emit('signal', signal);

    // A context switch is the one moment a 15 s cadence reliably misses, and in
    // M3 it is also what triggers a T2 observation. Capture out of band.
    if (contextSwitch && this.stats.lastCaptureAt && Date.now() - this.stats.lastCaptureAt > 3_000) {
      void this.tickFrame('context-switch');
    }
  }

  // --- T1 -----------------------------------------------------------------

  private async tickFrame(trigger: 'interval' | 'context-switch' = 'interval') {
    if (!this.running || this.capturing) return;
    this.capturing = true;
    let staged: string | null = null;
    try {
      const front = await sidecar.frontmost();

      // Nobody is at the machine. Capturing the same idle desktop 240 times an
      // hour costs disk and tells the Observer nothing.
      if (front.idleSeconds > this.settings.idleSkipSeconds) {
        this.stats.skippedIdle++;
        this.emit('stats', this.getStats());
        return;
      }

      let focusedSecure = false;
      try {
        focusedSecure = (await sidecar.focusedElement()).isSecureTextField;
      } catch {
        // Accessibility not granted yet. `front.secureInput` still covers the
        // OS-wide case, which is the more common one.
      }

      const ex = this.exclusions.check(front, focusedSecure);
      if (ex.skip) {
        if (ex.reason === 'secure-input') this.stats.skippedSecureInput++;
        else this.stats.skippedExcluded++;
        log.debug('capture', 'frame skipped', { reason: ex.reason, rule: ex.rule, app: front.appName });
        this.emit('stats', this.getStats());
        return;
      }

      // Stage first, decide second. A frame that turns out to be a duplicate is
      // unlinked and never enters the vault or the database.
      fs.mkdirSync(paths.staging(), { recursive: true, mode: 0o700 });
      staged = path.join(paths.staging(), `${Date.now()}-${crypto.randomUUID()}.png`);

      const shot = await sidecar.capture({ path: staged, target: 'display' });
      this.stats.considered++;
      this.stats.lastCaptureAt = Date.now();

      // The §6.2 guard. 1.0 is the common path; anything else means the
      // executor must divide by it, and a silent mismatch is the worst failure
      // mode in this product, so it gets a loud line every time.
      if (shot.scale !== 1) {
        log.warn('capture', 'coordinate scale is not 1.0 — executor must divide by it', {
          scale: shot.scale,
          logical: `${shot.logicalWidth}x${shot.logicalHeight}`,
          captured: `${shot.width}x${shot.height}`,
        });
      }

      const distance = this.lastKept ? phashDistance(shot.phash, this.lastKept.phash) : 64;
      const sameApp = this.lastKept?.bundleId === front.bundleId;
      const duplicate = sameApp && distance < this.settings.phashThreshold;

      if (duplicate) {
        this.stats.skippedDuplicate++;
        fs.unlinkSync(staged);
        staged = null;
        log.debug('capture', 'duplicate discarded', { distance, app: front.appName });
        this.emit('stats', this.getStats());
        return;
      }

      const row = frames.keep({
        ts: Date.now(),
        displayId: shot.displayId,
        stagingPath: staged,
        w: shot.width,
        h: shot.height,
        bundleId: front.bundleId,
        appName: front.appName,
        windowTitle: front.windowTitle,
        phash: shot.phash,
        retentionDays: this.settings.retentionDays,
      });
      staged = null;

      this.lastKept = { phash: shot.phash, bundleId: front.bundleId };
      this.stats.kept++;
      this.stats.lastKeptAt = row.ts;
      this.stats.framesOnDisk++;
      this.stats.bytesOnDisk += shot.bytes;

      log.info('capture', 'frame kept', {
        id: row.id,
        trigger,
        app: front.appName,
        distance: distance === 64 ? 'first' : distance,
        keepRate: this.keepRate()?.toFixed(2),
        kb: Math.round(shot.bytes / 1024),
      });
      this.emit('frame', row);
      this.emit('stats', this.getStats());
    } catch (e) {
      this.stats.errors++;
      log.warn('capture', 'frame capture failed', { error: (e as Error).message });
      this.emit('stats', this.getStats());
    } finally {
      if (staged) {
        try {
          fs.unlinkSync(staged);
        } catch {
          /* the retention sweep collects stale staging files */
        }
      }
      this.capturing = false;
    }
  }

  /** Recomputed after a retention sweep, which changes both numbers. */
  refreshDiskStats() {
    const { count, bytes } = frames.countLive();
    this.stats.framesOnDisk = count;
    this.stats.bytesOnDisk = bytes;
    this.emit('stats', this.getStats());
  }
}
