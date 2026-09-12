import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { buildBundle, inferGoal, provisionalGoal } from './inference.js';
import type { NotesEngine } from '../notes/engine.js';
import type { CaptureScheduler } from '../capture/scheduler.js';
import type { InferenceState } from '../../shared/types.js';

/// Activation (PRD §6.1): the hotkey, the provisional goal, and the reading.
///
/// The shape of this file is dictated by one measured number. Goal inference
/// takes a median of 8.6 seconds and up to 22 on an ambiguous case (§6.7). A
/// hotkey that shows nothing for eight seconds is a hotkey people stop pressing,
/// so activation is two events, not one:
///
///   1. **~200 ms**, synchronously off the newest open task note — a local
///      guess, good enough to recognise, and marked as provisional.
///   2. **8–22 s**, the model's reading, which replaces it in place with
///      evidence, risk flags, a profile and the app allowlist.
///
/// Both are the same field in the HUD. The user can press Enter on either.

export class Activation extends EventEmitter {
  private state: InferenceState = IDLE;
  private requestId = 0;
  private inFlight: AbortController | null = null;

  constructor(
    private deps: { engine: NotesEngine; scheduler: CaptureScheduler; frontWindowTitle: () => string },
  ) {
    super();
  }

  current(): InferenceState {
    return this.state;
  }

  /**
   * The hotkey was pressed.
   *
   * Returns the provisional state synchronously — the caller shows the HUD with
   * it already filled in, which is what makes the 200 ms budget achievable at
   * all. The model call runs behind it and lands on `change`.
   */
  begin(): InferenceState {
    this.cancel('superseded');
    const id = ++this.requestId;
    const { goal, source } = provisionalGoal(this.deps.frontWindowTitle());

    this.state = {
      phase: 'provisional',
      goal,
      source,
      reading: null,
      error: null,
      ms: null,
      costUsd: null,
      requestId: id,
    };
    this.emit('change', this.state);

    void this.infer(id);
    return this.state;
  }

  private async infer(id: number) {
    const client = this.deps.engine.client();
    if (!client) {
      // No key. The provisional goal stands and the typed-goal path still works,
      // which is the honest degradation — not an error dialog over the HUD.
      this.settle(id, {
        ...this.state,
        phase: 'error',
        error: 'No Anthropic API key, so buddy cannot read the screen. Type a goal, or add a key in Settings.',
      });
      return;
    }

    const controller = new AbortController();
    this.inFlight = controller;
    const t0 = Date.now();

    try {
      const bundle = buildBundle(this.deps.scheduler.recentSignals(5 * 60_000));
      const out = await inferGoal(client, bundle, controller.signal);
      if (id !== this.requestId) return; // a newer activation won
      this.deps.engine.spend.record('inference', out.costUsd);
      this.settle(id, {
        phase: 'ready',
        goal: out.reading.goal,
        source: 'model',
        reading: out.reading,
        error: null,
        ms: out.ms,
        costUsd: out.costUsd,
        requestId: id,
      });
    } catch (e) {
      if (id !== this.requestId || controller.signal.aborted) return;
      const msg = (e as Error).message;
      log.warn('inference', 'goal inference failed; the provisional goal stands', { error: msg });
      this.settle(id, { ...this.state, phase: 'error', error: msg, ms: Date.now() - t0 });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private settle(id: number, next: InferenceState) {
    if (id !== this.requestId) return;
    this.state = next;
    this.emit('change', this.state);
  }

  /** Esc, or a second activation. An in-flight reading is aborted rather than
   *  left to land on a HUD the user has already dismissed — and, since it is
   *  billed by the token, aborted rather than merely ignored. */
  cancel(why: 'dismissed' | 'superseded' = 'dismissed') {
    if (this.inFlight) {
      this.inFlight.abort();
      log.debug('inference', 'in-flight reading aborted', { why });
      this.inFlight = null;
    }
    this.requestId++;
    this.state = IDLE;
    this.emit('change', this.state);
  }
}

const IDLE: InferenceState = {
  phase: 'idle',
  goal: null,
  source: 'none',
  reading: null,
  error: null,
  ms: null,
  costUsd: null,
  requestId: 0,
};
