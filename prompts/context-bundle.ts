/**
 * The Context Bundle is everything buddy knows at the moment of activation.
 *
 * Ordering is deliberate: most-stable first, most-volatile last, so that
 *   (a) the prompt-cache prefix stays intact across activations, and
 *   (b) the strongest recency signal sits closest to the generation point.
 */

export interface Relation {
  kind: "person" | "app" | "product" | "customer" | "tool" | "repo" | "channel";
  displayName: string;
  identifier?: string;
  note: string;
  frequency: number;
}

export interface TaskNote {
  id: string;
  status: "open" | "blocked" | "waiting" | "done";
  scope: "session" | "day" | "week";
  title: string;
  body: string;
  lastSeenAt: string;
}

export interface Observation {
  tsStart: string;
  tsEnd: string;
  summary: string;
  apps: string[];
  confidence: number;
}

/** T0: cheap, every ~2s. Frontmost app + window title + idle time. */
export interface Signal {
  ts: string;
  appName: string;
  windowTitle: string;
  idleSeconds: number;
}

export interface Frame {
  ts: string;
  appName: string;
  windowTitle: string;
  /** Base64 PNG, already downscaled to logical points. Omitted in text-only fixtures. */
  imageBase64?: string;
  /** Stand-in used by text-only fixtures so the eval can run without screenshots. */
  description?: string;
}

export interface ContextBundle {
  now: string;
  relations: Relation[];
  tasks: TaskNote[];
  /** Newest first. */
  observations: Observation[];
  /** Newest first. */
  signals: Signal[];
  /** Oldest first — the newest frame renders last, nearest the generation point. */
  frames: Frame[];
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
};
export type ContentBlock = TextBlock | ImageBlock;

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

export function renderRelations(rs: Relation[]): string {
  if (!rs.length) return "<relations>\n(none yet)\n</relations>";
  const lines = rs.map(
    (r) =>
      `${pad(r.kind, 9)}${r.displayName}${r.identifier ? ` (${r.identifier})` : ""} — ${r.note} · seen ${r.frequency}x`
  );
  return `<relations>\n${lines.join("\n")}\n</relations>`;
}

export function renderTasks(ts: TaskNote[]): string {
  if (!ts.length) return "<tasks>\n(no open tasks)\n</tasks>";
  const lines = ts.map(
    (t) =>
      `[${t.id}] ${pad(t.status, 9)}${pad(t.scope, 9)}${t.title}\n` +
      `${" ".repeat(8)}${t.body}\n` +
      `${" ".repeat(8)}last touched ${t.lastSeenAt}`
  );
  return `<tasks>\n${lines.join("\n\n")}\n</tasks>`;
}

export function renderObservations(os: Observation[]): string {
  if (!os.length) return "<observations>\n(none)\n</observations>";
  const lines = os.map(
    (o) =>
      `[${o.tsStart}–${o.tsEnd}] ${o.summary}\n` +
      `${" ".repeat(8)}apps: ${o.apps.join(", ")} · confidence ${o.confidence}`
  );
  return `<observations>\n${lines.join("\n\n")}\n</observations>`;
}

export function renderSignals(ss: Signal[]): string {
  if (!ss.length) return "<signals>\n(none)\n</signals>";
  const lines = ss.map(
    (s) => `${s.ts}  ${pad(s.appName, 12)}${pad(`"${s.windowTitle}"`, 44)}idle ${s.idleSeconds}s`
  );
  return `<signals>\n${lines.join("\n")}\n</signals>`;
}

/**
 * Renders the bundle to Anthropic content blocks.
 *
 * Frames become interleaved caption + image pairs so the model can tell them
 * apart; a fixture without `imageBase64` degrades to its `description` text,
 * which exercises the reasoning but NOT the visual grounding.
 */
export function renderBundle(b: ContextBundle): ContentBlock[] {
  const blocks: ContentBlock[] = [
    {
      type: "text",
      text: [
        `Current time: ${b.now}`,
        "",
        renderRelations(b.relations),
        "",
        renderTasks(b.tasks),
        "",
        renderObservations(b.observations),
        "",
        renderSignals(b.signals),
        "",
        "<frames>",
      ].join("\n"),
    },
  ];

  b.frames.forEach((f, i) => {
    blocks.push({
      type: "text",
      text: `frame ${i + 1} of ${b.frames.length} — ${f.ts} — ${f.appName} — "${f.windowTitle}"`,
    });
    if (f.imageBase64) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: f.imageBase64 },
      });
    } else if (f.description) {
      blocks.push({ type: "text", text: `[screen contents] ${f.description}` });
    }
  });

  blocks.push({
    type: "text",
    text: "</frames>\n\nRead the bundle and produce the structured reading.",
  });
  return blocks;
}
