import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { secrets } from '../secrets.js';
import { settings } from '../settings.js';
import { runs } from '../store/runs.js';
import { AnthropicClient, type ModelClient } from './client.js';
import { killSwitches } from './killswitch.js';
import { AgentRunner } from './runner.js';
import type { GateAnswer, KillSwitch, PendingGate, RunStep, RunView, StartRunRequest } from '../../shared/types.js';

/// One run at a time, and one place that knows which.
///
/// Everything that can stop a run — the hotkey, the sentinel, buddyd's event
/// tap, the tray, the HUD — reaches it through here, so `AgentRunner` does not
/// have to know how many front doors it has. And because there is exactly one
/// slot, a second activation while a run is live is refused rather than
/// silently starting a second agent on the same keyboard.

export class Operator extends EventEmitter {
  private current: AgentRunner | null = null;
  private clientFactory: (() => ModelClient) | null = null;

  /** Overridden in the M2 checks so the loop can be driven by a scripted model
   *  without a network or a key. */
  setClientFactory(f: (() => ModelClient) | null) {
    this.clientFactory = f;
  }

  isRunning(): boolean {
    return !!this.current && ['running', 'gated', 'confirming'].includes(this.current.view().status);
  }

  active(): RunView | null {
    return this.current?.view() ?? null;
  }

  /** Refuses rather than queues: two agents driving one keyboard is not a
   *  degraded experience, it is a hazard. */
  async start(req: StartRunRequest): Promise<RunView> {
    if (this.isRunning()) {
      throw new Error('A run is already in progress. Stop it before starting another.');
    }
    if (!req.goal.trim()) throw new Error('A run needs a goal.');

    // §7.1: leashless has to be turned on in Settings before it can be chosen.
    // Checked here rather than only in the HUD, because the HUD is one caller
    // of `startRun` and a guard that lives in a button is not a guard.
    if (req.profile === 'leashless' && !settings.get().leashlessEnabled) {
      throw new Error(
        'Leashless mode is off. It lets buddy send, delete, install, buy, and type ' +
          'credentials with nobody asked — turn it on in Settings if that is what you want.',
      );
    }

    const client = this.clientFactory
      ? this.clientFactory()
      : (() => {
          const key = secrets.get('anthropic');
          if (!key) {
            throw new Error(
              'No Anthropic API key. The Operator requires Claude — computer use is not ' +
                'available from any other provider (PRD §9.1). Add a key in Settings.',
            );
          }
          return new AnthropicClient(key);
        })();

    const runner = new AgentRunner({ client, killSwitches });
    this.current = runner;

    runner.on('update', (v: RunView) => this.emit('update', v));
    runner.on('step', (s: RunStep) => this.emit('step', s));
    runner.on('gate', (g: PendingGate) => this.emit('gate', g));
    runner.on('narration', (n) => this.emit('narration', n));

    // The hotkey and the sentinel arrive asynchronously; they land on the runner
    // that was live when they fired, not on whatever is current when they are
    // handled.
    const onFired = (which: Parameters<typeof runner.stop>[0]) => {
      if (runner.view().status === 'running' || runner.view().status === 'gated') runner.stop(which);
    };
    killSwitches.on('fired', onFired);

    try {
      return await runner.run(req);
    } finally {
      killSwitches.off('fired', onFired);
      this.emit('update', runner.view());
      // The runner stays reachable after it ends so the HUD can show the
      // outcome; `isRunning()` is what gates a new activation.
    }
  }

  /** The Stop button, and the funnel the hotkey and the sentinel reach too. */
  stop(via: KillSwitch = 'stop-button'): boolean {
    if (!this.isRunning()) return false;
    this.current?.stop(via);
    return true;
  }

  resolveGate(answer: GateAnswer): boolean {
    return this.current?.resolveGate(answer) ?? false;
  }

  /** History, for the Run Log. The active run is read from memory so a live run
   *  shows its steps as they happen; finished ones come from SQLite. */
  history(limit = 50) {
    return runs.list(limit).map((r) => ({
      id: r.id,
      goal: r.goal,
      profile: r.profile,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      steps: r.steps,
      costUsd: r.cost_usd,
      outcome: r.outcome_json ? safeParse(r.outcome_json) : null,
    }));
  }

  stepsFor(runId: number): RunStep[] {
    const live = this.current?.view();
    if (live && live.id === runId) return live.steps;
    return runs.steps(runId);
  }

  deleteRun(runId: number) {
    if (this.isRunning() && this.current?.view().id === runId) {
      throw new Error('That run is still going. Stop it first.');
    }
    runs.delete(runId);
    log.info('agent', 'run deleted', { runId });
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const operator = new Operator();
