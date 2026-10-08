import type { BudgetUsage, RunBudgets } from '../../shared/types.js';
import { priceOf } from '../notes/model.js';
import { log } from '../log.js';

/// Budgets (PRD §6.5). Three of them, checked before every batch. Hitting any
/// one parks the run in `NEEDS_HUMAN` with its log intact — it never fails
/// silently and never quietly continues.

/** Claude Opus 5, USD per token. Cache writes bill at 1.25× the input rate and
 *  cache reads at 0.1×, which is the whole reason §6.5 cares about the
 *  breakpoint placement. */
const PRICE = {
  input: 5 / 1_000_000,
  output: 25 / 1_000_000,
  cacheWrite: (5 * 1.25) / 1_000_000,
  cacheRead: (5 * 0.1) / 1_000_000,
};

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** What one call cost, from its usage. The toolset backend is Opus 5 and uses
 *  `costOf`; the cua backend can run another model and supplies its own. */
export type Pricer = (u: UsageLike) => number;

export function costOf(u: UsageLike): number {
  return (
    (u.input_tokens ?? 0) * PRICE.input +
    (u.output_tokens ?? 0) * PRICE.output +
    (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead
  );
}

export class BudgetTracker {
  private startedAt = Date.now();
  private stepsUsed = 0;
  private cost = 0;
  private cacheRead = 0;

  constructor(
    readonly limits: RunBudgets,
    private price: Pricer = costOf,
  ) {}

  /** One step per executed tool_use block — the same unit `run_steps` records,
   *  so the meter in the HUD and the row count in the Run Log always agree. */
  step(n = 1) {
    this.stepsUsed += n;
  }

  /** Returns what this call cost, so the caller can put it on the daily meter. */
  addUsage(u: UsageLike): number {
    const c = this.price(u);
    this.cost += c;
    this.cacheRead += u.cache_read_input_tokens ?? 0;
    return c;
  }

  get cacheReadTokens() {
    return this.cacheRead;
  }

  usage(): BudgetUsage {
    const elapsedMs = Date.now() - this.startedAt;
    return {
      steps: this.stepsUsed,
      elapsedMs,
      costUsd: this.cost,
      exceeded:
        this.stepsUsed >= this.limits.maxSteps
          ? 'steps'
          : elapsedMs >= this.limits.maxWallClockMs
            ? 'time'
            : this.cost >= this.limits.maxCostUsd
              ? 'cost'
              : null,
    };
  }

  /** The sentence the HUD and the run log show when a budget parks a run.
   *  Naming the number, not just the category, is what stops the user
   *  wondering whether it was really the budget. */
  explain(which: NonNullable<BudgetUsage['exceeded']>): string {
    const u = this.usage();
    switch (which) {
      case 'steps':
        return `Step budget reached: ${u.steps} of ${this.limits.maxSteps} steps.`;
      case 'time':
        return `Time budget reached: ${Math.round(u.elapsedMs / 1000)}s of ${Math.round(
          this.limits.maxWallClockMs / 1000,
        )}s.`;
      case 'cost':
        return `Cost budget reached: $${u.costUsd.toFixed(2)} of $${this.limits.maxCostUsd.toFixed(2)}.`;
    }
  }
}

// ── Pricing an Operator that is not Opus 5 (cua backend) ────────────────────

/** OpenAI list prices, USD per token, as of the GPT-5 launch. Longest id
 *  first: the lookup matches on containment, and `gpt-5-mini-…` contains
 *  `gpt-5`. Check these against the current price page before trusting a
 *  dollar figure to the cent. */
const OPENAI_PRICES: [string, { input: number; output: number }][] = [
  ['gpt-5-nano', { input: 0.05 / 1_000_000, output: 0.4 / 1_000_000 }],
  ['gpt-5-mini', { input: 0.25 / 1_000_000, output: 2 / 1_000_000 }],
  ['gpt-5', { input: 1.25 / 1_000_000, output: 10 / 1_000_000 }],
  ['gpt-4.1-mini', { input: 0.4 / 1_000_000, output: 1.6 / 1_000_000 }],
  ['gpt-4.1', { input: 2 / 1_000_000, output: 8 / 1_000_000 }],
  ['gpt-4o-mini', { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 }],
  ['gpt-4o', { input: 2.5 / 1_000_000, output: 10 / 1_000_000 }],
  ['o4-mini', { input: 1.1 / 1_000_000, output: 4.4 / 1_000_000 }],
  ['o3', { input: 2 / 1_000_000, output: 8 / 1_000_000 }],
];

/**
 * The run's cost budget for whichever model is driving.
 *
 * **A model buddy cannot price is metered at Opus 5's rates, not at $0.** The
 * cost budget parks a run that runs away (§6.5), and a meter that reads zero
 * per call is a budget that is off — so an unknown id, a gateway alias, is
 * charged as the most expensive model buddy knows, and the run log says so.
 * Over-reporting stops a run early; under-reporting lets one run forever.
 *
 * A local runtime is the exception, and an honest one: it costs nothing per
 * token, so it is metered at zero and the step and time budgets are what bound
 * it.
 */
export function operatorPricer(provider: 'anthropic' | 'openai' | 'local', model: string): { price: Pricer; basis: string } {
  if (provider === 'local') {
    return { price: () => 0, basis: 'a local runtime has no per-token cost; the step and time budgets bound the run' };
  }
  const p: { input: number; output: number; cacheRead?: number } | undefined =
    provider === 'openai'
      ? (OPENAI_PRICES.find(([id]) => model === id || model.includes(id))?.[1] ?? priceOf(model))
      : priceOf(model);
  if (!p) {
    log.warn('agent', 'operator model has no price; metering it at Opus 5 rates so the cost budget stays on', {
      provider,
      model,
    });
    return { price: costOf, basis: `${model} is unpriced, so it is metered at Opus 5 rates` };
  }
  return {
    price: (u) =>
      (u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (u.cache_read_input_tokens ?? 0) * (p.cacheRead ?? p.input * 0.1),
    basis: `${model} at its list price`,
  };
}
