import { EventEmitter } from 'node:events';
import { kv } from '../store/db.js';
import { log } from '../log.js';

/// Sessions (PRD §4.1): *a contiguous run of activity ending after 10 minutes
/// idle or a display sleep.*
///
/// There is no `sessions` table and deliberately so — a session is a boundary,
/// not a record. What is persisted is the current one's start and last-activity
/// timestamps, in `settings`, so a relaunch does not turn one afternoon into
/// two sessions and produce two half-recaps of the same work.
///
/// The boundary matters because it is when T3 runs and when a `session`-scoped
/// task widens to `day` (§4.1). Getting it wrong in the lenient direction costs
/// a recap that spans lunch; in the strict direction it costs a recap per coffee.

const KEY = 'session.current';

/** §4.1. Ten minutes, not five: stepping away to read something on paper is not
 *  a new session, and a recap chopped at every pause is a worse recap. */
export const SESSION_IDLE_MS = 10 * 60_000;

interface Persisted {
  startedAt: number;
  lastActivityAt: number;
}

export class SessionTracker extends EventEmitter {
  private startedAt: number | null = null;
  private lastActivityAt = 0;
  private idleMs: number;

  constructor(idleMs = SESSION_IDLE_MS) {
    super();
    this.idleMs = idleMs;
  }

  setIdleMs(ms: number) {
    this.idleMs = ms;
  }

  /** Resume whatever was live when the app last ran, if it still counts as the
   *  same session. A machine asleep overnight comes back to a closed session
   *  and a rollup owed for it — which is the correct reading of what happened. */
  load(now = Date.now()): { resumed: boolean; closed: { startedAt: number; endedAt: number } | null } {
    const p = kv.get<Persisted | null>(KEY, null);
    if (!p) return { resumed: false, closed: null };
    if (now - p.lastActivityAt < this.idleMs) {
      this.startedAt = p.startedAt;
      this.lastActivityAt = p.lastActivityAt;
      log.info('session', 'resumed the session that was live at last launch', {
        startedAt: new Date(p.startedAt).toISOString(),
      });
      return { resumed: true, closed: null };
    }
    kv.set(KEY, null);
    log.info('session', 'the session live at last launch had already gone idle', {
      startedAt: new Date(p.startedAt).toISOString(),
      endedAt: new Date(p.lastActivityAt).toISOString(),
    });
    return { resumed: false, closed: { startedAt: p.startedAt, endedAt: p.lastActivityAt } };
  }

  isActive(): boolean {
    return this.startedAt != null;
  }

  current(): { startedAt: number; lastActivityAt: number } | null {
    return this.startedAt == null ? null : { startedAt: this.startedAt, lastActivityAt: this.lastActivityAt };
  }

  /**
   * A T0 signal. `idleSeconds` comes from the OS, so an idle gap is detected
   * even when buddy itself was not running — which is the case that a
   * last-activity timestamp alone would miss.
   */
  onSignal(ts: number, idleSeconds: number) {
    const idleMs = idleSeconds * 1000;
    const activeAt = ts - idleMs;

    if (idleMs >= this.idleMs) {
      // The OS says nobody has touched this machine for longer than a session
      // gap. Close at the last moment there *was* activity, not now: a session
      // that ends ten minutes after the user left has ten minutes of nothing
      // stapled to its recap.
      this.end(Math.max(this.lastActivityAt, activeAt), 'idle');
      return;
    }

    if (this.startedAt == null) {
      this.start(activeAt);
      return;
    }
    // A gap inside one stream of signals: buddy was paused, or the app was shut.
    if (activeAt - this.lastActivityAt >= this.idleMs) {
      this.end(this.lastActivityAt, 'gap');
      this.start(activeAt);
      return;
    }
    this.lastActivityAt = Math.max(this.lastActivityAt, activeAt);
    this.persist();
  }

  /** Display sleep, screen lock, or system suspend — §4.1's other boundary. */
  onSleep(ts = Date.now()) {
    if (this.startedAt == null) return;
    this.end(Math.min(ts, Math.max(this.lastActivityAt, this.startedAt)), 'sleep');
  }

  start(ts = Date.now()) {
    if (this.startedAt != null) return;
    this.startedAt = ts;
    this.lastActivityAt = ts;
    this.persist();
    log.info('session', 'started', { at: new Date(ts).toISOString() });
    this.emit('start', { startedAt: ts });
  }

  end(endedAt = Date.now(), reason: 'idle' | 'sleep' | 'gap' | 'shutdown' = 'idle') {
    const startedAt = this.startedAt;
    if (startedAt == null) return;
    this.startedAt = null;
    const ended = Math.max(endedAt, startedAt);
    kv.set(KEY, null);
    log.info('session', 'ended', {
      reason,
      minutes: Math.round((ended - startedAt) / 60_000),
    });
    this.emit('end', { startedAt, endedAt: ended, reason });
  }

  private persist() {
    if (this.startedAt == null) return;
    kv.set(KEY, { startedAt: this.startedAt, lastActivityAt: this.lastActivityAt } satisfies Persisted);
  }
}
