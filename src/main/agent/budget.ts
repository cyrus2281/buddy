import type { BudgetUsage, RunBudgets } from '../../shared/types.js';

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

  constructor(readonly limits: RunBudgets) {}

  /** One step per executed tool_use block — the same unit `run_steps` records,
   *  so the meter in the HUD and the row count in the Run Log always agree. */
  step(n = 1) {
    this.stepsUsed += n;
  }

  addUsage(u: UsageLike) {
    this.cost += costOf(u);
    this.cacheRead += u.cache_read_input_tokens ?? 0;
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
