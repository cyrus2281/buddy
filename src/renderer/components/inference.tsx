import React from 'react';
import { motion } from 'framer-motion';
import { spring, useMotionSafe } from './primitives.js';
import type { GoalReading, InferenceState } from '../../shared/types.js';

/// The pieces of the ARMED panel that show what buddy worked out (PRD §8.1).
///
/// The design constraint is a measured one: the reading arrives 8.6 s after the
/// hotkey on the median case and up to 22 s on an ambiguous one (§6.7). So
/// every component here has to look deliberate while holding a provisional
/// value, and has to change in place rather than replacing the panel — a layout
/// that jumps at second nine reads as a bug, not as an update.

/** Risk flags, in the user's words rather than the schema's. */
const RISK_COPY: Record<string, string> = {
  sends_message: 'sends a message',
  sends_email: 'sends email',
  posts_public: 'posts publicly',
  purchase: 'spends money',
  credentials: 'touches credentials',
  deletes_data: 'deletes data',
  installs_software: 'installs software',
  system_settings: 'changes system settings',
  external_api_write: 'writes to an external API',
  irreversible_other: 'does something irreversible',
};

export function GoalLine({ state }: { state: InferenceState }) {
  const safe = useMotionSafe();
  const provisional = state.phase === 'provisional';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.1em] text-fog-500">
          {provisional ? 'Picking up where you left off' : 'Goal'}
        </p>
        {provisional && <Reading />}
        {state.phase === 'ready' && state.reading && <Confidence value={state.reading.confidence} />}
      </div>
      <motion.h1
        key={state.goal ?? 'none'}
        initial={safe ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={safe ? spring : { duration: 0 }}
        className={`mt-1.5 text-[17px] leading-snug font-light tracking-tight ${
          provisional ? 'text-fog-300' : 'text-fog-100'
        }`}
      >
        {state.goal ?? 'buddy has not seen enough yet to guess.'}
      </motion.h1>
    </div>
  );
}

/** The only honest thing to show during an 8-second wait: that it is working,
 *  and that what is on screen right now is a guess. */
function Reading() {
  const safe = useMotionSafe();
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-fog-500">
      <motion.span
        className="block h-1 w-1 rounded-full bg-ember-500"
        animate={safe ? { opacity: [0.25, 1, 0.25] } : {}}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
      />
      reading the screen…
    </span>
  );
}

function Confidence({ value }: { value: number }) {
  const low = value < 0.5;
  return (
    <span
      className={`shrink-0 font-mono text-[10px] tabular-nums ${low ? 'text-ember-400' : 'text-fog-500'}`}
      title={
        low
          ? 'Below 0.5, buddy asks instead of acting.'
          : 'How sure buddy is that this is what you were doing.'
      }
    >
      {Math.round(value * 100)}% sure
    </span>
  );
}

/** §6.1: the user reads these in about a second to judge whether buddy
 *  understood them. That is the entire job, so they are quotable and short. */
export function Evidence({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Because</p>
      <ul className="flex flex-col gap-1">
        {items.slice(0, 4).map((e, i) => (
          <li key={i} className="flex gap-2 text-[11px] leading-snug text-fog-300">
            <span className="mt-[5px] block h-1 w-1 shrink-0 rounded-full bg-fog-500" />
            <span>{e}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** §6.1: `already_done` is what makes "continue" mean continue. Showing it is
 *  also the fastest way for a user to catch buddy about to redo something. */
export function AlreadyDone({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="rounded-xl border border-moss-400/25 bg-moss-400/5 px-3.5 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.09em] text-moss-400">Already done — buddy will not redo</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {items.slice(0, 4).map((d, i) => (
          <li key={i} className="text-[11px] leading-snug text-fog-300">
            {d}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RiskFlags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">May</span>
      {flags.map((f) => (
        <span
          key={f}
          className="rounded-md border border-ember-500/40 bg-ember-500/10 px-1.5 py-0.5 text-[10px] text-ember-300"
        >
          {RISK_COPY[f] ?? f.replace(/_/g, ' ')}
        </span>
      ))}
    </div>
  );
}

/**
 * §7.4, surfaced. Non-null means on-screen text tried to instruct the model.
 *
 * It gets a whole panel rather than a chip because the fact that matters is not
 * that something was found — it is that it changed nothing, and a user who does
 * not know that will assume the worst about the goal underneath it.
 */
export function InjectionNotice({ quote }: { quote: string }) {
  return (
    <div className="rounded-xl border border-rust-400/40 bg-rust-400/10 px-3.5 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.09em] text-rust-400">
        Something on screen tried to give buddy instructions
      </p>
      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-fog-300">
        “{quote.length > 220 ? `${quote.slice(0, 220)}…` : quote}”
      </p>
      <p className="mt-1.5 text-[10px] leading-relaxed text-fog-500">
        It was ignored. Screen text is treated as data, never as instruction, and it cannot change the
        goal, the profile, the risk flags, or what buddy is allowed to touch.
      </p>
    </div>
  );
}

/** Below 0.5 confidence buddy asks rather than acting (§6.1 step 6). The
 *  alternatives become the question. */
export function Alternatives({
  reading,
  onPick,
}: {
  reading: GoalReading;
  onPick: (goal: string) => void;
}) {
  const options = [
    { goal: reading.goal, confidence: reading.confidence },
    ...reading.alternatives,
  ].slice(0, 3);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-ember-300">
        buddy is not sure enough to just go. Which of these did you mean?
      </p>
      {options.map((a, i) => (
        <button
          key={i}
          onClick={() => onPick(a.goal)}
          className="rounded-xl border border-ink-700 bg-ink-850/50 px-3.5 py-2.5 text-left
                     transition-colors hover:border-ember-500/50 hover:bg-ember-500/5"
        >
          <span className="flex items-baseline gap-2">
            <kbd className="shrink-0 rounded border border-white/10 px-1 font-mono text-[10px] text-fog-500">
              {i + 1}
            </kbd>
            <span className="text-[12px] leading-snug text-fog-100">{a.goal}</span>
          </span>
        </button>
      ))}
      <p className="text-[10px] text-fog-500">Or type what you actually want finished.</p>
    </div>
  );
}
