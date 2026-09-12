import type Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { runs } from '../store/runs.js';
import { BudgetTracker } from './budget.js';
import { Executor, type ExecOutcome, type Frame } from './executor.js';
import { KILL_SWITCH_LABEL, killSwitches as globalKillSwitches, type KillSwitches } from './killswitch.js';
import { buildOpeningMessage, buildSystemPrompt } from './prompt.js';
import {
  COMPUTER_TOOLSET_NAME,
  DESCRIBE_TOOL,
  FINISH_TOOL,
  FinishSchema,
  buildTools,
  isComputerAction,
} from './tools.js';
import { OPERATOR_MODEL, type ModelClient } from './client.js';
import {
  DEFAULT_BUDGETS,
  type Allowlist,
  type GuardVerdict,
  type PendingGate,
  type RunBudgets,
  type RunOutcome,
  type RunStatus,
  type RunStep,
  type RunView,
  type StartRunRequest,
} from '../../shared/types.js';

/// The computer-use loop (PRD §6.5).
///
/// The invariants this file exists to hold, in the order they cost you an hour
/// if you get them wrong:
///
///   1. **Every `tool_result` for a computer action carries
///      `toolset_name: "computer"`.** Omitting it is a hard 400 that reads as a
///      model failure. The result builder is the only place a `tool_result` is
///      constructed, so there is one line to get right.
///   2. **Batch fail-stop.** Blocks run in order; the first failure marks itself
///      and every block after it, and *all* the results go back in one user
///      message. Splitting them teaches Claude to stop batching.
///   3. **A deny parks the run.** No alternate route, no asking the model how to
///      proceed. `deny` breaks the loop; it does not become a tool error.
///   4. **Pruning is batched.** Rewriting history invalidates the cache, so it
///      happens every 25 turns rather than every turn.

/** PRD §6.5: keep the last three screenshots, prune in a batch every 25 turns. */
const KEEP_SCREENSHOTS = 3;
const PRUNE_EVERY_TURNS = 25;
const MAX_TOKENS = 64_000;

/** Exactly this text, for every block after the first failure in a batch. */
export const HALT_TEXT = 'Not executed: an earlier computer action in this turn failed.';

const PRUNED_TEXT = '[screenshot pruned from context to save tokens — take a new one if you need to look again]';

/** The AX tree is generous; a pathological window should not eat the turn. */
const MAX_TREE_CHARS = 12_000;

export interface RunnerDeps {
  client: ModelClient;
  executor?: Executor;
  killSwitches?: KillSwitches;
  /** Injected in the checks so a "10 minute" budget can be blown in 10 ms. */
  now?: () => number;
}

type ToolUse = { id: string; name: string; input: Record<string, unknown>; toolsetName: string | null };

export class AgentRunner extends EventEmitter {
  private messages: Anthropic.Messages.MessageParam[] = [];
  private steps: RunStep[] = [];
  private budgets: RunBudgets;
  private tracker: BudgetTracker;
  private executor: Executor;
  private kill: KillSwitches;
  private runId = 0;
  private turn = 0;
  private stepIdx = 0;
  private lastFrame: Frame | null = null;
  private outcome: RunOutcome | null = null;
  private status: RunStatus = 'running';
  private haltReason: string | null = null;
  private gate: PendingGate | null = null;
  private gateResolver: ((v: 'approve' | 'deny' | 'stop') => void) | null = null;
  private allowlist: Allowlist = { apps: [], domains: [] };
  private startedAt = Date.now();
  private endedAt: number | null = null;
  private goal = '';
  private profile: StartRunRequest['profile'] = 'attended';

  constructor(private deps: RunnerDeps) {
    super();
    this.executor = deps.executor ?? new Executor();
    this.kill = deps.killSwitches ?? globalKillSwitches;
    this.budgets = { ...DEFAULT_BUDGETS };
    this.tracker = new BudgetTracker(this.budgets);
  }

  // ── Public surface ────────────────────────────────────────────────────────

  get id() {
    return this.runId;
  }

  view(): RunView {
    return {
      id: this.runId,
      goal: this.goal,
      profile: this.profile,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      budgets: this.budgets,
      usage: this.tracker.usage(),
      allowlist: this.allowlist,
      steps: this.steps,
      outcome: this.outcome,
      haltReason: this.haltReason,
      gate: this.gate,
      cacheReadTokens: this.tracker.cacheReadTokens,
    };
  }

  /** The confirm gate's answer, from the HUD. `stop` is the third button: the
   *  user does not want this action *or* the run. */
  resolveGate(answer: 'approve' | 'deny' | 'stop'): boolean {
    if (!this.gateResolver) return false;
    const r = this.gateResolver;
    this.gateResolver = null;
    this.gate = null;
    this.status = 'running';
    r(answer);
    return true;
  }

  /** Kill switch 4 (and the path kill switches 1–3 converge on). */
  stop(via: 'stop-button' | 'hotkey' | 'sentinel' | 'human-takeover' = 'stop-button') {
    this.kill.fire(via);
    // A run blocked on a confirm gate is not in the loop and will not notice a
    // kill switch on its own.
    if (this.gateResolver) this.resolveGate('stop');
  }

  // ── The loop ──────────────────────────────────────────────────────────────

  async run(req: StartRunRequest): Promise<RunView> {
    this.goal = req.goal.trim();
    this.profile = req.profile;
    this.allowlist = req.allowlist;
    this.budgets = { ...DEFAULT_BUDGETS, ...(req.budgets ?? {}) };
    this.tracker = new BudgetTracker(this.budgets);
    this.startedAt = this.deps.now?.() ?? Date.now();

    this.runId = runs.create(this.goal, this.profile);
    log.info('agent', 'run started', {
      runId: this.runId,
      profile: this.profile,
      apps: this.allowlist.apps.length,
      domains: this.allowlist.domains.length,
    });
    this.emitUpdate();

    const armed = await this.kill.arm();
    if (!armed.takeoverWatch) {
      this.note(
        'kill-switch',
        `Human-takeover detection is unavailable (${armed.takeoverError}). ` +
          'The hotkey, the ABORT file, and Stop still work.',
      );
    }

    try {
      // The opening screenshot. The model's coordinate space does not exist
      // until a frame does, so nothing can be dispatched before this.
      const first = await this.executor.capture(this.runId, null);
      this.lastFrame = first;

      const system: Anthropic.Messages.TextBlockParam[] = [
        {
          type: 'text',
          text: buildSystemPrompt({
            goal: this.goal,
            profile: this.profile,
            allowlist: this.allowlist,
            budgets: this.budgets,
            scale: first.scale,
            screen: { width: first.width, height: first.height },
          }),
          cache_control: { type: 'ephemeral' },
        },
      ];

      this.messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildOpeningMessage(this.goal) },
            { type: 'text', text: 'The screen as it is right now:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: first.base64 } },
            { type: 'text', text: await this.treeBlockText() },
          ],
        },
      ];
      this.recordStep({
        tool: 'screenshot',
        input: { action: 'screenshot', reason: 'opening frame' },
        result: `${first.width}x${first.height} @ scale ${first.scale}`,
        framePath: first.path,
        isError: false,
        verdict: null,
        scale: first.scale,
      });

      await this.loop(system);
    } catch (e) {
      this.park('needs_human', `The run failed: ${(e as Error).message}`);
      log.error('agent', 'run threw', { runId: this.runId, error: (e as Error).message });
    } finally {
      await this.kill.disarm();
      this.endedAt = Date.now();
      runs.finish(this.runId, this.status, this.tracker.usage().steps, this.tracker.usage().costUsd, this.outcome);
      log.info('agent', 'run ended', {
        runId: this.runId,
        status: this.status,
        steps: this.tracker.usage().steps,
        cost: this.tracker.usage().costUsd.toFixed(4),
        cacheRead: this.tracker.cacheReadTokens,
      });
      this.emitUpdate();
    }
    return this.view();
  }

  private async loop(system: Anthropic.Messages.TextBlockParam[]): Promise<void> {
    const tools = buildTools();

    for (;;) {
      this.turn++;

      // §6.5: abort checks and budget checks before dispatching a batch, not
      // after. A run that has blown its budget must not make one more call.
      if (this.checkHalt()) return;

      this.applyRollingCacheBreakpoint();

      const res = await this.deps.client.create({
        model: OPERATOR_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages: this.messages,
        thinking: { type: 'adaptive' },
        // A measured sweep (PRD §6.7) showed `medium` saves no meaningful
        // latency and is less stable. `high` is the answer.
        output_config: { effort: 'high' },
      });
      this.tracker.addUsage(res.usage);
      runs.progress(this.runId, this.tracker.usage().steps, this.tracker.usage().costUsd);
      this.emitUpdate();

      this.messages.push({ role: 'assistant', content: res.content as Anthropic.Messages.ContentBlockParam[] });
      this.surfaceThinking(res.content);

      const calls = this.toolUses(res.content);
      if (calls.length === 0) {
        // §6.6: the run ends with a `finish` call, not with prose. Nudge once —
        // the model usually just forgot — and park if it does it again.
        if (this.status === 'running' && this.turn < this.budgets.maxSteps) {
          const text = this.textOf(res.content);
          log.warn('agent', 'turn ended with no tool call', { runId: this.runId, stop: res.stop_reason });
          this.messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'You ended a turn without calling a tool. Every run must end with the `finish` ' +
                  'tool. Either continue working, or call `finish` now.',
              },
            ],
          });
          this.recordStep({
            tool: 'no-tool-call',
            input: {},
            result: text.slice(0, 400),
            isError: true,
            verdict: null,
          });
          if (this.consecutiveNoToolTurns() >= 2) {
            this.park('needs_human', 'The model stopped calling tools without finishing the run.');
            return;
          }
          continue;
        }
        this.park('needs_human', 'The run ended without a `finish` call.');
        return;
      }

      const { results, halted } = await this.executeBatch(calls);

      // A deny, a gate refusal, or a kill switch: the loop is over and nothing
      // more goes to the model. buddy never asks it how to proceed past a
      // block (§7.1).
      if (halted) return;

      this.messages.push({ role: 'user', content: results });

      if (this.outcome) {
        // `finish` ran. Its status is the run's status.
        return;
      }

      if (this.turn % PRUNE_EVERY_TURNS === 0) this.pruneScreenshots();
    }
  }

  // ── Batch execution, fail-stop ────────────────────────────────────────────

  /**
   * PRD §6.5. Every block in the batch runs in order. On the first failure,
   * that block returns `is_error: true` with the real reason, and every block
   * after it returns `is_error: true` with exactly `HALT_TEXT`. All of them come
   * back in one user message.
   */
  private async executeBatch(
    calls: ToolUse[],
  ): Promise<{ results: Anthropic.Messages.ContentBlockParam[]; halted: boolean }> {
    const results: Anthropic.Messages.ContentBlockParam[] = [];
    let failed = false;

    for (const call of calls) {
      if (failed) {
        results.push(this.toolResult(call, HALT_TEXT, true));
        this.recordStep({
          tool: call.name,
          input: call.input,
          result: HALT_TEXT,
          isError: true,
          verdict: null,
          countsAgainstBudget: false,
        });
        continue;
      }

      // Checked per block, not only per batch: a batch of twelve clicks must
      // stop the moment the user grabs the keyboard, not twelve clicks later.
      if (this.checkHalt()) return { results, halted: true };

      const outcome = await this.dispatch(call);

      if (outcome.kind === 'halted') return { results, halted: true };

      results.push(outcome.block);
      if (outcome.isError) failed = true;
    }

    return { results, halted: false };
  }

  private async dispatch(
    call: ToolUse,
  ): Promise<{ kind: 'ok'; block: Anthropic.Messages.ContentBlockParam; isError: boolean } | { kind: 'halted' }> {
    // ── The two custom tools ───────────────────────────────────────────────
    if (call.name === DESCRIBE_TOOL) {
      try {
        const tree = await this.executor.describeFocusedWindow();
        const text = tree.slice(0, MAX_TREE_CHARS);
        this.recordStep({ tool: call.name, input: call.input, result: `${text.length} chars`, isError: false, verdict: null });
        return { kind: 'ok', block: this.toolResult(call, text, false), isError: false };
      } catch (e) {
        const msg = (e as Error).message;
        this.recordStep({ tool: call.name, input: call.input, result: msg, isError: true, verdict: null });
        return { kind: 'ok', block: this.toolResult(call, msg, true), isError: true };
      }
    }

    if (call.name === FINISH_TOOL) {
      const parsed = FinishSchema.safeParse(call.input);
      if (!parsed.success) {
        const msg = `finish rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
        this.recordStep({ tool: call.name, input: call.input, result: msg, isError: true, verdict: null });
        return { kind: 'ok', block: this.toolResult(call, msg, true), isError: true };
      }
      this.finish(parsed.data);
      this.recordStep({ tool: call.name, input: call.input, result: parsed.data.summary, isError: false, verdict: null });
      return { kind: 'ok', block: this.toolResult(call, 'OK', false), isError: false };
    }

    if (!isComputerAction(call.name)) {
      const msg = `Unknown tool: ${call.name}`;
      this.recordStep({ tool: call.name, input: call.input, result: msg, isError: true, verdict: null });
      return { kind: 'ok', block: this.toolResult(call, msg, true), isError: true };
    }

    // ── A computer action ──────────────────────────────────────────────────
    let result = await this.executor.execute(call.name, call.input, {
      runId: this.runId,
      profile: this.profile,
      allowlist: this.allowlist,
      lastFrame: this.lastFrame,
    });

    if (result.kind === 'gate') {
      const answer = await this.askUser(call.name, result.verdict);
      if (answer === 'stop') {
        this.stop('stop-button');
        this.recordStep({
          tool: call.name,
          input: call.input,
          result: 'Stopped by the user at the confirm gate.',
          isError: true,
          verdict: result.verdict,
        });
        this.park('needs_human', 'You stopped the run at the confirm gate.');
        return { kind: 'halted' };
      }
      if (answer === 'deny') {
        this.recordStep({
          tool: call.name,
          input: call.input,
          result: `Denied by the user: ${result.verdict.reason}`,
          isError: true,
          verdict: { ...result.verdict, decision: 'deny' },
        });
        this.park(
          'needs_human',
          `You denied ${describeAction(call.name, call.input, result.verdict)}. The run stopped there rather than looking for another way.`,
        );
        return { kind: 'halted' };
      }
      // Approved: dispatch this exact block, once, without re-asking.
      result = await this.executor.execute(call.name, call.input, {
        runId: this.runId,
        profile: this.profile,
        allowlist: this.allowlist,
        lastFrame: this.lastFrame,
        preApproved: true,
      });
    }

    if (result.kind === 'gate') {
      // `preApproved` was set, so the executor gating a second time means the
      // approval did not take. Park rather than loop: a gate the user cannot
      // clear is worse than a stopped run.
      const msg = 'The confirm gate did not clear after approval. Stopping rather than retrying.';
      this.recordStep({ tool: call.name, input: call.input, result: msg, isError: true, verdict: result.verdict });
      this.park('needs_human', msg);
      return { kind: 'halted' };
    }

    if (result.kind === 'denied') {
      this.recordStep({
        tool: call.name,
        input: call.input,
        result: result.verdict.reason,
        isError: true,
        verdict: result.verdict,
      });
      // §7.1: a deny parks the run. It is deliberately *not* returned to the
      // model as a tool error, because a tool error is an invitation to try
      // something else, and "something else with the same effect" is the exact
      // failure this rule exists to prevent.
      this.park('needs_human', `Blocked: ${result.verdict.reason}`);
      return { kind: 'halted' };
    }

    if (result.kind === 'error') {
      this.recordStep({ tool: call.name, input: call.input, result: result.text, isError: true, verdict: result.verdict });
      return { kind: 'ok', block: this.toolResult(call, result.text, true), isError: true };
    }

    // Success. A frame means this was a screenshot or a zoom.
    if (result.frame) {
      this.lastFrame = result.frame;
      const tree = await this.treeBlockText();
      this.recordStep({
        tool: call.name,
        input: call.input,
        result: `${result.frame.width}x${result.frame.height} @ scale ${result.frame.scale}`,
        framePath: result.frame.path,
        isError: false,
        verdict: result.verdict,
        scale: result.frame.scale,
      });
      return {
        kind: 'ok',
        isError: false,
        block: {
          type: 'tool_result',
          tool_use_id: call.id,
          ...(call.toolsetName ? { toolset_name: call.toolsetName } : { toolset_name: COMPUTER_TOOLSET_NAME }),
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.frame.base64 } },
            // §6.3: the AX tree travels with every screenshot, so the model
            // targets a named element rather than estimating a pixel. This is
            // the largest single reliability win available.
            { type: 'text', text: tree },
          ],
        },
      };
    }

    this.recordStep({ tool: call.name, input: call.input, result: result.text, isError: false, verdict: result.verdict, scale: this.lastFrame?.scale ?? null });
    return { kind: 'ok', block: this.toolResult(call, result.text, false), isError: false };
  }

  /**
   * The only place a `tool_result` is built.
   *
   * `toolset_name` is echoed from the `tool_use` block, which is the
   * authoritative answer to "is this a toolset member" — and the field whose
   * absence is a hard 400 that looks like a model failure (PRD §6.3).
   */
  private toolResult(call: ToolUse, text: string, isError: boolean): Anthropic.Messages.ContentBlockParam {
    const toolsetName = call.toolsetName ?? (isComputerAction(call.name) ? COMPUTER_TOOLSET_NAME : null);
    return {
      type: 'tool_result',
      tool_use_id: call.id,
      is_error: isError,
      content: [{ type: 'text', text }],
      ...(toolsetName ? { toolset_name: toolsetName } : {}),
    };
  }

  // ── The confirm gate ──────────────────────────────────────────────────────

  private askUser(action: string, verdict: GuardVerdict): Promise<'approve' | 'deny' | 'stop'> {
    this.gate = { runId: this.runId, stepIdx: this.stepIdx, action, verdict };
    this.status = 'gated';
    this.emit('gate', this.gate);
    this.emitUpdate();
    return new Promise((resolve) => {
      this.gateResolver = resolve;
    });
  }

  // ── Halting ───────────────────────────────────────────────────────────────

  /** Kill switches and budgets, checked together because they have the same
   *  consequence: the run parks, with its log intact. */
  private checkHalt(): boolean {
    const fired = this.kill.check();
    if (fired) {
      this.park('needs_human', `Stopped by ${KILL_SWITCH_LABEL[fired]}.`);
      return true;
    }
    const usage = this.tracker.usage();
    if (usage.exceeded) {
      this.park('needs_human', this.tracker.explain(usage.exceeded));
      return true;
    }
    return false;
  }

  private park(status: RunStatus, reason: string) {
    if (this.outcome) return; // already finished properly
    this.status = status;
    this.haltReason = reason;
    this.outcome = { status: 'needs_human', summary: reason };
    log.warn('agent', 'run parked', { runId: this.runId, reason });
    this.emitUpdate();
  }

  private finish(f: RunOutcome) {
    this.outcome = f;
    this.status = f.status === 'done' ? 'done' : f.status === 'waiting' ? 'waiting' : 'needs_human';
    if (f.status === 'waiting') {
      if (f.wake) {
        // M4 consumes this. Persisting it now is what makes standby parseable
        // rather than regex-scraped out of a summary (PRD §6.6).
        runs.scheduleWakeup(this.runId, f.wake);
      } else {
        this.haltReason =
          'The model asked to wait but gave no wake condition, so there is nothing to wake on.';
        this.status = 'needs_human';
        this.outcome = { status: 'needs_human', summary: this.haltReason };
      }
    }
    this.emitUpdate();
  }

  // ── Context hygiene (PRD §6.5) ────────────────────────────────────────────

  /**
   * Keep the last three screenshots; replace the rest with a placeholder.
   *
   * The `tool_result` block itself stays — dropping it would orphan its
   * `tool_use` and invalidate the whole conversation — so only its image
   * content is swapped. Called every 25 turns, because rewriting history
   * invalidates the cache prefix and paying that on every turn is the thing
   * this batching exists to avoid.
   */
  private pruneScreenshots(): number {
    const images: { content: Anthropic.Messages.ContentBlockParam[]; i: number }[] = [];
    for (const m of this.messages) {
      if (!Array.isArray(m.content)) continue;
      const outer = m.content as Anthropic.Messages.ContentBlockParam[];
      // Indexed by position rather than by `indexOf`: two identical blocks are
      // possible (the same screenshot taken twice of an unchanged screen), and
      // `indexOf` would then rewrite the first one twice and leave the second.
      outer.forEach((block, i) => {
        if (block.type === 'image') {
          images.push({ content: outer, i });
        } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
          const inner = block.content as Anthropic.Messages.ContentBlockParam[];
          inner.forEach((b, j) => {
            if (b.type === 'image') images.push({ content: inner, i: j });
          });
        }
      });
    }
    const stale = images.slice(0, Math.max(0, images.length - KEEP_SCREENSHOTS));
    for (const { content, i } of stale) {
      content[i] = { type: 'text', text: PRUNED_TEXT };
    }
    if (stale.length) {
      log.debug('agent', 'pruned screenshots', { runId: this.runId, pruned: stale.length, turn: this.turn });
    }
    return stale.length;
  }

  /**
   * A rolling cache breakpoint on the newest user message.
   *
   * Tools and system carry their own breakpoints and never move. This third one
   * caches the growing conversation, which is where the screenshots are and so
   * where nearly all the tokens are. Only four breakpoints are allowed, so the
   * previous rolling one is removed before the new one is set.
   */
  private applyRollingCacheBreakpoint() {
    for (const m of this.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if ('cache_control' in block) delete (block as { cache_control?: unknown }).cache_control;
      }
    }
    const last = this.messages[this.messages.length - 1];
    if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
    const target = last.content[last.content.length - 1] as unknown as Record<string, unknown>;
    // A thinking block cannot carry a breakpoint; everything buddy appends is a
    // text, image, or tool_result block, so this is a guard rather than a case.
    if (target.type === 'thinking' || target.type === 'redacted_thinking') return;
    target.cache_control = { type: 'ephemeral' };
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────

  private async treeBlockText(): Promise<string> {
    try {
      const tree = await this.executor.describeFocusedWindow();
      return `Accessibility tree of the focused window (coordinates are element centres):\n\n${tree.slice(0, MAX_TREE_CHARS)}`;
    } catch (e) {
      return (
        'The accessibility tree is unavailable: ' +
        (e as Error).message +
        '. Work from the screenshot alone and be more careful with coordinates.'
      );
    }
  }

  private toolUses(content: Anthropic.Messages.ContentBlock[]): ToolUse[] {
    return content
      .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
        toolsetName: b.toolset_name ?? null,
      }));
  }

  private textOf(content: Anthropic.Messages.ContentBlock[]): string {
    return content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  /** The step feed in the HUD reads better with the model's own narration than
   *  with a list of raw actions, so text blocks are surfaced as they arrive. */
  private surfaceThinking(content: Anthropic.Messages.ContentBlock[]) {
    const text = this.textOf(content);
    if (text) this.emit('narration', { runId: this.runId, text });
  }

  private consecutiveNoToolTurns(): number {
    let n = 0;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i].tool !== 'no-tool-call') break;
      n++;
    }
    return n;
  }

  private note(tool: string, message: string) {
    this.recordStep({ tool, input: {}, result: message, isError: false, verdict: null, countsAgainstBudget: false });
  }

  private recordStep(s: {
    tool: string;
    input: unknown;
    result: unknown;
    framePath?: string | null;
    isError: boolean;
    verdict: GuardVerdict | null;
    scale?: number | null;
    countsAgainstBudget?: boolean;
  }) {
    const step: RunStep = {
      runId: this.runId,
      idx: this.stepIdx++,
      tool: s.tool,
      input: s.input,
      result: s.result,
      framePath: s.framePath ?? null,
      isError: s.isError,
      ts: Date.now(),
      verdict: s.verdict,
      scale: s.scale ?? null,
    };
    this.steps.push(step);
    runs.addStep({ ...step, runId: this.runId });
    if (s.countsAgainstBudget !== false) this.tracker.step();
    this.emit('step', step);
    this.emitUpdate();
  }

  private emitUpdate() {
    this.emit('update', this.view());
  }
}

/** Gate copy: names the exact action and the element it targets (PRD §8.1). */
export function describeAction(action: string, input: Record<string, unknown>, verdict: GuardVerdict): string {
  switch (action) {
    case 'type':
      return `typing “${String(input.text ?? '').slice(0, 60)}” into ${verdict.target}`;
    case 'key':
      return `pressing ${String(input.text ?? '')} in ${verdict.target}`;
    default:
      return `${action.replace(/_/g, ' ')} on ${verdict.target}`;
  }
}
