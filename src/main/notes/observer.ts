import { getDb } from '../store/db.js';
import { observations } from '../store/notes.js';
import { log } from '../log.js';
import { phashDistance } from '../capture/phash.js';
import { downscaleFrame } from './downscale.js';
import { ObserveSchema, type ObserveOutput } from './schemas.js';
import { OBSERVE_SYSTEM } from './prompts.js';
import { OBSERVER_MODEL, type ContentBlock, type StructuredClient } from './model.js';
import type { T0Signal } from '../capture/scheduler.js';
import type { ObservationRow } from '../../shared/types.js';

/// T2 — the observe tier (PRD §5).
///
/// Every ~3 minutes, or immediately on a context switch: the 3–6 most-changed
/// new frames plus the T0 event log, to Haiku 4.5, producing exactly one
/// `observations` row.
///
/// "Most-changed" is the whole trick. T1 already discarded near-identical
/// frames, so what survives is a sequence of moments — but twelve of them in
/// three minutes is eight more than the model needs to tell what someone was
/// doing, and images are almost all of the cost. Ranking by perceptual distance
/// from the previous kept frame picks the moments where something actually
/// happened, and drops the ones that were merely different enough to keep.

/** PRD §5. Below three the model is guessing at a trajectory from a snapshot;
 *  above six the marginal frame is paying full image price for a detail. */
export const MIN_FRAMES = 3;
export const MAX_FRAMES = 6;

export interface ObserverFrame {
  id: number;
  ts: number;
  appName: string;
  windowTitle: string;
  path: string;
  phash: string;
}

/**
 * The frames to send, newest last.
 *
 * Always includes the first and last of the window whatever their rank: the
 * first is where the period started and the last is the screen as it is now,
 * and a middle-heavy selection describes a journey with no endpoints.
 */
export function selectFrames(candidates: ObserverFrame[], max = MAX_FRAMES): ObserverFrame[] {
  if (candidates.length <= max) return [...candidates].sort((a, b) => a.ts - b.ts);

  const ordered = [...candidates].sort((a, b) => a.ts - b.ts);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;

  const scored = ordered.slice(1, -1).map((f, i) => ({
    frame: f,
    // Distance from the frame before it: how much changed to produce this one.
    change: phashDistance(f.phash, ordered[i]!.phash),
  }));
  scored.sort((a, b) => b.change - a.change);

  const picked = [first, last, ...scored.slice(0, Math.max(0, max - 2)).map((s) => s.frame)];
  const seen = new Set<number>();
  return picked
    .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
    .sort((a, b) => a.ts - b.ts);
}

/** Live frames captured since the last observation, oldest first. */
export function newFramesSince(sinceTs: number, limit = 40): ObserverFrame[] {
  return (
    getDb()
      .prepare(
        `SELECT id, ts, app_name, window_title, path, phash
           FROM frames
          WHERE deleted_at IS NULL AND ts > ?
          ORDER BY ts
          LIMIT ?`,
      )
      .all(sinceTs, limit) as {
      id: number;
      ts: number;
      app_name: string;
      window_title: string;
      path: string;
      phash: string;
    }[]
  ).map((r) => ({
    id: r.id,
    ts: r.ts,
    appName: r.app_name,
    windowTitle: r.window_title,
    path: r.path,
    phash: r.phash,
  }));
}

/** The T0 log, rendered the way §5 describes it: what was frontmost, when. */
export function renderSignals(signals: T0Signal[]): string {
  if (!signals.length) return '(no signal log for this period)';
  // Collapsed into runs: 90 lines of "Slack, Slack, Slack" is the same fact
  // ninety times, and the model pays for each one.
  const runs: { from: number; to: number; app: string; title: string; maxIdle: number }[] = [];
  for (const s of signals) {
    const last = runs[runs.length - 1];
    if (last && last.app === s.appName && last.title === s.windowTitle) {
      last.to = s.ts;
      last.maxIdle = Math.max(last.maxIdle, s.idleSeconds);
      continue;
    }
    runs.push({ from: s.ts, to: s.ts, app: s.appName, title: s.windowTitle, maxIdle: s.idleSeconds });
  }
  const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return runs
    .map((r) => {
      const secs = Math.round((r.to - r.from) / 1000);
      const idle = r.maxIdle >= 60 ? ` · idle up to ${Math.round(r.maxIdle / 60)}m` : '';
      return `${t(r.from)}–${t(r.to)}  ${r.app || '?'} — "${r.title || '(no title)'}" (${secs}s)${idle}`;
    })
    .join('\n');
}

export interface ObserveInput {
  frames: ObserverFrame[];
  signals: T0Signal[];
  trigger: 'interval' | 'context-switch' | 'manual';
}

export interface ObserveResult {
  observation: ObservationRow;
  costUsd: number;
  ms: number;
  framesSent: number;
  injectionNotice: string | null;
}

/**
 * One observation.
 *
 * Frames that expired between selection and read are skipped rather than
 * fatal — the retention sweep runs hourly and can land mid-observation, and an
 * observation of four frames instead of five is still a true observation.
 * `frame_ids` records only what was actually sent, so a note that cites this
 * observation cites frames that existed.
 */
export async function observe(
  client: StructuredClient,
  input: ObserveInput,
): Promise<ObserveResult | null> {
  const chosen = selectFrames(input.frames);
  if (!chosen.length) return null;

  const content: ContentBlock[] = [];
  const sent: ObserverFrame[] = [];
  const images: ContentBlock[] = [];

  for (const f of chosen) {
    const img = downscaleFrame(f.path);
    if (!img) {
      log.debug('observer', 'frame gone before it could be sent', { id: f.id });
      continue;
    }
    sent.push(f);
    images.push({
      type: 'text',
      text:
        `frame ${sent.length} — ${new Date(f.ts).toLocaleTimeString()} — ${f.appName || '?'} — ` +
        `"${f.windowTitle || '(no title)'}"`,
    });
    images.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: img.base64 },
    });
  }

  if (sent.length === 0) {
    log.info('observer', 'every selected frame had expired; nothing to observe');
    return null;
  }

  const tsStart = sent[0]!.ts;
  const tsEnd = sent[sent.length - 1]!.ts;

  content.push({
    type: 'text',
    text:
      `Period: ${new Date(tsStart).toLocaleTimeString()} – ${new Date(tsEnd).toLocaleTimeString()}\n` +
      `Triggered by: ${input.trigger}\n\n` +
      `<signals>\n${renderSignals(input.signals)}\n</signals>\n\n<frames>`,
  });
  content.push(...images);
  content.push({ type: 'text', text: '</frames>\n\nWrite the observation.' });

  const res = await client.parse<ObserveOutput>({
    model: OBSERVER_MODEL,
    system: OBSERVE_SYSTEM,
    content,
    schema: ObserveSchema,
    maxTokens: 2_000,
    // Haiku 4.5 rejects `effort` and takes no adaptive thinking. Both omitted
    // on purpose; see `model.ts`.
  });

  const out = res.value;
  const observation = observations.insert({
    tsStart,
    tsEnd,
    summary: out.summary,
    apps: out.apps,
    entities: out.entities,
    confidence: out.confidence,
    frameIds: sent.map((f) => f.id),
  });

  if (out.injection_notice) {
    log.warn('observer', 'on-screen text tried to give instructions; it was not followed', {
      quote: out.injection_notice.slice(0, 200),
    });
  }

  log.info('observer', 'observation written', {
    id: observation.id,
    trigger: input.trigger,
    frames: sent.length,
    confidence: out.confidence,
    cost: res.costUsd.toFixed(4),
    ms: res.ms,
  });

  return {
    observation,
    costUsd: res.costUsd,
    ms: res.ms,
    framesSent: sent.length,
    injectionNotice: out.injection_notice,
  };
}
