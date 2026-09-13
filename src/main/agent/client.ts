import Anthropic from '@anthropic-ai/sdk';
import { log } from '../log.js';
import { OPERATOR_MODEL } from '../notes/model.js';
import type { UsageLike } from './budget.js';

/// The model call, behind an interface.
///
/// Two reasons it is an interface rather than a direct SDK call in the loop:
/// the Provider seam in PRD §9 (computer use is Claude-only, and the UI has to
/// be able to say so), and the M2 checks — every loop invariant worth testing
/// (batch fail-stop, pruning, budget parks, the deny path) is about what the
/// loop does with a response, not about the network.

export interface ModelResponse {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: string | null;
  usage: UsageLike;
}

export interface ModelClient {
  create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse>;
}

/** Re-exported from `notes/model.ts`, where every Anthropic default now lives
 *  beside its price and its override. The import path stays what it was because
 *  the loop and the live-run script both read it from here. */
export { OPERATOR_MODEL };

/**
 * Streams, per PRD §6.5. `max_tokens: 64000` with `thinking: adaptive` puts a
 * non-streaming request over the API's own duration guard, and streaming is
 * also what lets the HUD show a step feed that moves rather than one that jumps
 * once a turn.
 */
export class AnthropicClient implements ModelClient {
  private client: Anthropic;

  /** A blank base URL means the SDK's default host, not a relative request —
   *  same rule as `AnthropicStructuredClient`. */
  constructor(apiKey: string, baseUrl?: string | null) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: 3,
      ...(baseUrl?.trim() ? { baseURL: baseUrl.trim() } : {}),
    });
  }

  async create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    const stream = this.client.messages.stream(params);
    const message = await stream.finalMessage();

    // §6.5: a persistent zero here means a silent cache invalidator — a
    // reordered tool, a timestamp in the system prompt, a breakpoint that moved.
    log.debug('agent', 'turn usage', {
      in: message.usage.input_tokens,
      out: message.usage.output_tokens,
      cacheWrite: message.usage.cache_creation_input_tokens,
      cacheRead: message.usage.cache_read_input_tokens,
      stop: message.stop_reason,
    });

    return {
      content: message.content,
      stop_reason: message.stop_reason,
      usage: message.usage,
    };
  }
}
