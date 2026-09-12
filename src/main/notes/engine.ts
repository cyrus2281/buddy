import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { secrets } from '../secrets.js';
import { observations, notes, tasks } from '../store/notes.js';
import { AnthropicStructuredClient, type StructuredClient } from './model.js';
import { newFramesSince, observe, type ObserverFrame } from './observer.js';
import { rollup, type RollupReason } from './rollup.js';
import { SessionTracker } from './session.js';
import { SpendMeter } from './spend.js';
import type { CaptureScheduler, T0Signal } from '../capture/scheduler.js';
import type { NotesStats, Settings, SpendReport } from '../../shared/types.js';

/// The Observer's upper half, in one place (PRD §5).
///
/// The engine owns three clocks and one rule:
///
///   - T2 every ~3 minutes, and out of band on a context switch.
///   - T3 hourly, at session end, and at midnight.
///   - The daily cap, which pauses both and nothing else (R5).
///
/// The rule is that **only one model call of each tier is ever in flight.** T2's
/// interval is three minutes and a call takes a few seconds, so overlapping
/// should be impossible — but "should be impossible" is how you get two
/// observations of the same frames the first time an API call hangs for four
/// minutes, and the second one costs money to produce a duplicate.

/** What counts as a context switch for T2 (PRD §5).
 *
 *  Deliberately narrower than T1's: the capture scheduler treats any change of
 *  window *title* as a switch, which is right for a free screenshot and ruinous
 *  for a billed model call — a title changes on every keystroke in a document
 *  with an autosaving name. T2 switches on the application, debounced by
 *  `observeMinGapMs`, and only with enough new frames to be worth a look. */
const MIN_FRAMES_FOR_SWITCH = 2;

export interface EngineDeps {
  scheduler: CaptureScheduler;
  /** Injected by the checks so the tiers run against a scripted model. */
  client?: StructuredClient | null;
  settings: Settings;
  now?: () => number;
}

export class NotesEngine extends EventEmitter {
  readonly session: SessionTracker;
  readonly spend: SpendMeter;

  private settings: Settings;
  private scheduler: CaptureScheduler;
  private injectedClient: StructuredClient | null;
  private now: () => number;

  private observeTimer: NodeJS.Timeout | null = null;
  private rollupTimer: NodeJS.Timeout | null = null;
  private midnightTimer: NodeJS.Timeout | null = null;

  private observing = false;
  private rollingUp = false;
  private running = false;

  private lastObservedTs = 0;
  private lastObserveAt = 0;
  private lastRollupAt = 0;
  private lastBundleId = '';

  constructor(deps: EngineDeps) {
    super();
    this.scheduler = deps.scheduler;
    this.settings = deps.settings;
    this.injectedClient = deps.client ?? null;
    this.now = deps.now ?? (() => Date.now());
    this.session = new SessionTracker(deps.settings.sessionIdleMs);
    this.spend = new SpendMeter(deps.settings.dailyCapUsd);

    this.spend.on('changed', (r: SpendReport) => this.emit('spend', r));
    this.spend.on('capped', (r: SpendReport) => this.emit('capped', r));

    // A session ending is T3's most meaningful trigger: it is the only one that
    // lines up with a human boundary rather than a clock.
    this.session.on('end', ({ startedAt, endedAt }: { startedAt: number; endedAt: number }) => {
      tasks.widenScopes('session', endedAt);
      void this.runRollup('session-end', { from: startedAt, to: endedAt });
      this.emit('stats', this.stats());
    });
    this.session.on('start', () => this.emit('stats', this.stats()));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;

    const loaded = this.session.load(this.now());
    if (loaded.closed) {
      // The app was shut or the machine slept with work owed. Roll it up now
      // rather than folding yesterday afternoon into this morning's recap.
      void this.runRollup('session-end', { from: loaded.closed.startedAt, to: loaded.closed.endedAt });
    }
    this.lastObservedTs = observations.latest()?.tsEnd ?? 0;

    this.observeTimer = setInterval(() => void this.maybeObserve('interval'), this.settings.observeIntervalMs);
    this.rollupTimer = setInterval(() => void this.hourly(), this.settings.rollupIntervalMs);
    this.observeTimer.unref?.();
    this.rollupTimer.unref?.();
    this.scheduleMidnight();

    this.scheduler.on('signal', this.onSignal);
    log.info('notes', 'observer engine started', {
      observeMs: this.settings.observeIntervalMs,
      rollupMs: this.settings.rollupIntervalMs,
      capUsd: this.settings.dailyCapUsd,
    });
    this.emit('stats', this.stats());
  }

  stop(endSession = true) {
    if (!this.running) return;
    this.running = false;
    this.scheduler.off('signal', this.onSignal);
    for (const t of [this.observeTimer, this.rollupTimer, this.midnightTimer]) if (t) clearTimeout(t);
    this.observeTimer = this.rollupTimer = this.midnightTimer = null;
    if (endSession) this.session.end(this.now(), 'shutdown');
    log.info('notes', 'observer engine stopped');
  }

  isRunning() {
    return this.running;
  }

  updateSettings(s: Settings) {
    const cadenceChanged =
      s.observeIntervalMs !== this.settings.observeIntervalMs ||
      s.rollupIntervalMs !== this.settings.rollupIntervalMs;
    this.settings = s;
    this.session.setIdleMs(s.sessionIdleMs);
    this.spend.setCap(s.dailyCapUsd);
    if (!s.notesEnabled || s.paused) {
      this.stop(false);
      return;
    }
    if (!this.running) {
      this.start();
      return;
    }
    if (cadenceChanged) {
      this.stop(false);
      this.start();
    }
  }

  // ── T0 → the session, and T2's context-switch trigger ────────────────────

  private onSignal = (s: T0Signal) => {
    this.session.onSignal(s.ts, s.idleSeconds);

    // §5's "immediately on context switch", narrowed to the application. The
    // capture scheduler's own switch includes title changes, which is right for
    // a free screenshot and wrong for a billed call.
    if (!this.lastBundleId) {
      this.lastBundleId = s.bundleId;
      return;
    }
    if (s.bundleId === this.lastBundleId) return;
    this.lastBundleId = s.bundleId;
    void this.maybeObserve('context-switch');
  };

  /** Display sleep, lock, or suspend — §4.1's other session boundary. */
  onSystemSleep() {
    this.session.onSleep(this.now());
  }

  // ── T2 ───────────────────────────────────────────────────────────────────

  /**
   * Run an observation if it is worth running.
   *
   * Four gates, in the order that costs least to evaluate: something already in
   * flight, the tier disabled or paused, the daily cap, then the debounce and
   * the frame count. The cap check is deliberately before the frame query so a
   * capped day does no work at all rather than doing everything up to the call.
   */
  async maybeObserve(trigger: 'interval' | 'context-switch' | 'manual'): Promise<boolean> {
    if (this.observing) return false;
    if (trigger !== 'manual' && (!this.settings.notesEnabled || this.settings.paused)) return false;
    if (!this.spend.allow('t2', this.now())) {
      log.debug('observer', 'skipped: the daily cap is reached', { trigger });
      return false;
    }

    const now = this.now();
    if (trigger === 'context-switch' && now - this.lastObserveAt < this.settings.observeMinGapMs) {
      return false;
    }

    const frames = newFramesSince(this.lastObservedTs);
    if (!frames.length) return false;
    if (trigger === 'context-switch' && frames.length < MIN_FRAMES_FOR_SWITCH) return false;

    const client = this.client();
    if (!client) return false;

    this.observing = true;
    try {
      const result = await observe(client, {
        frames,
        signals: this.scheduler.recentSignals(this.settings.observeIntervalMs * 2),
        trigger,
      });
      this.lastObserveAt = now;
      if (!result) return false;

      this.lastObservedTs = Math.max(this.lastObservedTs, result.observation.tsEnd);
      this.spend.record('t2', result.costUsd, now);
      this.emit('observation', result.observation);
      this.emit('stats', this.stats());
      if (result.injectionNotice) this.emit('injection', { tier: 't2', quote: result.injectionNotice });
      return true;
    } catch (e) {
      log.warn('observer', 'observation failed', { trigger, error: (e as Error).message });
      // The watermark does not move: the frames stay eligible for the next tick
      // rather than being lost to a transient API failure.
      return false;
    } finally {
      this.observing = false;
    }
  }

  // ── T3 ───────────────────────────────────────────────────────────────────

  private async hourly() {
    const now = this.now();
    await this.runRollup('hourly', { from: now - this.settings.rollupIntervalMs, to: now });
  }

  /** PRD §5: hourly, at session end, and at midnight. */
  async runRollup(reason: RollupReason, period: { from: number; to: number }): Promise<boolean> {
    if (this.rollingUp) return false;
    if (reason !== 'manual' && !this.settings.notesEnabled) return false;
    if (!this.spend.allow('t3', this.now())) {
      log.debug('rollup', 'skipped: the daily cap is reached', { reason });
      return false;
    }

    // What is owed is derived from the recaps rather than tracked in memory:
    // a restart mid-period then loses nothing, and an observation written by
    // something other than this engine instance is still covered.
    const obs = observations.byIds(unrolledObservationIds());
    if (!obs.length) return false;

    const client = this.client();
    if (!client) return false;

    this.rollingUp = true;
    try {
      // The recap records exactly the observations it covered, so one written
      // while the call was in flight belongs to the next period rather than
      // being silently swallowed by this one.
      const result = await rollup(client, obs, reason, period);
      if (!result) return false;
      this.lastRollupAt = this.now();
      this.spend.record('t3', result.costUsd, this.lastRollupAt);
      this.emit('rollup', result);
      this.emit('stats', this.stats());
      if (result.injectionNotice) this.emit('injection', { tier: 't3', quote: result.injectionNotice });
      return true;
    } catch (e) {
      log.warn('rollup', 'rollup failed', { reason, error: (e as Error).message });
      return false;
    } finally {
      this.rollingUp = false;
    }
  }

  /** Midnight: roll up the day, then widen every day-scoped task to week. */
  private scheduleMidnight() {
    const now = new Date(this.now());
    const next = new Date(now);
    next.setHours(24, 0, 5, 0); // five seconds past, so the day key has turned
    const delay = Math.max(1_000, next.getTime() - now.getTime());
    this.midnightTimer = setTimeout(() => {
      const at = this.now();
      void this.runRollup('midnight', { from: at - 86_400_000, to: at }).finally(() => {
        tasks.widenScopes('day', at);
        this.scheduleMidnight();
      });
    }, delay);
    this.midnightTimer.unref?.();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  /** Null when there is no key: the Observer is silently off rather than
   *  logging a failure every three minutes on a machine with no key in it. */
  client(): StructuredClient | null {
    if (this.injectedClient) return this.injectedClient;
    const key = secrets.get('anthropic');
    if (!key) return null;
    this.injectedClient = new AnthropicStructuredClient(key);
    return this.injectedClient;
  }

  /** Called when the key changes, so a key added in Settings takes effect
   *  without a relaunch. */
  resetClient() {
    this.injectedClient = null;
  }

  stats(): NotesStats {
    return {
      ...notes.stats(),
      lastRollupAt: this.lastRollupAt || notes.stats().lastRollupAt,
      sessionStartedAt: this.session.current()?.startedAt ?? null,
    };
  }
}

/** Observations no recap cites yet. The source of truth for "what is owed",
 *  computed from the notes themselves so a restart mid-period does not lose a
 *  stretch of work or roll one up twice. */
export function unrolledObservationIds(limit = 200): number[] {
  const covered = new Set<number>();
  for (const n of notes.list('recap', 200)) for (const id of n.sourceObs) covered.add(id);
  return observations
    .recent(limit)
    .filter((o) => !covered.has(o.id))
    .map((o) => o.id);
}
