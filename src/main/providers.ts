import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { log } from './log.js';
import { secrets } from './secrets.js';
import { settings } from './settings.js';
import {
  AnthropicStructuredClient,
  anthropicModel,
  costOfCall,
  type StructuredClient,
  type StructuredRequest,
  type StructuredResult,
} from './notes/model.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { CUA_DRIVER_MISSING, cuaBinaryPath } from './cua/driver.js';
import type {
  AnthropicRole,
  OperatorAvailability,
  OperatorBackend,
  ProviderCapabilities,
  ProviderId,
  ProviderProbe,
  ProviderStatus,
  ProviderTestResult,
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
///
/// **The cua backend changes the Operator's requirement, not the rule.** With
/// `operatorBackend: 'cua'` the machine is driven by cua-driver and the model
/// sees ordinary function tools with image results — `functionTools` plus
/// `vision`, which all three providers have. Claude-only is still exactly true
/// of the toolset, and the toolset is still the default. Either way there is
/// one sentence with one author: `operatorAvailability()` returns what
/// `orchestrator.start()` throws, per backend.

export const CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  anthropic: { computerUse: true, functionTools: true, vision: true, structuredOutput: true, cheapBulk: true },
  // Vision and JSON-schema output, no computer toolset. Not a temporary state.
  // Function tools, so it can drive the machine through cua-driver.
  openai: { computerUse: false, functionTools: true, vision: true, structuredOutput: true, cheapBulk: true },
  // Depends entirely on the model pulled; the UI says a vision model is
  // required rather than discovering it as a blank observation at 3pm. The
  // same goes for tool calling when it is the Operator.
  local: { computerUse: false, functionTools: true, vision: true, structuredOutput: true, cheapBulk: true },
};

/** Can this provider be the Operator on this backend? */
export function canOperate(id: ProviderId, backend: OperatorBackend): boolean {
  const c = CAPABILITIES[id];
  return backend === 'toolset' ? c.computerUse : c.functionTools && c.vision;
}

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

/** The same notes, for the cua backend — where driving the machine is a
 *  function-tool job any of the three can do. */
const NOTE_CUA: Record<ProviderId, string> = {
  anthropic:
    'Drives the machine through cua-driver when chosen as the Operator below, over any Messages-API ' +
    'endpoint — a gateway included. Observation and Q&A as before.',
  openai:
    'Can drive the machine through cua-driver when chosen as the Operator below: plain function ' +
    'tools, screenshots as image parts. Observation and Q&A as before.',
  local:
    'Can drive the machine through cua-driver when chosen as the Operator below — the model must do ' +
    'tool calling and vision, and needs a context window far beyond Ollama’s default. Nothing leaves ' +
    'the machine.',
};

/**
 * Where each provider's requests go.
 *
 * Every provider is addressable now, not just the local one. The case is the
 * same in all three: a gateway, an Azure deployment, a corporate proxy that
 * terminates TLS and wants the traffic to look like its own — the API is the
 * API, and the host is deployment configuration rather than a property of the
 * provider. Blank means the first-party default, which for Anthropic is the
 * SDK's own (returned as null so the SDK keeps owning that string).
 */
export function anthropicBaseUrl(): string | null {
  return settings.get().anthropicBaseUrl.trim() || null;
}

export function openaiBaseUrl(): string {
  return settings.get().openaiBaseUrl.trim() || DEFAULT_SETTINGS.openaiBaseUrl;
}

export function isConfigured(id: ProviderId): boolean {
  const s = settings.get();
  if (id === 'anthropic') return secrets.has('anthropic');
  if (id === 'openai') return secrets.has('openai');
  return !!s.localBaseUrl.trim() && !!s.localModel.trim();
}

export function modelsFor(id: ProviderId): { observe: string; rollup: string; qa: string } {
  const s = settings.get();
  if (id === 'anthropic') {
    return {
      observe: anthropicModel('observe'),
      rollup: anthropicModel('rollup'),
      qa: anthropicModel('qa'),
    };
  }
  if (id === 'openai') return { observe: s.openaiModel, rollup: s.openaiModel, qa: s.openaiModel };
  return { observe: s.localModel, rollup: s.localModel, qa: s.localModel };
}

export function providerStatuses(): ProviderStatus[] {
  return (Object.keys(CAPABILITIES) as ProviderId[]).map((id) => ({
    id,
    label: LABEL[id],
    capabilities: CAPABILITIES[id],
    configured: isConfigured(id),
    note: settings.get().operatorBackend === 'cua' ? NOTE_CUA[id] : NOTE[id],
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
  const reason = operatorUnavailableReason();
  return reason ? { available: false, reason } : { available: true, reason: null };
}

/** The sentence, or null. Shared by `operatorAvailability()` and
 *  `cuaOperatorSetup()`, which throws it — so the two cannot disagree. */
export function operatorUnavailableReason(): string | null {
  const s = settings.get();
  if (s.operatorBackend === 'cua') {
    if (!cuaBinaryPath()) return CUA_DRIVER_MISSING;
    if (!isConfigured(s.operatorProvider)) return NO_OPERATOR_PROVIDER[s.operatorProvider];
    return null;
  }
  if (secrets.has('anthropic')) return null;
  const other =
    s.observerProvider !== 'anthropic' || s.qaProvider !== 'anthropic'
      ? ` ${LABEL[s.observerProvider === 'anthropic' ? s.qaProvider : s.observerProvider]} is ` +
        'configured for observing and questions, and it still cannot do this one.'
      : '';
  return NO_ANTHROPIC_KEY + other;
}

/** The cua backend's version of NO_ANTHROPIC_KEY: whichever provider is set to
 *  drive has nothing to drive with. */
export const NO_OPERATOR_PROVIDER: Record<ProviderId, string> = {
  anthropic:
    'No Anthropic API key. The Operator is set to run Claude through cua-driver; add a key in ' +
    'Settings, or choose another provider for the Operator.',
  openai:
    'No OpenAI API key. The Operator is set to run on OpenAI through cua-driver; add a key in ' +
    'Settings, or choose another provider for the Operator.',
  local:
    'No local endpoint and model. The Operator is set to run on a local model through cua-driver; ' +
    'set both in Settings, or choose another provider for the Operator.',
};

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
      throw new ProviderHttpError(`${this.opts.label} returned ${res.status}: ${text.slice(0, 400)}`, res.status);
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

/** A non-2xx from an OpenAI-compatible endpoint, with the status kept as a
 *  number so Settings' connection test can say *which* failure it was rather
 *  than parsing it back out of a sentence. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
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
    return {
      client: new AnthropicStructuredClient(key, anthropicBaseUrl()),
      provider: id,
      model,
    };
  }
  if (id === 'openai') {
    const key = secrets.get('openai');
    if (!key) {
      log.warn('providers', 'OpenAI is selected but no key is stored', { role });
      return null;
    }
    return {
      client: new OpenAICompatibleClient({
        baseUrl: openaiBaseUrl(),
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

// ── Test connection ──────────────────────────────────────────────────────────

/**
 * Settings' **Test** button: one tiny real call per model id, through the same
 * host, key and model buddy would use, with the failure said in words a person
 * can act on.
 *
 * The configuration it checks is exactly the kind that fails late and quietly.
 * A wrong gateway model id surfaces as a T2 observation that never lands, three
 * minutes after the change, as one warning line in the log; a revoked key
 * surfaces at the hotkey, which is the worst moment to find out. A button that
 * answers "does this work?" while the person is still looking at the field they
 * just edited is the cheap fix.
 *
 * **Anthropic probes every distinct id, not one.** The six roles carry their
 * own ids (§9.1), and the gateway case is precisely the one where five of them
 * resolve and the sixth 404s. Roles sharing an id share a probe, and the result
 * names every role that id serves, so "observe and wake are broken" reads off
 * the screen rather than out of a log.
 *
 * **The OpenAI-compatible path is tested the way buddy uses it**: a JSON-schema
 * request validated by zod. An endpoint that answers chat but ignores
 * `response_format` passes a "hello" and then fails every observation; that is
 * the most common way a local model is wrong for this job, so it is what the
 * test asks.
 *
 * Every probe is metered. It is a few hundredths of a cent, and the spend meter
 * promises the whole truth.
 */
export interface ProbeDeps {
  /** Injected in the checks, which have no Keychain to read. */
  key?: (name: 'anthropic' | 'openai') => string | null;
  /** The spend meter. Called once per probe that reached a model. */
  record?: (costUsd: number) => void;
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 20_000;

const ANTHROPIC_ROLES: AnthropicRole[] = ['operator', 'inference', 'observe', 'rollup', 'qa', 'wake'];

/** The probe's own schema: small enough that any model honouring JSON schema
 *  at all can fill it, and strict enough that one which does not is caught. */
const ProbeSchema = z.object({ ok: z.boolean() });

const PROBE_PROMPT = 'This is a connection test. Reply with OK.';

export async function testProvider(id: ProviderId, deps: ProbeDeps = {}): Promise<ProviderTestResult> {
  const key = deps.key ?? ((name) => secrets.get(name));
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const s = settings.get();
  const testedAt = Date.now();

  if (id === 'anthropic') {
    const endpoint = anthropicBaseUrl() ?? 'https://api.anthropic.com';
    const apiKey = key('anthropic');
    if (!apiKey) {
      return { provider: id, endpoint, ok: false, probes: [], skipped: 'No Anthropic key is stored, so there is nothing to test.', testedAt };
    }
    const byModel = new Map<string, AnthropicRole[]>();
    for (const role of ANTHROPIC_ROLES) {
      const model = anthropicModel(role);
      byModel.set(model, [...(byModel.get(model) ?? []), role]);
    }
    const client = new Anthropic({
      apiKey,
      // A test that retries hides exactly what it was asked to find: a flaky
      // gateway looks healthy after the SDK's second attempt.
      maxRetries: 0,
      timeout: timeoutMs,
      ...(anthropicBaseUrl() ? { baseURL: anthropicBaseUrl()! } : {}),
    });
    const probes = await Promise.all(
      [...byModel].map(async ([model, roles]): Promise<ProviderProbe> => {
        const t0 = Date.now();
        try {
          const res = await client.messages.create({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: PROBE_PROMPT }],
          });
          const costUsd = costOfCall(model, res.usage);
          deps.record?.(costUsd);
          return { model, roles, ok: true, ms: Date.now() - t0, status: 200, error: null, costUsd };
        } catch (e) {
          const status = e instanceof Anthropic.APIError && typeof e.status === 'number' ? e.status : null;
          return {
            model,
            roles,
            ok: false,
            ms: Date.now() - t0,
            status,
            error: explainProbeFailure(e, { status, endpoint, model, provider: 'Anthropic', timeoutMs }),
            costUsd: 0,
          };
        }
      }),
    );
    return finishTest(id, endpoint, probes, testedAt);
  }

  const roles = [
    ...(s.observerProvider === id ? ['observe', 'rollup'] : []),
    ...(s.qaProvider === id ? ['qa'] : []),
  ];

  if (id === 'openai') {
    const endpoint = openaiBaseUrl();
    const apiKey = key('openai');
    if (!apiKey) {
      return { provider: id, endpoint, ok: false, probes: [], skipped: 'No OpenAI key is stored, so there is nothing to test.', testedAt };
    }
    const probe = await probeCompatible(
      new OpenAICompatibleClient({ baseUrl: endpoint, apiKey, label: 'OpenAI' }),
      { model: s.openaiModel.trim(), roles, endpoint, provider: 'OpenAI', timeoutMs, record: deps.record },
    );
    return finishTest(id, endpoint, [probe], testedAt);
  }

  const endpoint = s.localBaseUrl.trim();
  if (!endpoint || !s.localModel.trim()) {
    return {
      provider: id,
      endpoint: endpoint || '(none)',
      ok: false,
      probes: [],
      skipped: 'Set an endpoint and a model first.',
      testedAt,
    };
  }
  const probe = await probeCompatible(
    new OpenAICompatibleClient({ baseUrl: endpoint, apiKey: null, label: `local (${s.localModel})` }),
    { model: s.localModel.trim(), roles, endpoint, provider: 'The local runtime', timeoutMs, record: deps.record },
  );
  return finishTest(id, endpoint, [probe], testedAt);
}

async function probeCompatible(
  client: OpenAICompatibleClient,
  o: {
    model: string;
    roles: string[];
    endpoint: string;
    provider: string;
    timeoutMs: number;
    record?: (costUsd: number) => void;
  },
): Promise<ProviderProbe> {
  const t0 = Date.now();
  try {
    const res = await client.parse({
      model: o.model,
      system: 'Answer with a JSON object {"ok": true}.',
      content: [{ type: 'text', text: PROBE_PROMPT }],
      schema: ProbeSchema,
      maxTokens: 64,
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    o.record?.(res.costUsd);
    return { model: o.model, roles: o.roles, ok: true, ms: Date.now() - t0, status: 200, error: null, costUsd: res.costUsd };
  } catch (e) {
    const status = e instanceof ProviderHttpError ? e.status : null;
    return {
      model: o.model,
      roles: o.roles,
      ok: false,
      ms: Date.now() - t0,
      status,
      error: explainProbeFailure(e, { status, endpoint: o.endpoint, model: o.model, provider: o.provider, timeoutMs: o.timeoutMs }),
      costUsd: 0,
    };
  }
}

function finishTest(
  provider: ProviderId,
  endpoint: string,
  probes: ProviderProbe[],
  testedAt: number,
): ProviderTestResult {
  const ok = probes.length > 0 && probes.every((p) => p.ok);
  log.info('providers', 'connection test', {
    provider,
    endpoint,
    ok,
    probes: probes.map((p) => `${p.model}:${p.ok ? 'ok' : (p.status ?? 'unreachable')}`),
  });
  return { provider, endpoint, ok, probes, skipped: null, testedAt };
}

/**
 * One sentence per failure, naming the thing to change.
 *
 * The raw error is kept on the end because a gateway's own message is often
 * the most specific fact available — but it goes after the explanation, since
 * "404 not_found_error" on its own does not say whether the model id or the
 * URL is the wrong one.
 */
export function explainProbeFailure(
  e: unknown,
  c: { status: number | null; endpoint: string; model: string; provider: string; timeoutMs: number },
): string {
  const err = e as { message?: string; name?: string; cause?: { code?: string; message?: string } };
  const raw = (err?.message ?? String(e)).replace(/\s+/g, ' ').trim().slice(0, 200);
  const detail = raw ? ` (${raw})` : '';
  // The SDK wraps fetch's TypeError, which wraps the socket error — so the code
  // that actually says what happened is two causes down, under a message that
  // says only "Connection error."
  let code: string | null = null;
  for (let c: unknown = e, depth = 0; c && depth < 5 && !code; c = (c as { cause?: unknown }).cause, depth++) {
    const k = (c as { code?: unknown }).code;
    if (typeof k === 'string') code = k;
  }
  code ??= /(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|CERT_[A-Z_]+)/.exec(raw)?.[1] ?? null;

  if (
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    e instanceof Anthropic.APIConnectionTimeoutError ||
    /timed? ?out/i.test(raw)
  ) {
    return `No answer from ${c.endpoint} within ${Math.round(c.timeoutMs / 1000)} s.`;
  }
  if (c.status == null) {
    if (code === 'ECONNREFUSED') return `Nothing is listening at ${c.endpoint}. Is the server running, and is the port right?`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The host in ${c.endpoint} does not resolve. Check the URL.`;
    if (code?.startsWith('CERT_')) return `${c.endpoint} presented a certificate this Mac does not trust${detail}.`;
    if (e instanceof z.ZodError || /schema rejects|not JSON|no content|did not parse/i.test(raw)) {
      return (
        `${c.provider} answered, but not with JSON that fits a schema — buddy needs structured output for ` +
        `every tier, so ${c.model} will not work here${detail}.`
      );
    }
    return `Could not reach ${c.endpoint}${detail}.`;
  }
  switch (c.status) {
    case 400:
      return `${c.provider} rejected the request${detail}.`;
    case 401:
      return `The key was rejected (401). Paste it again, or check it is a key for ${c.endpoint}.`;
    case 403:
      return `The key is valid but not allowed to use ${c.model} (403)${detail}.`;
    case 404:
      return (
        `Not found (404): either ${c.model} is not a model this endpoint serves, or the endpoint URL is ` +
        `wrong${detail}.`
      );
    case 429:
      return `Rate limited (429). The key and model are accepted; the account has no capacity right now.`;
    default:
      if (c.status >= 500) return `${c.provider} had a problem of its own (${c.status}). Try again shortly${detail}.`;
      return `${c.provider} answered ${c.status}${detail}.`;
  }
}
