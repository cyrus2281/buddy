import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { setForcedReducedMotion, useMotionSafe } from '../components/primitives.js';
import type { GhostIntent } from '../../shared/types.js';

/// The ghost cursor: where buddy is about to click, a moment before it does.
///
/// A shared-hands run moves the real pointer, and without a preview that is
/// all a person sees — the cursor teleporting and something happening. The
/// ghost glides there first, names what it is aiming at, and ripples as the
/// real click lands, so a run can be *followed* rather than only watched. A
/// gate holds it over the thing being asked about.
///
/// The window is full-screen, transparent, never interactive, and left out of
/// buddy's own screenshots — the ghost is for the person, not the model.

/** How long the ghost stays after the last intent before fading. */
const LINGER_MS = 2200;

const KEY_GLYPH: Record<string, string> = {
  cmd: '⌘',
  command: '⌘',
  super: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  return: '↩',
  enter: '↩',
  tab: '⇥',
  escape: 'esc',
  esc: 'esc',
  backspace: '⌫',
  delete: '⌫',
  space: 'space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

/** "cmd+shift+k" → "⌘⇧K". */
export function prettyKeys(combo: string): string {
  return combo
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => KEY_GLYPH[t.toLowerCase()] ?? (t.length === 1 ? t.toUpperCase() : t))
    .join('');
}

export function GhostView() {
  const [intent, setIntent] = useState<GhostIntent | null>(null);
  const [visible, setVisible] = useState(false);
  /** Bumped when a click lands, so the ripple replays even on the same spot. */
  const [landed, setLanded] = useState(0);
  const timers = useRef<number[]>([]);
  const safe = useMotionSafe();

  useEffect(() => {
    void api.getSnapshot().then((s) => setForcedReducedMotion(s.settings.reducedMotion));
    return api.onIntent((i) => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
      setIntent(i);
      setVisible(true);
      if (i.kind === 'click' || i.kind === 'double' || i.kind === 'right') {
        timers.current.push(window.setTimeout(() => setLanded((n) => n + 1), i.leadMs));
      }
      // A pending gate holds until the next intent; everything else fades.
      if (i.kind !== 'pending') {
        timers.current.push(window.setTimeout(() => setVisible(false), i.leadMs + LINGER_MS));
      }
    });
  }, []);

  const glide = safe ? { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.7 } : { duration: 0 };

  return (
    <div className="pointer-events-none fixed inset-0">
      <AnimatePresence>
        {visible && intent && (
          <motion.div
            key="ghost"
            className="absolute left-0 top-0"
            initial={{ opacity: 0, x: intent.x, y: intent.y }}
            animate={{ opacity: 1, x: intent.x, y: intent.y }}
            exit={{ opacity: 0 }}
            transition={{ ...glide, opacity: { duration: safe ? 0.25 : 0 } }}
          >
            {intent.kind === 'drag' && intent.to && <DragPath from={intent} to={intent.to} />}
            {intent.kind === 'pending' && <PendingRing />}
            <Ripple key={landed} show={landed > 0} />
            <Pointer tone={intent.kind === 'pending' ? 'warn' : 'go'} />
            <Chip intent={intent} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Pointer({ tone }: { tone: 'go' | 'warn' }) {
  const fill = tone === 'warn' ? '#ff9f5a' : '#f97316';
  return (
    <svg
      width="26"
      height="30"
      viewBox="0 0 26 30"
      className="absolute -left-[3px] -top-[2px] drop-shadow-[0_4px_10px_rgba(249,115,22,0.55)]"
      aria-hidden
    >
      <path
        d="M3 2 L3 23 L8.6 18.2 L12.4 27 L16.2 25.4 L12.5 16.8 L20 16.4 Z"
        fill={fill}
        fillOpacity="0.92"
        stroke="white"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Ripple({ show }: { show: boolean }) {
  const safe = useMotionSafe();
  if (!show || !safe) return null;
  return (
    <motion.span
      className="absolute -left-5 -top-5 block h-10 w-10 rounded-full border-2 border-ember-400"
      initial={{ scale: 0.3, opacity: 0.9 }}
      animate={{ scale: 1.6, opacity: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
    />
  );
}

function PendingRing() {
  const safe = useMotionSafe();
  return (
    <motion.span
      className="absolute -left-6 -top-6 block h-12 w-12 rounded-full border-2 border-ember-400/80"
      animate={safe ? { scale: [1, 1.18, 1], opacity: [0.9, 0.4, 0.9] } : {}}
      transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

function DragPath({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <span
      className="absolute left-0 top-0 block h-0 origin-left border-t-2 border-dashed border-ember-400/80"
      style={{ width: len, transform: `rotate(${angle}deg)` }}
    />
  );
}

function Chip({ intent }: { intent: GhostIntent }) {
  const text =
    intent.kind === 'pending'
      ? `asking you first${intent.label ? ` — ${intent.label}` : ''}`
      : intent.kind === 'type'
        ? `typing “${intent.label}${intent.label.length >= 48 ? '…' : ''}”`
        : intent.kind === 'key'
          ? prettyKeys(intent.label)
          : intent.kind === 'scroll'
            ? 'scrolling'
            : intent.label;
  if (!text) return null;
  return (
    <span
      className={`absolute left-6 top-5 max-w-[320px] truncate whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] font-medium shadow-lg backdrop-blur ${
        intent.kind === 'pending'
          ? 'border-ember-400/60 bg-ink-950/85 text-ember-300'
          : intent.kind === 'key'
            ? 'border-white/20 bg-ink-950/85 font-mono text-fog-100'
            : 'border-ember-500/40 bg-ink-950/80 text-fog-100'
      }`}
    >
      {text}
    </span>
  );
}
