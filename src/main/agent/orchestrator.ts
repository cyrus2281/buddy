import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { secrets } from '../secrets.js';
import { settings } from '../settings.js';
import { runs } from '../store/runs.js';
import { AnthropicClient, type ModelClient } from './client.js';
import { killSwitches } from './killswitch.js';
import { AgentRunner, type ResumeRunRequest } from './runner.js';
import { Executor } from './executor.js';
import { CuaExecutor } from '../cua/executor.js';
import { cuaDriver } from '../cua/driver.js';
import { cuaOperatorSetup } from './operator-setup.js';
import { NO_ANTHROPIC_KEY, anthropicBaseUrl } from '../providers.js';
import type { GateAnswer, GhostIntent, KillSwitch, PendingGate, RunStep, RunView, StartRunRequest } from '../../shared/types.js';

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
  private executorFactory: (() => Executor | CuaExecutor) | null = null;
  private spendSink: ((usd: number) => void) | null = null;
  private memoryProvider: ((goal: string) => string | null) | null = null;
  private intentSink: ((i: GhostIntent) => void) | null = null;

  /** The ghost cursor (`island.ts`). Set at launch; unset in the checks that
   *  do not ask for it, which therefore run with no ghost and no lead delay. */
  setIntentSink(f: ((i: GhostIntent) => void) | null) {
    this.intentSink = f;
  }

  /** Overridden in the M2 checks so the loop can be driven by a scripted model
   *  without a network or a key. */
  setClientFactory(f: (() => ModelClient) | null) {
    this.clientFactory = f;
  }

  /** Overridden in the M4 checks, which resume a run through the real
   *  `AgentRunner` on a machine that may have no Accessibility grant. M2's
   *  checks construct their runner directly and do not need this; M4 goes
   *  through the Operator because "the same run, continuing" is a fact about
   *  the orchestrator's bookkeeping as much as the runner's. */
  setExecutorFactory(f: (() => Executor | CuaExecutor) | null) {
    this.executorFactory = f;
  }

  /** The daily spend meter (PRD R5). Set at launch; every run reports each
   *  turn's cost to it. Unset in the checks that do not ask for it. */
  setSpendSink(f: ((usd: number) => void) | null) {
    this.spendSink = f;
  }

  /** M5. Set at launch to `memory.forRun`. Unset in the checks that do not
   *  ask for it, so their prompts are exactly what they were. */
  setMemoryProvider(f: ((goal: string) => string | null) | null) {
    this.memoryProvider = f;
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

    const cua = await this.cuaSetup();
    const client = this.clientFactory
      ? this.clientFactory()
      : (cua?.client ??
        (() => {
          const key = secrets.get('anthropic');
          // One sentence with one author: `providers.operatorAvailability()`
          // shows the user exactly this, so the Settings screen and the guard
          // cannot disagree about why activation is unavailable (§9.1).
          if (!key) throw new Error(NO_ANTHROPIC_KEY);
          return new AnthropicClient(key, anthropicBaseUrl());
        })());

    // §7.1: leashless has no allowlist. Cleared here as well as in the HUD, for
    // the same reason the `leashlessEnabled` check lives here — the HUD is one
    // caller of `start`, and a run that arrived from anywhere else must not end
    // up with a list recorded against it that nothing will ever consult.
    if (req.profile === 'leashless' && (req.allowlist.apps.length || req.allowlist.domains.length)) {
      log.info('agent', 'cleared the allowlist for a leashless run; the profile has none');
      req = { ...req, allowlist: { apps: [], domains: [] } };
    }

    const runner = this.attach(this.build(client, cua));
    const onFired = this.armKillSwitches(runner);
    try {
      return await runner.run(req);
    } finally {
      killSwitches.off('fired', onFired);
      this.emit('update', runner.view());
      // The runner stays reachable after it ends so the HUD can show the
      // outcome; `isRunning()` is what gates a new activation.
    }
  }

  /**
   * Come back from standby (PRD §6.6).
   *
   * Deliberately a separate entry point rather than a flag on `start()`: a
   * resume does not create a run, does not go through the leashless check
   * again — the profile was fixed before the first loop began and a run cannot
   * escalate its own permissions (§6.1), which includes escalating them by
   * waiting — and carries a transcript rather than a goal. One `if` inside
   * `start()` would have hidden all three.
   */
  async resume(req: ResumeRunRequest): Promise<RunView> {
    if (this.isRunning()) {
      throw new Error('A run is already in progress, so the standby resume was skipped.');
    }
    const cua = await this.cuaSetup();
    const client = this.clientFactory
      ? this.clientFactory()
      : (cua?.client ??
        (() => {
          const key = secrets.get('anthropic');
          if (!key) throw new Error(NO_ANTHROPIC_KEY);
          return new AnthropicClient(key, anthropicBaseUrl());
        })());

    const runner = this.attach(this.build(client, cua));
    const onFired = this.armKillSwitches(runner);
    try {
      return await runner.resume(req);
    } finally {
      killSwitches.off('fired', onFired);
      this.emit('update', runner.view());
    }
  }

  /**
   * The cua backend's model and pricing, and cua-driver itself started and
   * granted — before a run row exists, so a missing binary or a missing grant
   * is the one clear sentence at the hotkey rather than a run that parks on
   * its first step. Null on the toolset backend, whose path is unchanged.
   */
  private async cuaSetup(): Promise<ReturnType<typeof cuaOperatorSetup> | null> {
    if (settings.get().operatorBackend !== 'cua') return null;
    if (this.clientFactory && this.executorFactory) return null; // the checks supply both
    const setup = this.clientFactory ? null : cuaOperatorSetup();
    if (!this.executorFactory) await cuaDriver.ensureStarted();
    if (setup) log.info('agent', 'cua backend', { provider: setup.provider, model: setup.model, metering: setup.priceBasis });
    return setup;
  }

  private build(client: ModelClient, cua: ReturnType<typeof cuaOperatorSetup> | null = null): AgentRunner {
    const backend = settings.get().operatorBackend;
    const executor = this.executorFactory
      ? this.executorFactory()
      : backend === 'cua'
        ? new CuaExecutor()
        : new Executor();
    const sink = this.intentSink;
    if (sink && !executor.intents) {
      executor.intents = {
        send: (i) => {
          if (settings.get().ghostCursor) sink({ ...i, runId: this.current?.id ?? 0 });
        },
        leadMs: () => (settings.get().ghostCursor ? settings.get().ghostLeadMs : 0),
      };
    }
    const spend = this.spendSink;
    return new AgentRunner({
      client,
      killSwitches,
      executor,
      ...(this.memoryProvider ? { memory: this.memoryProvider } : {}),
      ...(cua ? { model: cua.model, price: cua.price } : {}),
      // Every turn goes on the daily meter, whichever backend ran it — the meter
      // tells the whole truth (PRD R5). The cap never stops a run: only T2 and
      // T3 ask `SpendMeter.allow()`, so a run's spend can pause observation for
      // the rest of the day but cannot pause the run.
      ...(spend ? { onSpend: (usd: number) => spend(usd) } : {}),
    });
  }

  private attach(runner: AgentRunner): AgentRunner {
    this.current = runner;
    runner.on('update', (v: RunView) => this.emit('update', v));
    runner.on('step', (s: RunStep) => this.emit('step', s));
    runner.on('gate', (g: PendingGate) => this.emit('gate', g));
    runner.on('narration', (n) => this.emit('narration', n));
    return runner;
  }

  /** The hotkey and the sentinel arrive asynchronously; they land on the runner
   *  that was live when they fired, not on whatever is current when they are
   *  handled. */
  private armKillSwitches(runner: AgentRunner) {
    const onFired = (which: Parameters<typeof runner.stop>[0]) => {
      if (runner.view().status === 'running' || runner.view().status === 'gated') runner.stop(which);
    };
    killSwitches.on('fired', onFired);
    return onFired;
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
      handsOff: !!r.hands_off,
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
    // `wakeups` cascades from `runs`, and the saved transcript goes with the
    // run's directory — so deleting a run that was in standby really does stop
    // buddy waiting for it, rather than leaving a check firing against a run
    // that no longer exists.
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
