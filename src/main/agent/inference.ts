import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../log.js';
import { getDb } from '../store/db.js';
import { notes, observations, relations, tasks } from '../store/notes.js';
import { downscaleFrame } from '../notes/downscale.js';
import { INFERENCE_MODEL, type ContentBlock, type StructuredClient } from '../notes/model.js';
import { GoalInferenceSchema, type GoalInference } from '../../../prompts/goal-inference.schema.js';
import { renderBundle, type ContextBundle, type Frame } from '../../../prompts/context-bundle.js';
import type { T0Signal } from '../capture/scheduler.js';
import type { GoalReading } from '../../shared/types.js';

/// Goal inference (PRD §6.1) — the thing that makes the typed goal unnecessary.
///
/// The prompt, the schema, and the bundle renderer are shared verbatim with
/// `evals/goal-inference`. That is not tidiness: an eval that exercises a copy
/// of the prompt measures the copy. `renderBundle` already handles both real
/// screenshots and the text stand-ins the fixtures use, so the only difference
/// between an eval run and a real activation is where the bundle came from.

/** §6.1 step 3, exactly. */
const FRAME_COUNT = 3;
const OBSERVATION_COUNT = 2;
const SIGNAL_WINDOW_MS = 5 * 60_000;

/** The system prompt is read from disk in development and from the bundled
 *  resource in a packaged app. It is the same file the eval reads, and a copy
 *  inlined at build time would drift from it the first time someone edited one
 *  and ran the other. */
let cachedSystem: string | null = null;

export function inferenceSystemPrompt(): string {
  if (cachedSystem) return cachedSystem;
  const candidates = [
    // Packaged: copied in by electron-builder's extraResources.
    path.join(process.resourcesPath ?? '', 'prompts', 'goal-inference.system.md'),
    // electron-vite dev, and `electron out/main/...` from the project root.
    path.join(app.getAppPath(), 'prompts', 'goal-inference.system.md'),
    path.join(process.cwd(), 'prompts', 'goal-inference.system.md'),
  ];
  for (const c of candidates) {
    try {
      cachedSystem = fs.readFileSync(c, 'utf8');
      return cachedSystem;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    'goal-inference.system.md was not found. Goal inference cannot run without the prompt it was tuned against.',
  );
}

const iso = (ms: number) => new Date(ms).toISOString();

interface BundleFrameRow {
  id: number;
  ts: number;
  app_name: string;
  window_title: string;
  path: string;
  bundle_id: string;
}

/**
 * Build the Context Bundle from what buddy actually knows.
 *
 * The newest frame goes at full logical resolution because it is the one the
 * goal is about; the two behind it are downscaled to the Observer's ceiling.
 * That is worth roughly half the image cost of an activation and loses nothing
 * — an older frame is context for a trajectory, not something the model reads
 * pixel-accurately, and §6.1 asks for full resolution on the newest one only.
 */
export function buildBundle(signals: T0Signal[], now = Date.now()): ContextBundle {
  const frameRows = (
    getDb()
      .prepare(
        `SELECT id, ts, app_name, window_title, path, bundle_id
           FROM frames WHERE deleted_at IS NULL ORDER BY ts DESC LIMIT ?`,
      )
      .all(FRAME_COUNT) as BundleFrameRow[]
  ).reverse(); // oldest first — renderBundle puts the newest nearest generation

  const frames: Frame[] = [];
  frameRows.forEach((r, i) => {
    const newest = i === frameRows.length - 1;
    let base64: string | undefined;
    if (newest) {
      try {
        base64 = fs.readFileSync(r.path).toString('base64');
      } catch {
        base64 = undefined;
      }
    } else {
      base64 = downscaleFrame(r.path)?.base64;
    }
    frames.push({
      ts: iso(r.ts),
      appName: r.app_name || '?',
      windowTitle: r.window_title || '',
      ...(base64
        ? { imageBase64: base64 }
        : { description: '(this frame has expired and is no longer on disk)' }),
    });
  });

  const recentSignals = signals.filter((s) => s.ts >= now - SIGNAL_WINDOW_MS);
  const appsOnScreen = [
    ...new Set([
      ...frameRows.map((r) => r.bundle_id).filter(Boolean),
      ...frameRows.map((r) => r.app_name).filter(Boolean),
      ...recentSignals.map((s) => s.bundleId).filter(Boolean),
    ]),
  ];

  return {
    now: iso(now),
    relations: relations.matchingApps(appsOnScreen).map((r) => ({
      kind: r.kind,
      displayName: r.displayName,
      identifier: r.identifier,
      note: r.body,
      frequency: r.frequency,
    })),
    tasks: tasks.open().map((t) => ({
      id: String(t.id),
      status: t.status,
      scope: t.scope,
      title: t.title,
      body: t.body,
      lastSeenAt: iso(t.lastSeenAt),
    })),
    observations: observations.recent(OBSERVATION_COUNT).map((o) => ({
      tsStart: iso(o.tsStart),
      tsEnd: iso(o.tsEnd),
      summary: o.summary,
      apps: o.apps,
      confidence: o.confidence,
    })),
    signals: recentSignals.map((s) => ({
      ts: iso(s.ts),
      appName: s.appName || '?',
      windowTitle: s.windowTitle || '',
      idleSeconds: s.idleSeconds,
    })),
    frames,
  };
}

/**
 * The provisional goal (PRD §6.1 step 2).
 *
 * Synchronous, indexed, and local. Measured inference latency is 8.6 s median
 * and up to 22 s, so this is the only thing standing between the hotkey and a
 * ten-second blank stare — the PRD calls it load-bearing and means it. Nothing
 * in here may do IO beyond one SQLite read.
 */
export function provisionalGoal(frontWindowTitle?: string): {
  goal: string | null;
  source: 'task-note' | 'observation' | 'window-title' | 'none';
} {
  const task = tasks.newestOpen();
  if (task) return { goal: task.title, source: 'task-note' };

  const obs = observations.latest();
  if (obs?.summary) {
    // The summary is a sentence about the past; the HUD wants the thing to
    // continue. Taking the first clause is a cheap approximation and it is
    // replaced within seconds either way.
    const first = obs.summary.split(/(?<=\.)\s+/)[0]!.trim();
    return { goal: first, source: 'observation' };
  }

  if (frontWindowTitle?.trim()) {
    return { goal: `Continue in “${frontWindowTitle.trim()}”`, source: 'window-title' };
  }
  return { goal: null, source: 'none' };
}

export interface InferenceOutcome {
  reading: GoalReading;
  costUsd: number;
  ms: number;
}

/**
 * The model call. `effort: 'high'` and adaptive thinking, per §6.7's sweep —
 * `medium` saved no meaningful latency and was less stable, and the numbers in
 * the PRD were measured at `high`.
 */
export async function inferGoal(
  client: StructuredClient,
  bundle: ContextBundle,
  signal?: AbortSignal,
): Promise<InferenceOutcome> {
  const res = await client.parse<GoalInference>({
    model: INFERENCE_MODEL,
    system: inferenceSystemPrompt(),
    content: renderBundle(bundle) as ContentBlock[],
    schema: GoalInferenceSchema,
    maxTokens: 16_000,
    thinking: true,
    effort: 'high',
    signal,
  });

  const r = res.value;
  if (r.injection_notice) {
    log.warn('inference', 'on-screen text tried to instruct the model; the goal is unchanged', {
      quote: r.injection_notice.slice(0, 200),
    });
  }
  log.info('inference', 'goal inferred', {
    confidence: r.confidence,
    profile: r.proposed_profile,
    risks: r.risk_flags.length,
    apps: r.target_apps.length,
    cost: res.costUsd.toFixed(4),
    ms: res.ms,
  });

  return { reading: r as GoalReading, costUsd: res.costUsd, ms: res.ms };
}

/** How many notes the bundle drew on, for the HUD's "read from N notes" line. */
export function bundleSize(b: ContextBundle) {
  return {
    frames: b.frames.length,
    tasks: b.tasks.length,
    relations: b.relations.length,
    observations: b.observations.length,
    signals: b.signals.length,
    notes: notes.stats().recaps,
  };
}
