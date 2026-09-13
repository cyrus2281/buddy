import React, { useSyncExternalStore } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/// Small shared pieces. Every animated one asks `useMotionSafe` rather than
/// relying on the CSS media query alone, because Framer drives transforms in JS
/// and CSS cannot reach them (PRD §8).

export const spring = { type: 'spring' as const, stiffness: 420, damping: 32, mass: 0.9 };

/// **Two sources, one answer.**
///
/// `prefers-reduced-motion` is the system's, and Settings' "Force reduced
/// motion" is the user's. Until M4 only the App shell consulted the second one,
/// so turning the switch on quieted the tab transition and left every spring in
/// the HUD, the note list and the run feed animating exactly as before — which
/// is a worse result than not offering the switch, because the user has been
/// told motion is off and can see that it is not.
///
/// A module-level flag rather than a context: the setting arrives on an IPC
/// push in the main tree and in the HUD's separate renderer, and threading a
/// provider through both for one boolean buys nothing. `useSyncExternalStore`
/// is what makes a module-level value a legitimate React source.

let forcedReducedMotion = false;
const listeners = new Set<() => void>();

/** Called by `useBuddy` whenever settings change, in every renderer. */
export function setForcedReducedMotion(v: boolean) {
  if (v === forcedReducedMotion) return;
  forcedReducedMotion = v;
  for (const l of listeners) l();
}

function subscribeMotion(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useMotionSafe() {
  const systemReduced = useReducedMotion();
  const forced = useSyncExternalStore(
    subscribeMotion,
    () => forcedReducedMotion,
    () => false,
  );
  return !systemReduced && !forced;
}

export function Card({
  children,
  className = '',
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-xl border border-ink-700/70 bg-ink-850/60 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = 'default',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'accent' | 'ghost' | 'danger' }) {
  const styles = {
    default: 'bg-ink-700 hover:bg-ink-600 text-fog-100 border-ink-600',
    accent: 'bg-ember-500 hover:bg-ember-400 text-ink-950 border-ember-400 font-medium',
    ghost: 'bg-transparent hover:bg-ink-800 text-fog-300 border-transparent',
    danger: 'bg-transparent hover:bg-rust-400/15 text-rust-400 border-rust-400/40',
  }[variant];
  return (
    <button
      className={`no-drag inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5
                  text-[12px] transition-colors duration-150 disabled:cursor-not-allowed
                  disabled:opacity-40 ${styles} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Red / amber / green, with a text label beside it. A coloured dot alone is
 *  not a status; people who cannot distinguish the hues get nothing from it. */
export function StatusDot({ ok, warn = false }: { ok: boolean; warn?: boolean }) {
  const color = ok ? 'bg-moss-400' : warn ? 'bg-ember-400' : 'bg-rust-400';
  const safe = useMotionSafe();
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {ok && safe && (
        <motion.span
          className="absolute inset-0 rounded-full bg-moss-400"
          animate={{ opacity: [0.5, 0, 0.5], scale: [1, 2.2, 1] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-fog-100">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-fog-500">{hint}</span>}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <span className="no-drag inline-flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-28 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px]
                   text-fog-100 outline-none focus:border-ember-500/70"
      />
      {suffix && <span className="text-[11px] text-fog-500">{suffix}</span>}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  const safe = useMotionSafe();
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`no-drag relative h-[20px] w-[34px] shrink-0 rounded-full border transition-colors
                  duration-200 ${checked ? 'border-ember-400 bg-ember-500/80' : 'border-ink-600 bg-ink-700'}`}
    >
      <motion.span
        className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-fog-100"
        animate={{ left: checked ? 17 : 3 }}
        transition={safe ? spring : { duration: 0 }}
      />
    </button>
  );
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">{label}</span>
      <span className="font-mono text-[17px] leading-tight text-fog-100 tabular-nums">{value}</span>
      {sub && <span className="text-[11px] text-fog-500">{sub}</span>}
    </div>
  );
}
