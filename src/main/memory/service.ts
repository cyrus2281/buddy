import { EventEmitter } from 'node:events';
import { getDb } from '../store/db.js';
import { log } from '../log.js';
import { settings } from '../settings.js';
import { parseTeaching } from '../../shared/teach.js';
import { memoryIndex } from './index.js';
import { vectors } from './vectors.js';
import { facts } from './facts.js';
import { episodes, snapshotOf, type ActivationSnapshot } from './episodes.js';
import { RhythmRecorder, rhythm } from './rhythm.js';
import { learnFact } from './learn.js';
import { recall } from './recall.js';
import { inferenceMemory, operatorMemory, type InferenceMemory } from './context.js';
import type { CaptureScheduler } from '../capture/scheduler.js';
import type {
  FactKind,
  FactView,
  InferenceState,
  MemoryHit,
  MemoryOverview,
  RunView,
  TeachResult,
} from '../../shared/types.js';

/// buddy's memory of the *person*, as one object the rest of the app talks to.
///
/// The notes engine remembers what happened. This remembers who it happened
/// to: what they prefer, how they do recurring things, who the people around
/// them are, what their week looks like, and — most usefully — every time
/// buddy guessed wrong about what they wanted. Four sources feed it:
///
///   1. **Watching.** Each hourly rollup proposes facts; `learn.ts` merges them.
///   2. **Runs.** Every run's outcome, and every goal the person overrode.
///   3. **The week.** App time per hour from the free T0 signal.
///   4. **Being told.** "Remember that …" in the Ask box, and every confirm,
///      reject and edit on the "You" screen.
///
/// And three stages read it: goal inference, the Operator, and Ask.
///
/// Events: `changed` whenever something the "You" screen shows has changed.

export class Memory extends EventEmitter {
  readonly rhythm: RhythmRecorder;
  private scheduler: CaptureScheduler | null = null;
  /** What the HUD was offering when the latest run was started, so the run's
   *  end can be compared with it. Keyed by goal, so a resume — which has no
   *  activation — never picks up a stale offer. */
  private offered: { goal: string; snapshot: ActivationSnapshot | null } | null = null;

  constructor() {
    super();
    this.rhythm = new RhythmRecorder({
      enabled: () => settings.get().learningEnabled && !settings.get().paused,
      excluded: (bundleId) =>
        settings.get().exclusions.some((r) => r.enabled && !!r.bundleId && r.bundleId === bundleId),
    });
    memoryIndex.on('synced', () => this.emit('changed'));
  }

  /** At launch, after the database is open. The index catches up in the
   *  background: on a first launch with months of notes that is a few seconds
   *  of slices, none of which holds the main process for long. */
  open(): void {
    memoryIndex.open();
    setImmediate(() => {
      memoryIndex.sync({ maxItems: 0, full: true });
      memoryIndex.schedule(0);
    });
  }

  attach(scheduler: CaptureScheduler) {
    this.scheduler = scheduler;
    scheduler.on('signal', this.rhythm.onSignal);
    this.rhythm.start();
  }

  stop() {
    this.scheduler?.off('signal', this.rhythm.onSignal);
    this.rhythm.stop();
  }

  enabled(): boolean {
    return settings.get().learningEnabled;
  }

  /** Something was written — a note, an observation, a recap. */
  touched() {
    memoryIndex.schedule();
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  /** Called as a run is started from the HUD, before it exists. */
  expectRun(goal: string, activation: InferenceState | null) {
    this.offered = { goal, snapshot: snapshotOf(activation) };
  }

  /** Every run update; only terminal ones are recorded, idempotently. */
  onRunUpdate(view: RunView) {
    if (!['done', 'waiting', 'needs_human', 'cancelled'].includes(view.status)) return;
    const snapshot = this.offered && this.offered.goal === view.goal ? this.offered.snapshot : null;
    try {
      const r = episodes.recordRun(view, snapshot);
      if (r.run) {
        this.offered = null;
        memoryIndex.schedule();
        this.emit('changed');
      }
    } catch (e) {
      log.warn('memory', 'could not record the run', { runId: view.id, error: (e as Error).message });
    }
  }

  // ── What the stages read ─────────────────────────────────────────────────

  forInference(query: string, now = Date.now()): InferenceMemory | null {
    if (!this.enabled()) return null;
    try {
      return inferenceMemory(query, now);
    } catch (e) {
      // Memory is context, never a prerequisite. A failure here costs the
      // reading some background; it must not cost the reading.
      log.warn('memory', 'could not assemble memory for inference', { error: (e as Error).message });
      return null;
    }
  }

  forRun(goal: string): string | null {
    if (!this.enabled()) return null;
    try {
      return operatorMemory(goal);
    } catch (e) {
      log.warn('memory', 'could not assemble memory for the run', { error: (e as Error).message });
      return null;
    }
  }

  // ── Being told, and being corrected ──────────────────────────────────────

  teach(text: string): TeachResult {
    const parsed = parseTeaching(text) ?? { statement: text.trim(), kind: 'context' as FactKind };
    const r = learnFact({ ...parsed, confidence: 1, source: 'told' });
    if (r.action === 'blocked' && r.rejected) {
      // The person rejected something like this once and is now saying it
      // themselves. The newer, explicit word wins: their sentence is stored
      // as given, and the old rejection stays as history.
      const fact = facts.create({ ...parsed, confidence: 1, source: 'told' });
      memoryIndex.embedFact(fact.id);
      this.emit('changed');
      return { fact, note: 'Remembered — this replaces something you had told buddy was wrong.' };
    }
    if (r.action === 'blocked' || r.action === 'ignored') {
      return { fact: null, note: `buddy did not remember that: ${r.reason}.` };
    }
    // Said out loud, so it is the person's word whether or not buddy had
    // already guessed it.
    const fact = r.fact.status === 'pinned' ? r.fact : facts.pin(r.fact.id)!;
    memoryIndex.embedFact(fact.id);
    this.emit('changed');
    return {
      fact,
      note: r.action === 'reinforced' ? 'buddy already thought so — now it knows.' : 'Remembered.',
    };
  }

  confirm(id: number): FactView | null {
    return this.after(facts.pin(id));
  }

  reject(id: number): FactView | null {
    return this.after(facts.reject(id));
  }

  restore(id: number): FactView | null {
    return this.after(facts.restore(id));
  }

  edit(id: number, patch: { statement?: string; kind?: FactKind }): FactView | null {
    const f = facts.edit(id, patch);
    if (f) memoryIndex.embedFact(f.id);
    return this.after(f);
  }

  forget(id: number): void {
    facts.forget(id);
    vectors.remove('fact', [id]);
    this.emit('changed');
  }

  /**
   * Everything learned about the person, gone: facts (including the list of
   * rejected ones), run episodes and corrections, and the week's app time.
   * Notes, observations and runs stay — they are what happened, and they have
   * their own delete buttons.
   */
  forgetEverything(): void {
    const db = getDb();
    db.transaction(() => {
      db.exec('DELETE FROM facts; DELETE FROM episodes; DELETE FROM app_usage;');
    })();
    vectors.clear(['fact', 'episode']);
    log.info('memory', 'everything learned about the user was forgotten, at their request');
    this.emit('changed');
  }

  rebuildIndex(): void {
    vectors.clear();
    memoryIndex.schedule(0);
  }

  // ── What the "You" screen shows ──────────────────────────────────────────

  search(query: string): MemoryHit[] {
    return recall(query, { limit: 20, includeInactiveFacts: true });
  }

  overview(): MemoryOverview {
    const now = Date.now();
    const st = facts.stats();
    const counts = episodes.counts();
    return {
      facts: facts.all(now).filter((f) => f.status !== 'superseded'),
      corrections: episodes.recent(20, 'correction'),
      runs: episodes.recent(10, 'run'),
      rhythm: rhythm(now),
      index: memoryIndex.status(),
      learning: {
        enabled: this.enabled(),
        facts: st.total,
        pinned: st.pinned,
        rejected: st.rejected,
        lastLearnedAt: st.lastLearnedAt,
        runs: counts.runs,
        corrections: counts.corrections,
      },
    };
  }

  private after(f: FactView | null): FactView | null {
    this.emit('changed');
    return f;
  }
}

export const memory = new Memory();
