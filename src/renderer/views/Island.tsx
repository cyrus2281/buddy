import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { setForcedReducedMotion, useMotionSafe } from '../components/primitives.js';
import { describeStep } from '../components/run.js';
import {
  islandModel,
  islandShape,
  type IslandModel,
  type IslandNotice,
  type IslandPlacement,
  type IslandTone,
} from '../../shared/island.js';
import type { AppState, InferenceState, RunView, WakeupView } from '../../shared/types.js';

/// The island (see `shared/island.ts` for what it says and why it lives in the
/// notch). This file is only the drawing: a black shape that is exactly the
/// notch at rest, grows wings when something is going on, and drops down out
/// of the notch when there is a sentence worth reading.
///
/// The window it lives in is transparent and click-through everywhere except
/// the shape, and only while the pointer is over it — so the menu bar either
/// side of it keeps working, and the island can be hovered and clicked.

// Spelled out in full: Tailwind generates only class names it can find
// literally in the source, so a class assembled at runtime would be missing.
const TONE: Record<IslandTone, { mark: string; ring: string; text: string; line: string }> = {
  neutral: { mark: 'bg-fog-300', ring: 'border-fog-300', text: 'text-fog-300', line: 'bg-fog-300/70' },
  go: { mark: 'bg-moss-400', ring: 'border-moss-400', text: 'text-moss-400', line: 'bg-moss-400' },
  warn: { mark: 'bg-ember-400', ring: 'border-ember-400', text: 'text-ember-300', line: 'bg-ember-400' },
  bad: { mark: 'bg-rust-400', ring: 'border-rust-400', text: 'text-rust-400', line: 'bg-rust-400' },
};

/** The slice of buddy the island needs. Lighter than `useBuddy`, which also
 *  loads frames and logs — this window is open all day and needs neither. */
function useIslandData() {
  const [state, setState] = useState<AppState>('IDLE');
  const [run, setRun] = useState<RunView | null>(null);
  const [inference, setInference] = useState<InferenceState | null>(null);
  const [wakeups, setWakeups] = useState<WakeupView[]>([]);
  const [placement, setPlacement] = useState<IslandPlacement | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);

  useEffect(() => {
    void api.getIsland().then((i) => {
      setPlacement(i.placement);
      setNotice(i.notice);
    });
    void api.getSnapshot().then((s) => {
      setState(s.state);
      setRun(s.activeRun);
      setInference(s.inference);
      setWakeups(s.wakeups);
      setForcedReducedMotion(s.settings.reducedMotion);
    });
    const off = [
      api.onState(setState),
      api.onRun(setRun),
      api.onInference(setInference),
      api.onWakeups(setWakeups),
      api.onSettings((s) => setForcedReducedMotion(s.reducedMotion)),
      api.onIslandPlacement(setPlacement),
      api.onIslandNotice(setNotice),
    ];
    return () => off.forEach((f) => f());
  }, []);

  return { state, run, inference, wakeups, placement, notice };
}

export function IslandView() {
  const { state, run, inference, wakeups, placement, notice } = useIslandData();
  const [hovered, setHovered] = useState(false);
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const safe = useMotionSafe();

  // Lingers are timed against the clock, so the clock has to move; twice a
  // second is enough for a fold-back nobody times with a stopwatch.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const last = run?.steps[run.steps.length - 1] ?? null;
  const model: IslandModel = useMemo(
    () =>
      islandModel({
        state,
        run,
        inference,
        wakeups,
        stepText: last ? describeStep(last) : null,
        dismissed,
        hovered,
        notice,
        now,
      }),
    [state, run, inference, wakeups, last, dismissed, hovered, notice, now],
  );

  if (!placement) return null;
  const notch = placement.notch;
  const shape = islandShape(model.size, notch);
  const tone = TONE[model.tone];
  const centre = notch.x + notch.width / 2;
  const wing = (shape.width - notch.width) / 2;
  const enter = () => {
    setHovered(true);
    void api.setIslandInteractive(true);
  };
  const leave = () => {
    setHovered(false);
    void api.setIslandInteractive(false);
  };
  const dismiss = () => {
    if (model.runId != null) setDismissed((d) => new Set(d).add(model.runId!));
    if (model.mode === 'notice') void api.islandAction('dismiss-notice');
    leave();
  };

  return (
    <div className="pointer-events-none fixed inset-0">
      <motion.div
        onMouseEnter={enter}
        onMouseLeave={leave}
        initial={false}
        animate={{
          width: shape.width,
          height: shape.height,
          x: centre - shape.width / 2,
          opacity: model.size === 'rest' && !placement.real ? 0 : 1,
        }}
        transition={safe ? { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 } : { duration: 0 }}
        style={{
          top: notch.top,
          // A real notch is square-topped against the bezel; only the bottom
          // corners round. A virtual one is a free-standing pill.
          borderRadius: placement.real ? `0 0 ${shape.radius}px ${shape.radius}px` : shape.radius,
        }}
        className={`pointer-events-auto absolute left-0 overflow-hidden bg-black ${
          placement.real ? '' : 'border border-white/10 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)]'
        }`}
      >
        {/* The wings: either side of the camera, at the menu bar's height. */}
        <AnimatePresence>
          {model.size !== 'rest' && (
            <motion.div
              key="wings"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: safe ? 0.18 : 0 }}
              className="absolute inset-x-0 top-0 flex items-center justify-between px-3"
              style={{ height: notch.height }}
            >
              <span className="flex items-center gap-1.5" style={{ width: wing - 12 }}>
                <IslandMark
                  tone={model.tone}
                  busy={model.mode === 'acting' || model.mode === 'reading'}
                  hollow={model.handsOff}
                />
              </span>
              <span
                className={`truncate text-right font-mono text-[11px] tabular-nums ${tone.text}`}
                style={{ width: wing - 12 }}
              >
                {model.badge}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* The sentence, below the notch. */}
        <AnimatePresence>
          {model.size === 'expanded' && (
            <motion.div
              key="body"
              initial={safe ? { opacity: 0, y: -6 } : { opacity: 1 }}
              animate={{ opacity: 1, y: 0 }}
              exit={safe ? { opacity: 0, y: -4 } : { opacity: 0 }}
              transition={{ duration: safe ? 0.2 : 0, delay: safe ? 0.06 : 0 }}
              className="absolute inset-x-0 flex flex-col gap-1 px-5"
              style={{ top: notch.height + 6 }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className={`truncate text-[12.5px] font-medium ${model.mode === 'acting' ? 'text-fog-100' : tone.text}`}>
                    {model.title}
                  </span>
                  {model.handsOff && (
                    <span className="shrink-0 rounded-full border border-white/15 px-1.5 font-mono text-[9px] uppercase tracking-wider text-fog-500">
                      hands-off
                    </span>
                  )}
                </span>
                <IslandButtons model={model} notice={notice} hovered={hovered} onDismiss={dismiss} />
              </div>
              <span className="line-clamp-2 text-[11.5px] leading-snug text-fog-300">{model.detail}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {model.size === 'expanded' && model.progress != null && (
          <div className="absolute inset-x-5 bottom-2.5 h-[2px] overflow-hidden rounded-full bg-white/10">
            <motion.div
              className={`h-full ${tone.line}`}
              initial={false}
              animate={{ width: `${Math.min(100, Math.round(model.progress * 100))}%` }}
              transition={{ duration: safe ? 0.4 : 0 }}
            />
          </div>
        )}
      </motion.div>
    </div>
  );
}

function IslandButtons({
  model,
  notice,
  hovered,
  onDismiss,
}: {
  model: IslandModel;
  notice: IslandNotice | null;
  hovered: boolean;
  onDismiss: () => void;
}) {
  const btn = 'no-drag rounded-full px-2.5 py-0.5 text-[10.5px] font-medium transition-colors';
  switch (model.mode) {
    case 'acting':
      return hovered ? (
        <button onClick={() => void api.stopRun()} className={`${btn} bg-rust-400/20 text-rust-400 hover:bg-rust-400/30`}>
          Stop
        </button>
      ) : null;
    case 'gated':
      return (
        <button onClick={() => void api.showHud()} className={`${btn} bg-ember-500 text-ink-950 hover:bg-ember-400`}>
          Review
        </button>
      );
    case 'needs':
      return (
        <span className="flex shrink-0 gap-1.5">
          <button onClick={() => void api.showHud()} className={`${btn} bg-white/10 text-fog-100 hover:bg-white/20`}>
            Open
          </button>
          <button onClick={onDismiss} className={`${btn} text-fog-500 hover:text-fog-100`}>
            Dismiss
          </button>
        </span>
      );
    case 'notice':
      return (
        <span className="flex shrink-0 gap-1.5">
          {notice?.action && (
            <button
              onClick={() => void api.islandAction(notice.action!)}
              className={`${btn} bg-moss-400 text-ink-950 hover:bg-moss-400/90`}
            >
              {notice.actionLabel ?? 'Go'}
            </button>
          )}
          <button onClick={onDismiss} className={`${btn} text-fog-500 hover:text-fog-100`}>
            Not now
          </button>
        </span>
      );
    default:
      return null;
  }
}

/** The same mark as the HUD's, so the two read as one product: a square that
 *  breathes while buddy works. Hollow for a hands-off run — buddy is there,
 *  but not in the person's way — since a word does not fit in a wing. */
function IslandMark({ tone, busy, hollow = false }: { tone: IslandTone; busy: boolean; hollow?: boolean }) {
  const safe = useMotionSafe();
  return (
    <motion.span
      className={`block h-[9px] w-[9px] shrink-0 rounded-[3px] ${
        hollow ? `border-[1.5px] ${TONE[tone].ring}` : TONE[tone].mark
      }`}
      animate={safe && busy ? { scale: [1, 1.35, 1], opacity: [1, 0.55, 1] } : { scale: 1, opacity: 1 }}
      transition={busy ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
    />
  );
}
