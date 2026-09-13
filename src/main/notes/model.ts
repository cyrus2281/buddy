import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { log } from '../log.js';
import type { UsageLike } from '../agent/budget.js';

/// The Observer's model calls, behind one interface.
///
/// Same reason as `agent/client.ts`: the Provider seam in PRD §9, and the M3
/// checks. Every invariant worth testing about T2 and T3 — the cadence, the
/// cap, what lands in SQLite, how relations merge — is about what the engine
/// does with a *response*, not about the network. So the model is the seam, and
/// everything on this side of it is shipping code.

/** Prices per token, USD. Anthropic first-party rates.
 *
 *  These are used for the spend meter and the daily cap (PRD R5), not for
 *  billing, so they are allowed to be approximate — but they are wrong in a
 *  visible way if a model's price changes, which is why the rate lives beside
 *  the model id rather than being spread through the call sites. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  'claude-sonnet-5': { input: 2 / 1_000_000, output: 10 / 1_000_000 },
  'claude-opus-5': { input: 5 / 1_000_000, output: 25 / 1_000_000 },
};

/** T2. Haiku 4.5's image ceiling is why observer frames are downscaled
 *  separately from the Operator's — see `downscale.ts`. */
export const OBSERVER_MODEL = 'claude-haiku-4-5';
/** T3. Cheap enough to run hourly, good enough to merge entities sensibly. */
export const ROLLUP_MODEL = 'claude-sonnet-5';
/** Goal inference. Measured at ~$0.024 and 8.6 s median per activation (§6.7). */
export const INFERENCE_MODEL = 'claude-opus-5';
/** M4. Ask-about-my-day: FTS5 hits plus the notes, no images (PRD §9). */
export const QA_MODEL = 'claude-sonnet-5';
/**
 * M4. The standby condition check (PRD §6.6).
 *
 * Haiku by name in the PRD, and the reason is arithmetic rather than taste: a
 * wakeup checking every five minutes for an hour is twelve calls, and at Sonnet
 * prices with an image each that is real money spent on *not* doing anything.
 * One downscaled screenshot and a sentence through Haiku is a fraction of a
 * cent, which is what makes "check every five minutes, all afternoon" a feature
 * rather than a bill.
 */
export const WAKE_CHECK_MODEL = 'claude-haiku-4-5';

/** Models we have already said we cannot price. Latched so an unpriced model —
 *  a local one, which genuinely costs nothing — does not produce a warning
 *  every three minutes for the rest of the day. */
const unpriced = new Set<string>();

export function costOfCall(model: string, usage: UsageLike): number {
  const p = MODEL_PRICES[model];
  if (!p) {
    if (!unpriced.has(model)) {
      unpriced.add(model);
      log.warn('notes', 'no price for model; spend will under-report', { model });
    }
    return 0;
  }
  // Cache write/read are billed at 1.25x/0.1x of input. The Observer does not
  // currently set breakpoints, but counting them keeps the meter honest if it
  // starts to.
  return (
    (usage.input_tokens ?? 0) * p.input +
    (usage.output_tokens ?? 0) * p.output +
    (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * p.input * 0.1
  );
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

export interface StructuredRequest<T> {
  model: string;
  system: string;
  content: ContentBlock[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Omitted for Haiku 4.5, which rejects `output_config.effort` outright. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Adaptive thinking. Haiku 4.5 does not take it; Sonnet 5 and Opus 5 do. */
  thinking?: boolean;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  usage: UsageLike;
  costUsd: number;
  ms: number;
}

export interface StructuredClient {
  parse<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class AnthropicStructuredClient implements StructuredClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async parse<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const t0 = Date.now();
    const res = await this.client.messages.parse(
      {
        model: req.model,
        max_tokens: req.maxTokens ?? 8_000,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        // Haiku 4.5 rejects `effort`; passing `thinking: adaptive` to it is
        // equally a 400. Both are opt-in per call rather than defaulted, so a
        // cheap tier cannot inherit an expensive tier's settings by accident.
        ...(req.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
        output_config: {
          ...(req.effort ? { effort: req.effort } : {}),
          format: zodOutputFormat(req.schema as never),
        },
        messages: [{ role: 'user', content: req.content as never }],
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    const ms = Date.now() - t0;
    if (!res.parsed_output) throw new Error('structured output did not parse');
    return {
      value: res.parsed_output as T,
      usage: res.usage,
      costUsd: costOfCall(req.model, res.usage),
      ms,
    };
  }
}
