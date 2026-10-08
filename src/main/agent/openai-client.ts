import type Anthropic from '@anthropic-ai/sdk';
import { log } from '../log.js';
import { ProviderHttpError } from '../providers.js';
import type { ModelClient, ModelResponse } from './client.js';

/// The Operator on an OpenAI-compatible model: `/chat/completions` with
/// function tools, behind the same `ModelClient` the runner already calls.
///
/// **The transcript stays Anthropic-shaped.** The runner, the pruning, the
/// standby transcript and the Run Log all speak Messages-API blocks, and they
/// keep speaking them; this file translates at the wire, both ways, per call.
/// So a non-Claude Operator is one adapter rather than a second loop.
///
/// The translation, in the places it is not one-to-one:
///
/// - **Image tool results.** A `tool` message carries text only, so an image a
///   tool returned (`get_window_state`'s screenshot, `zoom`) goes in a user
///   message right after the tool messages, as `image_url` parts — the shape
///   Hermes Agent uses. The tool message says the image follows.
/// - **Thinking** blocks are dropped from history; OpenAI has its own
///   reasoning and does not take Anthropic's back.
/// - **`cache_control`** is dropped; OpenAI caches prefixes on its own and
///   reports it as `prompt_tokens_details.cached_tokens`, which becomes
///   `cache_read_input_tokens` so the meter prices it as a cache read.
/// - **The toolset** cannot be translated. The cua backend never sends it;
///   if anything ever does, this refuses rather than silently dropping it.
///
/// Same fetch-based approach as `OpenAICompatibleClient` in `providers.ts`, for
/// the same reason: no SDK dependency for one POST.

export interface OpenAIChatOptions {
  baseUrl: string;
  apiKey: string | null;
  label: string;
  /** `openai` sends `max_completion_tokens` and, for reasoning models,
   *  `reasoning_effort`; `local` sends `max_tokens` and nothing it might not
   *  understand. */
  flavor: 'openai' | 'local';
  timeoutMs?: number;
}

type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Output ceilings. The runner asks for 64k, which is Opus 5's streaming
 *  budget; a chat-completions model asked for more than it supports answers
 *  400 rather than clamping. */
const MAX_OUT = { openai: 32_000, local: 8_192 };

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class OpenAIChatModelClient implements ModelClient {
  constructor(private opts: OpenAIChatOptions) {}

  async create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelResponse> {
    const body = toChatRequest(params, this.opts.flavor);
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
        });
      } catch (e) {
        lastErr = e as Error;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = new ProviderHttpError(`${this.opts.label} returned ${res.status}: ${text.slice(0, 400)}`, res.status);
        if (RETRY_STATUS.has(res.status)) continue;
        throw lastErr;
      }
      const json = (await res.json()) as ChatResponse;
      const out = fromChatResponse(json);
      log.debug('agent', 'turn usage', {
        provider: this.opts.label,
        in: out.usage.input_tokens,
        out: out.usage.output_tokens,
        cacheRead: out.usage.cache_read_input_tokens,
        stop: out.stop_reason,
      });
      return out;
    }
    throw lastErr ?? new Error(`${this.opts.label} did not answer`);
  }
}

// ── Anthropic → chat completions ─────────────────────────────────────────────

export function toChatRequest(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  flavor: 'openai' | 'local',
): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  const system =
    typeof params.system === 'string'
      ? params.system
      : (params.system ?? []).map((b) => b.text).join('\n\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      messages.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    const blocks = m.content as unknown as Record<string, unknown>[];
    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text))
        .join('\n');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: String(b.id),
          type: 'function' as const,
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // A user turn: tool results first — they must follow the assistant's
    // tool_calls directly — then one user message with everything else,
    // including the images the tool results carried.
    const parts: ChatPart[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const inner = Array.isArray(b.content)
        ? (b.content as Record<string, unknown>[])
        : [{ type: 'text', text: String(b.content ?? '') }];
      const texts = inner.filter((x) => x.type === 'text').map((x) => String(x.text));
      const images = inner.filter((x) => x.type === 'image');
      if (images.length) texts.push(`(${images.length === 1 ? 'The image' : `${images.length} images`} from this result follow${images.length === 1 ? 's' : ''} in the next message.)`);
      messages.push({
        role: 'tool',
        tool_call_id: String(b.tool_use_id),
        content: (b.is_error ? 'ERROR: ' : '') + (texts.join('\n') || 'OK'),
      });
      for (const img of images) {
        parts.push({ type: 'text', text: `Image returned by tool call ${String(b.tool_use_id)}:` });
        parts.push(imagePart(img));
      }
    }
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: String(b.text) });
      else if (b.type === 'image') parts.push(imagePart(b));
    }
    if (parts.length) messages.push({ role: 'user', content: parts });
  }

  const tools = (params.tools ?? []).map((t) => {
    const tool = t as unknown as Record<string, unknown>;
    if (!('input_schema' in tool) || typeof tool.name !== 'string') {
      throw new Error(
        `${String(tool.type ?? 'a tool entry')} cannot be sent to an OpenAI-compatible model; only function tools translate. ` +
          'The Operator runs on these models only with Settings → Operator backend set to cua.',
      );
    }
    return {
      type: 'function',
      function: { name: tool.name, description: String(tool.description ?? ''), parameters: tool.input_schema },
    };
  });

  const max = Math.min(params.max_tokens ?? MAX_OUT[flavor], MAX_OUT[flavor]);
  const effort = (params as { output_config?: { effort?: string } }).output_config?.effort;
  return {
    model: params.model,
    messages,
    ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
    ...(flavor === 'openai' ? { max_completion_tokens: max } : { max_tokens: max }),
    // Only reasoning models take this, and a model that does not answers 400.
    ...(flavor === 'openai' && effort && /^(gpt-5|o\d)/.test(params.model) ? { reasoning_effort: effort } : {}),
  };
}

function imagePart(b: Record<string, unknown>): ChatPart {
  const src = (b.source ?? {}) as { media_type?: string; data?: string };
  return { type: 'image_url', image_url: { url: `data:${src.media_type ?? 'image/png'};base64,${src.data ?? ''}` } };
}

// ── chat completions → Anthropic ─────────────────────────────────────────────

interface ChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export function fromChatResponse(json: ChatResponse): ModelResponse {
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Record<string, unknown>[] = [];
  if (msg.content?.trim()) content.push({ type: 'text', text: msg.content, citations: null });
  for (const call of msg.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      // Passed through as-is: the executor reports a malformed call to the
      // model like any other bad input, which is what gets it fixed.
      input = { _unparsed_arguments: call.function?.arguments ?? '' };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name ?? '', input, caller: { type: 'direct' } });
  }
  const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const stop =
    choice?.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice?.finish_reason === 'length'
        ? 'max_tokens'
        : choice?.finish_reason === 'stop'
          ? 'end_turn'
          : (choice?.finish_reason ?? null);
  return {
    content: content as unknown as Anthropic.Messages.ContentBlock[],
    stop_reason: stop,
    usage: {
      input_tokens: Math.max(0, (json.usage?.prompt_tokens ?? 0) - cached),
      output_tokens: json.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}
