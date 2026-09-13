import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Button, Card, spring, useMotionSafe } from '../components/primitives.js';
import type { WakeupView } from '../../shared/types.js';

/// Standby, on screen (PRD §6.6, Story B).
///
/// The whole feature is invisible by construction: buddy is not doing anything,
/// the HUD is dismissed, and the only evidence is a row in SQLite. That is
/// exactly why it needs a surface — an assistant that says "I'll watch for
/// Priya's reply" and then shows nothing has made a promise the user cannot
/// check, and an unverifiable promise is worth about as much as no promise.
///
/// So each pending wakeup says four things, and each one answers a question a
/// person actually has: **what** it is watching for, **when** it next looks,
/// **how many looks are left**, and what happens when they run out. Plus the
/// two things they can do about it: make it look now, or stop waiting.

export function StandbyPanel({ wakeups }: { wakeups: WakeupView[] }) {
  const live = wakeups.filter((w) => w.runStatus === 'waiting');
  const safe = useMotionSafe();
  if (live.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium text-fog-100">
          Waiting on {live.length === 1 ? 'something' : `${live.length} things`}
        </h3>
        <button
          onClick={() => void api.checkWakeupsNow()}
          className="text-[11px] text-fog-500 transition-colors hover:text-fog-100"
        >
          Check now →
        </button>
      </div>
      <div className="flex flex-col gap-2.5">
        <AnimatePresence initial={false}>
          {live.map((w) => (
            <motion.div
              key={w.id}
              layout={safe}
              initial={safe ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={safe ? { opacity: 0, scale: 0.98 } : { opacity: 0 }}
              transition={safe ? spring : { duration: 0 }}
            >
              <WakeupCard wakeup={w} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <p className="text-[11px] leading-relaxed text-fog-500">
        Each check is one screenshot through a small model — a fraction of a cent — so buddy can
        afford to keep looking. It only wakes the Operator when the answer is yes. Quitting buddy
        does not cancel these; they are stored and picked back up on the next launch.
      </p>
    </section>
  );
}

function WakeupCard({ wakeup: w }: { wakeup: WakeupView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const left = w.fireAt - now;
  const remaining = w.maxAttempts - w.attempts;

  return (
    <Card className="flex flex-col gap-2.5 border-ember-500/30 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.09em] text-ember-400">watching for</p>
          <p className="mt-1 text-[13px] leading-snug text-fog-100">{w.condition}</p>
          <p className="mt-1.5 truncate text-[11px] text-fog-500">then: {w.goal}</p>
        </div>
        <span className="shrink-0 rounded-md border border-ember-500/40 bg-ember-500/10 px-1.5 py-0.5 font-mono text-[10px] text-ember-300">
          {left <= 0 ? 'checking…' : `in ${short(left)}`}
        </span>
      </div>

      {/* Attempts as a bar, because "8 of 12" is a number and "two thirds gone"
          is the thing the user is actually deciding about. */}
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-ember-500/70 transition-all duration-500"
            style={{ width: `${(w.attempts / Math.max(1, w.maxAttempts)) * 100}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-fog-500">
          {w.attempts}/{w.maxAttempts} looks
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/60 pt-2.5">
        <p className="text-[10px] leading-relaxed text-fog-500">
          Looks every {Math.round(w.intervalS / 60) || 1} min.{' '}
          {remaining <= 1
            ? 'One look left — after that it stops and asks you.'
            : `${remaining} looks left, then it stops and asks you.`}
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={() => void api.checkWakeupsNow()}>Check now</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm(`Stop waiting for "${w.condition}"?\n\nThe run log is kept.`)) {
                void api.cancelWakeup(w.id);
              }
            }}
          >
            Stop waiting
          </Button>
        </div>
      </div>
    </Card>
  );
}

function short(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
