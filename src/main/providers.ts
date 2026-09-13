import { z } from 'zod';
import { log } from './log.js';
import { secrets } from './secrets.js';
import { settings } from './settings.js';
import {
  AnthropicStructuredClient,
  OBSERVER_MODEL,
  QA_MODEL,
  ROLLUP_MODEL,
  costOfCall,
  type StructuredClient,
  type StructuredRequest,
  type StructuredResult,
} from './notes/model.js';
import type {
  OperatorAvailability,
  ProviderCapabilities,
  ProviderId,
  ProviderStatus,
} from '../shared/types.js';

/// The `Provider` seam (PRD §9), with the one capability flag that actually
/// decides something: `computerUse`.
///
/// §9.1's table is the whole point of this file. Anthropic is the only provider
/// with `computerUse: true`, and that is not a gap waiting for someone to fill
/// it — `computer_toolset_20260801` on Opus 5 has no equivalent at OpenAI or in
/// a local runtime, so the Operator hard-requires Claude and always will.
///
/// The failure this is written to prevent is specific and was named in the PRD:
/// a user configures OpenAI, presses the hotkey, and finds activation greyed
/// out with no explanation. So capability is a value the UI can read and print,
/// `operatorAvailability()` returns the *same sentence*
/// `orchestrator.start()` throws, and the Settings screen shows the matrix
/// rather than a provider dropdown that lies by omission.
///
/// Observation and Q&A are a different matter: both are "look at some pixels
/// and some text, return structured JSON", which every vision model does. Those
/// are switchable, and switching them is the point of the seam.

export const CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  anthropic: { computerUse: true, vision: true, structuredOutput: true, cheapBulk: true },
  // Vision and JSON-schema output, no computer toolset. Not a temporary state.
  openai: { computerUse: false, vision: true, structuredOutput: true, cheapBulk: true },
  // Depends entirely on the model pulled; the UI says a vision model is
  // required rather than discovering it as a blank observation at 3pm.
  local: { computerUse: false, vision: true, structuredOutput: true, cheapBulk: true },
};

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  local: 'Local / Ollama',
};

const NOTE: Record<ProviderId, string> = {
  anthropic:
    'Required. The only provider that can drive the machine — computer use is Claude-only, and the ' +
    'Operator will not start without a key here whatever else is configured.',
  openai:
    'Observation and Q&A only. It cannot drive the machine: there is no equivalent of ' +
    'computer_toolset_20260801, so pressing the hotkey will still need an Anthropic key.',
  local:
    'Observation and Q&A only, through an OpenAI-compatible endpoint. Needs a vision model — a ' +
    'text-only one will return nothing useful about a screenshot. Nothing leaves the machine.',
};

export function isConfigured(id: ProviderId): boolean {
  const s = settings.get();
  if (id === 'anthropic') return secrets.has('anthropic');
  if (id === 'openai') return secrets.has('openai');
  return !!s.localBaseUrl.trim() && !!s.localModel.trim();
}

export function modelsFor(id: ProviderId): { observe: string; rollup: string; qa: string } {
  const s = settings.get();
  if (id === 'anthropic') return { observe: OBSERVER_MODEL, rollup: ROLLUP_MODEL, qa: QA_MODEL };
  if (id === 'openai') return { observe: s.openaiModel, rollup: s.openaiModel, qa: s.openaiModel };
  return { observe: s.localModel, rollup: s.localModel, qa: s.localModel };
}

export function providerStatuses(): ProviderStatus[] {
  return (Object.keys(CAPABILITIES) as ProviderId[]).map((id) => ({
    id,
    label: LABEL[id],
    capabilities: CAPABILITIES[id],
    configured: isConfigured(id),
    note: NOTE[id],
    models: modelsFor(id),
  }));
}

/**
 * Can the hotkey actually run something?
 *
 * This returns the same sentence `orchestrator.start()` throws, and that is
 * deliberate: the UI and the guard must not be able to disagree about why
 * activation is unavailable. §9.1 says Settings has to make the Claude-only
 * rule unambiguous, and the honest way to do that is to have one message with
 * one author.
 */
export function operatorAvailability(): OperatorAvailability {
  if (secrets.has('anthropic')) return { available: true, reason: null };
  const s = settings.get();
  const other =
    s.observerProvider !== 'anthropic' || s.qaProvider !== 'anthropic'
      ? ` ${LABEL[s.observerProvider === 'anthropic' ? s.qaProvider : s.observerProvider]} is ` +
        'configured for observing and questions, and it still cannot do this one.'
      : '';
  return {
    available: false,
    reason: NO_ANTHROPIC_KEY + other,
  };
}

/** The one sentence, in one place. `orchestrator.start()` imports it. */
export const NO_ANTHROPIC_KEY =
  'No Anthropic API key. The Operator requires Claude — computer use is not available from any ' +
  'other provider (PRD §9.1). Add a key in Settings.';

// ── Clients ──────────────────────────────────────────────────────────────────

/**
 * OpenAI and OpenAI-compatible local runtimes, over `fetch`.
 *
 * No SDK. The surface used here is one POST to `/chat/completions` with
 * `response_format: json_schema`, and taking a dependency — plus its transitive
 * tree, plus an `electron-rebuild` surprise — to send one JSON body would be a
 * poor trade for an optional provider. Ollama serves the same route at
 * `/v1/chat/completions`, so one implementation covers both and the only
 * difference is a base URL and whether there is an Authorization header.
 */
export class OpenAICompatibleClient implements StructuredClient {
  constructor(
    private opts: { baseUrl: string; apiKey: string | null; label: string },
  ) {}

  async parse<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const t0 = Date.now();

    // The schema travels as JSON Schema. `strict` mode requires every property
    // to be required and additionalProperties false, which is what
    // `zodToStrictJsonSchema` normalises — a schema that fails that check is
    // rejected by the API with a message about the schema rather than about the
    // request, and it is not obvious the first time.
    const schema = zodToStrictJsonSchema(req.schema);

    const body = {
      model: req.model,
      max_completion_tokens: req.maxTokens ?? 8_000,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.content.map(toOpenAIPart) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'buddy_structured_output', strict: true, schema },
      },
    };

    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${this.opts.label} returned ${res.status}: ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.opts.label} returned no content`);

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error(`${this.opts.label} returned content that is not JSON`);
    }

    // Validated against the same zod schema the Anthropic path uses. A local
    // model that "mostly" honours a schema must not be able to write a
    // malformed note; the seam is the model, not the validation.
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${this.opts.label} returned output the schema rejects: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')
          .slice(0, 300)}`,
      );
    }

    const usage = {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    };
    return {
      value: parsed.data as T,
      usage,
      // A local runtime costs nothing and `costOfCall` returns 0 for an unpriced
      // model, which is the right answer for Ollama and an under-report for
      // OpenAI. The meter says which provider spent, so it is visible rather
      // than silently absent.
      costUsd: costOfCall(req.model, usage),
      ms: Date.now() - t0,
    };
  }
}

/** OpenAI's content parts, from buddy's provider-neutral blocks. */
function toOpenAIPart(b: { type: string; text?: string; source?: { data: string } }) {
  if (b.type === 'image' && b.source) {
    return { type: 'image_url', image_url: { url: `data:image/png;base64,${b.source.data}` } };
  }
  return { type: 'text', text: b.text ?? '' };
}

/**
 * zod → JSON Schema, normalised for OpenAI's `strict` mode.
 *
 * Every object must list all its properties in `required` and set
 * `additionalProperties: false`. zod's own emitter marks optional fields
 * optional, which is correct JSON Schema and a 400 here — so optionals become
 * required-and-nullable, which is what OpenAI documents as the equivalent.
 */
export function zodToStrictJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return strictify(json) as Record<string, unknown>;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const n = { ...(node as Record<string, unknown>) };
  delete n.$schema;
  if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
    const props = n.properties as Record<string, unknown>;
    for (const k of Object.keys(props)) props[k] = strictify(props[k]);
    n.required = Object.keys(props);
    n.additionalProperties = false;
  }
  if (n.items) n.items = strictify(n.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(n[key])) n[key] = (n[key] as unknown[]).map(strictify);
  }
  return n;
}

/**
 * A structured client for one role.
 *
 * Returns null rather than throwing when nothing is configured: the Observer is
 * silently off on a machine with no key rather than logging a failure every
 * three minutes, and that behaviour predates this file (`NotesEngine.client()`).
 */
export function clientFor(role: 'observe' | 'rollup' | 'qa'): {
  client: StructuredClient;
  provider: ProviderId;
  model: string;
} | null {
  const s = settings.get();
  const id: ProviderId = role === 'qa' ? s.qaProvider : s.observerProvider;
  const model = modelsFor(id)[role];

  if (id === 'anthropic') {
    const key = secrets.get('anthropic');
    if (!key) return null;
    return { client: new AnthropicStructuredClient(key), provider: id, model };
  }
  if (id === 'openai') {
    const key = secrets.get('openai');
    if (!key) {
      log.warn('providers', 'OpenAI is selected but no key is stored', { role });
      return null;
    }
    return {
      client: new OpenAICompatibleClient({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: key,
        label: 'OpenAI',
      }),
      provider: id,
      model,
    };
  }
  if (!s.localBaseUrl.trim() || !s.localModel.trim()) return null;
  return {
    client: new OpenAICompatibleClient({
      baseUrl: s.localBaseUrl,
      apiKey: null,
      label: `local (${s.localModel})`,
    }),
    provider: id,
    model,
  };
}
