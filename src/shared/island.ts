import type { AppState, InferenceState, RunView, WakeupView } from './types.js';

/// The island: buddy's status, living in the MacBook's notch.
///
/// A run used to be visible in exactly one place — the HUD, which covers the
/// middle of the screen and collapses to a pill that still covers some of it.
/// The notch is the one strip of a MacBook display that is never content: the
/// camera lives there and nothing else can. So buddy's status lives there too,
/// and grows out of it, the way the phone's Dynamic Island does — black on
/// black at rest, so on a notched display it is invisible until there is
/// something to say.
///
/// This file is the part with no pixels in it: where the window goes, and what
/// it says. Both are pure, so the checks can pin them without a display.

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface IslandDisplay {
  id: number;
  /** Global top-left origin and size, in points (CG space, y down). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The camera housing, from buddyd: global x, width, height. */
  notch: { x: number; width: number; height: number } | null;
  menuBarHeight: number;
  builtIn: boolean;
  isMain: boolean;
}

/** The window is fixed-size and transparent; the island is drawn inside it and
 *  grows within it. Fixed, because resizing a window per frame of a spring
 *  animation is jank the OS will not hide. */
export const ISLAND_WINDOW = { width: 560, height: 190 } as const;

export interface IslandPlacement {
  displayId: number;
  /** The window's bounds, global points. */
  window: { x: number; y: number; width: number; height: number };
  /** The notch inside the window's own coordinates — the shape the island's
   *  resting state matches exactly — or, on a display without one, a virtual
   *  notch just under the menu bar. */
  notch: { x: number; width: number; height: number; top: number };
  /** Whether that notch is a real one. A virtual one is drawn as a pill with
   *  a visible edge, since there is no hardware for black to blend into. */
  real: boolean;
}

/**
 * Where the island goes.
 *
 * `notch` (the default) prefers a display that has one, and falls back to the
 * main display; `main` always uses the main display. On a Mac with the lid
 * open beside two monitors, the notch is the right home — it is the one place
 * status can sit without covering anything — but someone who works entirely on
 * the external screen would never look down at it, which is what `main` is for.
 */
export function placeIsland(displays: IslandDisplay[], prefer: 'notch' | 'main'): IslandPlacement | null {
  if (!displays.length) return null;
  // The primary display — the one at the origin of the global space, which
  // carries the menu bar — rather than AppKit's "main", which follows
  // whichever window happens to be key.
  const main = displays.find((d) => d.x === 0 && d.y === 0) ?? displays.find((d) => d.isMain) ?? displays[0]!;
  const notched = displays.find((d) => d.notch);
  const d = prefer === 'notch' && notched ? notched : main;
  const w = ISLAND_WINDOW.width;
  const h = ISLAND_WINDOW.height;

  if (d.notch) {
    const centre = d.notch.x + d.notch.width / 2;
    const x = Math.round(centre - w / 2);
    return {
      displayId: d.id,
      window: { x, y: d.y, width: w, height: h },
      notch: { x: Math.round(d.notch.x - x), width: Math.round(d.notch.width), height: Math.round(d.notch.height), top: 0 },
      real: true,
    };
  }
  // No notch: a virtual one, centred, tucked just under the menu bar so it
  // never covers a menu.
  const vw = 180;
  const vh = 30;
  const x = Math.round(d.x + d.width / 2 - w / 2);
  const top = Math.max(0, Math.round(d.menuBarHeight)) + 6;
  return {
    displayId: d.id,
    window: { x, y: d.y, width: w, height: h },
    notch: { x: Math.round(w / 2 - vw / 2), width: vw, height: vh, top },
    real: false,
  };
}

// ── What it says ─────────────────────────────────────────────────────────────

/**
 * - `rest`     nothing to say: exactly the notch, black on black.
 * - `compact`  something is going on that needs no reading — a wing either side
 *              of the notch: a mark, and a number.
 * - `expanded` something worth a sentence: grows down out of the notch.
 */
export type IslandSize = 'rest' | 'compact' | 'expanded';

export type IslandMode =
  | 'idle'
  | 'reading'
  | 'acting'
  | 'gated'
  | 'waiting'
  | 'done'
  | 'needs'
  | 'notice';

export type IslandTone = 'neutral' | 'go' | 'warn' | 'bad';

export interface IslandModel {
  mode: IslandMode;
  size: IslandSize;
  tone: IslandTone;
  /** The headline: the goal, the question, the outcome. */
  title: string;
  /** The line under it: the step in progress, the reason, the condition. */
  detail: string;
  /** The right wing in compact form: "12/60", "3", "✓". */
  badge: string;
  /** 0–1, for the thin progress line under an expanded island. */
  progress: number | null;
  handsOff: boolean;
  /** Which run this is about, so a dismissal can be remembered per run. */
  runId: number | null;
  /** When an expanded moment should fold back. Null means "until dealt with". */
  until: number | null;
}

/** A notice from elsewhere in buddy — a "welcome back", an offer — that
 *  borrows the island when nothing more urgent is using it. */
export interface IslandNotice {
  id: string;
  title: string;
  detail: string;
  tone: IslandTone;
  /** What clicking it does, by name; the island asks main to do it. */
  action: string | null;
  actionLabel: string | null;
  expiresAt: number;
}

export interface IslandInput {
  state: AppState;
  run: RunView | null;
  inference: InferenceState | null;
  wakeups: WakeupView[];
  /** The newest step, already in words (`describeStep`). */
  stepText: string | null;
  /** Runs whose ending the person has already dismissed from the island. */
  dismissed: Set<number>;
  /** Whether the pointer is over the island: a compact island opens on hover. */
  hovered: boolean;
  notice: IslandNotice | null;
  now: number;
}

const REST: Omit<IslandModel, 'mode'> = {
  size: 'rest',
  tone: 'neutral',
  title: '',
  detail: '',
  badge: '',
  progress: null,
  handsOff: false,
  runId: null,
  until: null,
};

/** How long a finished run's outcome stays open before folding back. */
export const DONE_LINGER_MS = 6_000;
/** How long a step stays expanded before the island settles to compact. A
 *  run of forty steps should not hold a sentence open over the menu bar for
 *  ten minutes; each new step gets a moment, then the wings. */
export const STEP_LINGER_MS = 2_600;

/**
 * What the island shows, in priority order: a question waiting on the person
 * beats everything; then a live run; then a run that just ended; then a
 * reading in progress; then a notice; then standby. Nothing at all is `rest`.
 */
export function islandModel(i: IslandInput): IslandModel {
  const r = i.run;
  const open = (size: IslandSize): IslandSize => (i.hovered && size === 'compact' ? 'expanded' : size);

  if (r && r.status === 'gated' && r.gate) {
    return {
      ...REST,
      mode: 'gated',
      size: 'expanded',
      tone: 'warn',
      title: 'buddy is asking first',
      detail: r.gate.verdict.reason,
      badge: '?',
      progress: r.usage.steps / Math.max(1, r.budgets.maxSteps),
      handsOff: r.handsOff,
      runId: r.id,
      until: null,
    };
  }

  if (r && r.status === 'running') {
    const last = r.steps[r.steps.length - 1];
    const fresh = !!last && i.now - last.ts < STEP_LINGER_MS;
    return {
      ...REST,
      mode: 'acting',
      size: open(fresh ? 'expanded' : 'compact'),
      tone: 'go',
      title: r.goal,
      detail: i.stepText ?? 'Taking a first look…',
      badge: `${r.usage.steps}/${r.budgets.maxSteps}`,
      progress: r.usage.steps / Math.max(1, r.budgets.maxSteps),
      handsOff: r.handsOff,
      runId: r.id,
      until: fresh ? last!.ts + STEP_LINGER_MS : null,
    };
  }

  if (r && r.endedAt && !i.dismissed.has(r.id)) {
    const summary = r.haltReason ?? r.outcome?.summary ?? 'The run ended.';
    if (r.status === 'needs_human') {
      // Stays until it is seen. A run that stopped for a person and then
      // folded itself away would be the one ending nobody notices.
      return {
        ...REST,
        mode: 'needs',
        size: open('compact'),
        tone: 'bad',
        title: 'buddy needs you',
        detail: summary,
        badge: '!',
        handsOff: r.handsOff,
        runId: r.id,
      };
    }
    if (r.status === 'done' && i.now - r.endedAt < DONE_LINGER_MS) {
      return {
        ...REST,
        mode: 'done',
        size: 'expanded',
        tone: 'go',
        title: 'Done',
        detail: summary,
        badge: '✓',
        handsOff: r.handsOff,
        runId: r.id,
        until: r.endedAt + DONE_LINGER_MS,
      };
    }
  }

  if (i.state === 'ARMED' && i.inference && i.inference.phase === 'provisional') {
    return {
      ...REST,
      mode: 'reading',
      size: 'compact',
      tone: 'neutral',
      title: 'Reading your screen…',
      detail: i.inference.goal ?? '',
      badge: '…',
    };
  }

  if (i.notice && i.notice.expiresAt > i.now) {
    return {
      ...REST,
      mode: 'notice',
      size: 'expanded',
      tone: i.notice.tone,
      title: i.notice.title,
      detail: i.notice.detail,
      badge: '•',
      until: i.notice.expiresAt,
    };
  }

  const waiting = i.wakeups.filter((w) => w.runStatus === 'waiting');
  if (waiting.length) {
    const next = [...waiting].sort((a, b) => a.fireAt - b.fireAt)[0]!;
    const mins = Math.max(0, Math.round((next.fireAt - i.now) / 60_000));
    return {
      ...REST,
      mode: 'waiting',
      size: open('compact'),
      tone: 'warn',
      title: waiting.length === 1 ? 'Waiting' : `Waiting on ${waiting.length} things`,
      detail: `${next.condition} · next look ${mins <= 0 ? 'now' : `in ${mins} min`}`,
      badge: String(waiting.length),
      runId: next.runId,
    };
  }

  return { ...REST, mode: 'idle' };
}

/** How big the island is drawn, in window points, for a size. The notch is
 *  the floor: at rest the island *is* the notch. */
export function islandShape(
  size: IslandSize,
  notch: { width: number; height: number },
): { width: number; height: number; radius: number } {
  switch (size) {
    case 'rest':
      return { width: notch.width, height: notch.height, radius: Math.min(12, notch.height / 2.4) };
    case 'compact':
      return { width: notch.width + 2 * 52, height: notch.height, radius: notch.height / 2 };
    case 'expanded':
      return { width: Math.max(notch.width + 2 * 150, 420), height: notch.height + 76, radius: 26 };
  }
}
