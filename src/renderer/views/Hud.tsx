import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, useBuddy } from '../useBuddy.js';
import { spring, useMotionSafe } from '../components/primitives.js';

/// The HUD (PRD §8.1). M1's job is the shell: it springs in on the hotkey,
/// dismisses on Esc, and shows honest state. Goal inference fills the middle at
/// M3 — the provisional-goal slot is already here and already load-bearing,
/// because §6.1 measures inference at a median of 8.6 s and the HUD must never
/// be a blank stare.

export function Hud() {
  const { state, stats, permissions, sidecar, keepRate } = useBuddy();
  const [visible, setVisible] = useState(true);
  const safe = useMotionSafe();

  useEffect(() => {
    const offShow = api.onHudShown(() => setVisible(true));
    const offHide = api.onHudHidden(() => setVisible(false));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setVisible(false);
        void api.hideHud();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offShow();
      offHide();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const blocked = permissions && !permissions.screenRecording;
  const observing = state === 'OBSERVING' || state === 'ARMED';

  return (
    <div className="flex h-full w-full items-start justify-center p-3">
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={safe ? { opacity: 0, y: -14, scale: 0.965 } : { opacity: 1 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={safe ? { opacity: 0, y: -8, scale: 0.985 } : { opacity: 0 }}
            transition={safe ? spring : { duration: 0 }}
            className="drag-region w-full overflow-hidden rounded-2xl border border-white/10
                       bg-ink-900/55 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
          >
            <header className="flex items-center justify-between border-b border-white/5 px-5 py-3">
              <div className="flex items-center gap-2.5">
                <Mark />
                <span className="text-[13px] font-medium tracking-tight text-fog-100">buddy</span>
                <span className="rounded-md bg-ink-700/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fog-300">
                  {state.toLowerCase().replace('_', ' ')}
                </span>
              </div>
              <kbd className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-fog-500">
                esc
              </kbd>
            </header>

            <div className="px-5 py-5">
              {blocked ? (
                <Blocked />
              ) : (
                <>
                  <p className="text-[10px] uppercase tracking-[0.1em] text-fog-500">
                    Provisional goal
                  </p>
                  <h1 className="mt-2 text-[19px] leading-snug font-light tracking-tight text-fog-100">
                    {observing
                      ? 'Watching. Nothing to resume yet.'
                      : 'Not observing — grant Screen Recording to begin.'}
                  </h1>
                  <p className="mt-2.5 text-[12px] leading-relaxed text-fog-500">
                    Goal inference lands at M3. Until then this is the shell: the hotkey opens
                    it, <span className="font-mono text-fog-300">esc</span> closes it, and the
                    numbers below are live.
                  </p>
                </>
              )}
            </div>

            <footer className="flex items-center justify-between gap-4 border-t border-white/5 bg-black/15 px-5 py-3">
              <div className="flex items-center gap-5 font-mono text-[11px] tabular-nums text-fog-500">
                <span>
                  <span className="text-fog-100">{stats?.kept ?? 0}</span> kept
                </span>
                <span>
                  <span className="text-fog-100">{stats?.considered ?? 0}</span> seen
                </span>
                <span>
                  <span className="text-ember-300">
                    {keepRate == null ? '—' : `${Math.round(keepRate * 100)}%`}
                  </span>{' '}
                  keep rate
                </span>
              </div>
              <button
                onClick={() => void api.openHome()}
                className="no-drag text-[11px] text-fog-500 transition-colors hover:text-fog-100"
              >
                {sidecar?.running ? 'Open buddy' : 'buddyd down — open buddy'}
              </button>
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Blocked() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[19px] leading-snug font-light tracking-tight text-fog-100">
        buddy cannot see the screen.
      </h1>
      <p className="text-[12px] leading-relaxed text-fog-500">
        Screen Recording has not been granted. Nothing is being captured.
      </p>
      <button
        onClick={() => void api.openHome()}
        className="no-drag mt-1 w-fit rounded-lg bg-ember-500 px-3 py-1.5 text-[12px]
                   font-medium text-ink-950 transition-colors hover:bg-ember-400"
      >
        Fix this
      </button>
    </div>
  );
}

function Mark() {
  const safe = useMotionSafe();
  return (
    <motion.span
      className="block h-[9px] w-[9px] rounded-[3px] bg-ember-500"
      animate={safe ? { rotate: [0, 90, 90, 0], borderRadius: ['3px', '9px', '3px', '3px'] } : {}}
      transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut', times: [0, 0.25, 0.5, 1] }}
    />
  );
}
