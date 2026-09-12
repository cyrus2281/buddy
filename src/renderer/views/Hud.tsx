import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, useBuddy } from '../useBuddy.js';
import { spring, useMotionSafe } from '../components/primitives.js';
import { BudgetMeters, StepLine, describeStep } from '../components/run.js';
import type { PendingGate, RunProfile, RunView } from '../../shared/types.js';

/// The HUD (PRD §8.1) — the one screen that matters.
///
/// Four states, one window:
///
///   **ARMED**   the goal input, then a confirm panel naming the profile, the
///               allowlist, and the budgets. Enter runs, Esc cancels. There is
///               no auto-proceed countdown; confirmation is explicit.
///   **ACTING**  live step feed, three budget meters, a big Stop. Collapses to
///               a pill after three seconds so it stops covering the work.
///   **GATE**    slides over everything, naming the exact action and the element
///               it targets. Approve / Deny / Stop run.
///   **ENDED**   what it did, or why it stopped, with the log one click away.
///
/// M3 replaces the typed goal with inference; the confirm panel is already the
/// shape that will show it, which is why the profile and the allowlist are
/// confirmed in the same keystroke as the goal.

type Phase = 'goal' | 'confirm' | 'acting' | 'ended';

export function Hud() {
  const { state, permissions, snapshot, run, gate, hotkeyIssues } = useBuddy();
  const [visible, setVisible] = useState(true);
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState<RunProfile>('attended');
  const [phase, setPhase] = useState<Phase>('goal');
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const safe = useMotionSafe();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const running = run?.status === 'running' || run?.status === 'gated';
  const ended = !!run && ['done', 'waiting', 'needs_human', 'cancelled'].includes(run.status);

  // The run is the source of truth for the phase; the local one only covers the
  // stretch before a run exists.
  useEffect(() => {
    if (running) setPhase('acting');
    else if (ended) setPhase('ended');
  }, [running, ended]);

  useEffect(() => {
    const offShow = api.onHudShown(() => {
      setVisible(true);
      setCollapsed(false);
      if (!running && !ended) {
        setPhase('goal');
        void api.armHud();
        setTimeout(() => inputRef.current?.focus(), 60);
      }
    });
    const offHide = api.onHudHidden(() => setVisible(false));
    return () => {
      offShow();
      offHide();
    };
  }, [running, ended]);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  // §8.1: collapse to a pill three seconds in, so the HUD stops covering the
  // work it is doing. Hover or the hotkey brings it back.
  useEffect(() => {
    if (phase !== 'acting' || gate) {
      setCollapsed(false);
      return;
    }
    const t = setTimeout(() => setCollapsed(true), 3000);
    return () => clearTimeout(t);
  }, [phase, gate]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setGoal('');
    setPhase('goal');
    setError(null);
    void api.cancelArm();
    void api.hideHud();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase('acting');
    try {
      await api.startRun({
        goal,
        profile,
        allowlist: snapshot?.defaultAllowlist ?? { apps: [], domains: [] },
        budgets: snapshot?.defaultBudgets,
      });
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setPhase('confirm');
    }
  }, [goal, profile, snapshot]);

  // Esc is the universal out. During a run it stops rather than hides: hiding
  // the window would leave the agent driving with nothing on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (gate) {
        void api.resolveGate('deny');
        return;
      }
      if (running) {
        void api.stopRun();
        return;
      }
      if (phase === 'confirm') {
        setPhase('goal');
        setTimeout(() => inputRef.current?.focus(), 40);
        return;
      }
      dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gate, running, phase, dismiss]);

  // The window is sized to its content, so a pill is actually a pill.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => void api.hudResize(el.getBoundingClientRect().height + 24);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, collapsed, gate, run?.steps.length, error]);

  const blocked = permissions && (!permissions.screenRecording || !permissions.accessibility);

  return (
    <div className="flex h-full w-full items-start justify-center p-3">
      <AnimatePresence>
        {visible && (
          <motion.div
            ref={bodyRef}
            onMouseEnter={() => setCollapsed(false)}
            initial={safe ? { opacity: 0, y: -14, scale: 0.965 } : { opacity: 1 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={safe ? { opacity: 0, y: -8, scale: 0.985 } : { opacity: 0 }}
            transition={safe ? spring : { duration: 0 }}
            className="drag-region w-full overflow-hidden rounded-2xl border border-white/10
                       bg-ink-900/60 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
          >
            {collapsed && run ? (
              <Pill run={run} />
            ) : (
              <>
                <Header state={state} run={run} />
                <div className="px-5 py-4">
                  {blocked && phase !== 'acting' ? (
                    <Blocked
                      screen={!!permissions?.screenRecording}
                      accessibility={!!permissions?.accessibility}
                    />
                  ) : phase === 'goal' ? (
                    <GoalInput
                      ref={inputRef}
                      goal={goal}
                      setGoal={setGoal}
                      onSubmit={() => goal.trim() && setPhase('confirm')}
                    />
                  ) : phase === 'confirm' ? (
                    <Confirm
                      goal={goal}
                      profile={profile}
                      setProfile={setProfile}
                      apps={snapshot?.defaultAllowlist.apps ?? []}
                      budgets={snapshot?.defaultBudgets}
                      abortHotkey={
                        hotkeyIssues.find((h) => h.label === 'Abort run')?.accelerator ?? null
                      }
                      error={error}
                      onBack={() => {
                        setPhase('goal');
                        setTimeout(() => inputRef.current?.focus(), 40);
                      }}
                      onRun={() => void start()}
                    />
                  ) : phase === 'acting' ? (
                    <Acting run={run} />
                  ) : (
                    <Ended run={run} onClose={dismiss} />
                  )}
                </div>
              </>
            )}

            <AnimatePresence>{gate && <GateOverlay gate={gate} />}</AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function Header({ state, run }: { state: string; run: RunView | null }) {
  const label = run && run.status !== 'done' && run.status !== 'cancelled' ? run.status : state.toLowerCase();
  return (
    <header className="flex items-center justify-between border-b border-white/5 px-5 py-3">
      <div className="flex items-center gap-2.5">
        <Mark active={run?.status === 'running'} />
        <span className="text-[13px] font-medium tracking-tight text-fog-100">buddy</span>
        <span className="rounded-md bg-ink-700/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fog-300">
          {String(label).replace('_', ' ')}
        </span>
      </div>
      <kbd className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-fog-500">
        esc
      </kbd>
    </header>
  );
}

/** The collapsed form: enough to know it is alive and how to stop it. */
function Pill({ run }: { run: RunView }) {
  const last = run.steps[run.steps.length - 1];
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <Mark active={run.status === 'running'} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-fog-300">
        {last ? describeStep(last) : 'starting…'}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-fog-500">
        {run.usage.steps}/{run.budgets.maxSteps}
      </span>
      <button
        onClick={() => void api.stopRun()}
        className="no-drag rounded-md border border-rust-400/40 px-2 py-0.5 text-[11px]
                   text-rust-400 transition-colors hover:bg-rust-400/15"
      >
        Stop
      </button>
    </div>
  );
}

// ── ARMED ────────────────────────────────────────────────────────────────────

const GoalInput = React.forwardRef<
  HTMLTextAreaElement,
  { goal: string; setGoal: (s: string) => void; onSubmit: () => void }
>(function GoalInput({ goal, setGoal, onSubmit }, ref) {
  return (
    <div className="no-drag flex flex-col gap-3">
      <p className="text-[10px] uppercase tracking-[0.1em] text-fog-500">What should buddy finish?</p>
      <textarea
        ref={ref}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={3}
        placeholder="Open the Q3 Migration note and paste the connector-rename issue under Blockers"
        className="w-full resize-none rounded-xl border border-ink-700 bg-ink-950/70 px-3.5 py-3
                   text-[14px] leading-relaxed text-fog-100 outline-none
                   placeholder:text-fog-500/60 focus:border-ember-500/70"
      />
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-fog-500">
          M3 infers this from what you were doing. Until then, type it.
        </p>
        <button
          onClick={onSubmit}
          disabled={!goal.trim()}
          className="rounded-lg bg-ember-500 px-3 py-1.5 text-[12px] font-medium text-ink-950
                     transition-colors hover:bg-ember-400 disabled:opacity-30"
        >
          Continue ⏎
        </button>
      </div>
    </div>
  );
});

function Confirm({
  goal,
  profile,
  setProfile,
  apps,
  budgets,
  abortHotkey,
  error,
  onBack,
  onRun,
}: {
  goal: string;
  profile: RunProfile;
  setProfile: (p: RunProfile) => void;
  apps: string[];
  budgets?: { maxSteps: number; maxWallClockMs: number; maxCostUsd: number };
  /** The accelerator that would NOT register, or null when it did. */
  abortHotkey: string | null;
  error: string | null;
  onBack: () => void;
  onRun: () => void;
}) {
  // Enter runs. Deliberately explicit — §6.1 rules out an auto-proceed
  // countdown, because a countdown is a confirmation nobody reads.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRun]);

  return (
    <div className="no-drag flex flex-col gap-4">
      <div>
        <p className="text-[10px] uppercase tracking-[0.1em] text-fog-500">Goal</p>
        <h1 className="mt-1.5 text-[17px] leading-snug font-light tracking-tight text-fog-100">{goal}</h1>
      </div>

      <div className="flex gap-2">
        {(['attended', 'unattended'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setProfile(p)}
            className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              profile === p
                ? 'border-ember-500/60 bg-ember-500/10'
                : 'border-ink-700 bg-ink-850/50 hover:border-ink-600'
            }`}
          >
            <div className="text-[12px] font-medium text-fog-100">{p}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-fog-500">
              {p === 'attended'
                ? 'You are watching. Anything that sends, deletes, or installs asks you first.'
                : 'Nobody is watching. Those are refused outright and the run stops.'}
            </div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-ink-700/60 bg-ink-950/40 px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Allowlist</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-fog-300">
            {apps.length ? apps.join(' · ') : 'none'}
          </span>
        </div>
        {budgets && (
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-ink-800 pt-2">
            <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Budgets</span>
            <span className="font-mono text-[10px] text-fog-300">
              {budgets.maxSteps} steps · {Math.round(budgets.maxWallClockMs / 60_000)} min · $
              {budgets.maxCostUsd.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-fog-500">
        {profile === 'attended'
          ? 'Attended mode assumes you are watching. The guardrails are defence in depth, not a proof.'
          : 'buddy will not send, post, delete, install, or leave the allowlist. It stops and asks instead.'}
      </p>

      {/* A kill switch that did not register must be said out loud, at the
          moment the user is about to hand over the keyboard — not left in a
          log nobody opens. The other three still work, and it says so. */}
      {abortHotkey && (
        <p className="rounded-lg border border-ember-500/40 bg-ember-500/10 px-3 py-2 text-[11px] leading-relaxed text-ember-300">
          The abort hotkey <span className="font-mono">{abortHotkey}</span> could not be registered —
          another app may own it, or it is not a combination Electron accepts. The Stop button,{' '}
          <span className="font-mono">~/.buddy/ABORT</span>, and taking over the keyboard all still
          stop the run. Change it in Settings.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-rust-400/40 bg-rust-400/10 px-3 py-2 text-[11px] text-rust-400">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-[11px] text-fog-500 transition-colors hover:text-fog-100">
          ← Edit the goal
        </button>
        <button
          onClick={onRun}
          className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[12px] font-medium text-ink-950
                     transition-colors hover:bg-ember-400"
        >
          Run it ⏎
        </button>
      </div>
    </div>
  );
}

// ── ACTING ───────────────────────────────────────────────────────────────────

function Acting({ run }: { run: RunView | null }) {
  if (!run) {
    return <p className="py-6 text-center text-[12px] text-fog-500">Taking the first look at the screen…</p>;
  }
  // Newest at top, gently animated (§8.1).
  const feed = [...run.steps].reverse().slice(0, 7);
  return (
    <div className="no-drag flex flex-col gap-3.5">
      <p className="line-clamp-2 text-[13px] leading-snug text-fog-300">{run.goal}</p>

      <div className="flex flex-col gap-0.5">
        <AnimatePresence initial={false}>
          {feed.map((s) => (
            <StepLine key={`${s.runId}-${s.idx}`} step={s} />
          ))}
        </AnimatePresence>
        {feed.length === 0 && <p className="py-2 text-[12px] text-fog-500">Thinking…</p>}
      </div>

      <BudgetMeters run={run} />

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-fog-500">
          {run.profile} · cache read {run.cacheReadTokens.toLocaleString()} tok
        </span>
        <button
          onClick={() => void api.stopRun()}
          className="rounded-lg border border-rust-400/50 bg-rust-400/10 px-4 py-1.5 text-[12px]
                     font-medium text-rust-400 transition-colors hover:bg-rust-400/20"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// ── The confirm gate ─────────────────────────────────────────────────────────

function GateOverlay({ gate }: { gate: PendingGate }) {
  const safe = useMotionSafe();
  return (
    <motion.div
      initial={safe ? { y: '100%' } : { opacity: 1 }}
      animate={{ y: 0, opacity: 1 }}
      exit={safe ? { y: '100%' } : { opacity: 0 }}
      transition={safe ? spring : { duration: 0 }}
      className="no-drag absolute inset-0 flex flex-col justify-end bg-ink-950/92 backdrop-blur-md"
    >
      <div className="border-t border-ember-500/30 px-5 py-4">
        <p className="text-[10px] uppercase tracking-[0.1em] text-ember-400">buddy is asking first</p>
        <h2 className="mt-2 text-[15px] leading-snug text-fog-100">{gate.verdict.reason}</h2>
        <p className="mt-1.5 font-mono text-[11px] text-fog-500">
          {gate.action.replace(/_/g, ' ')} → {gate.verdict.target} · {gate.verdict.class} · via{' '}
          {gate.verdict.signal}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => void api.resolveGate('approve')}
            className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[12px] font-medium text-ink-950
                       transition-colors hover:bg-ember-400"
          >
            Approve
          </button>
          <button
            onClick={() => void api.resolveGate('deny')}
            className="rounded-lg border border-ink-600 bg-ink-800 px-3.5 py-1.5 text-[12px]
                       text-fog-100 transition-colors hover:bg-ink-700"
          >
            Deny
          </button>
          <button
            onClick={() => void api.resolveGate('stop')}
            className="ml-auto text-[11px] text-rust-400 transition-colors hover:text-rust-400/80"
          >
            Stop the run
          </button>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-fog-500">
          Denying stops the run here. buddy does not look for another way to do the same thing.
        </p>
      </div>
    </motion.div>
  );
}

// ── Ended ────────────────────────────────────────────────────────────────────

function Ended({ run, onClose }: { run: RunView | null; onClose: () => void }) {
  if (!run) return null;
  const good = run.status === 'done';
  const waiting = run.status === 'waiting';
  return (
    <div className="no-drag flex flex-col gap-3">
      <p
        className={`text-[10px] uppercase tracking-[0.1em] ${
          good ? 'text-moss-400' : waiting ? 'text-ember-400' : 'text-rust-400'
        }`}
      >
        {good ? 'Done' : waiting ? 'Waiting' : 'Needs you'}
      </p>
      <h1 className="text-[15px] leading-snug font-light text-fog-100">
        {run.haltReason ?? run.outcome?.summary ?? 'The run ended.'}
      </h1>
      {run.outcome?.wake && (
        <p className="text-[11px] text-fog-500">
          Will check every {run.outcome.wake.after_s}s for: “{run.outcome.wake.condition}” (up to{' '}
          {run.outcome.wake.max_attempts} times).
        </p>
      )}
      <div className="rounded-xl border border-ink-700/60 bg-ink-950/40 px-3.5 py-2.5 font-mono text-[10px] text-fog-500">
        {run.usage.steps} steps · {Math.round(run.usage.elapsedMs / 1000)}s · $
        {run.usage.costUsd.toFixed(3)} · cache read {run.cacheReadTokens.toLocaleString()} tok
      </div>
      <div className="flex items-center justify-between">
        <button
          onClick={() => void api.openHome()}
          className="text-[11px] text-fog-500 transition-colors hover:text-fog-100"
        >
          Open the run log →
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-ink-600 bg-ink-800 px-3.5 py-1.5 text-[12px]
                     text-fog-100 transition-colors hover:bg-ink-700"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Blocked({ screen, accessibility }: { screen: boolean; accessibility: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[17px] leading-snug font-light tracking-tight text-fog-100">
        buddy cannot {!screen ? 'see the screen' : 'control the machine'}.
      </h1>
      <p className="text-[12px] leading-relaxed text-fog-500">
        {!screen && 'Screen Recording has not been granted. Nothing is being captured. '}
        {!accessibility &&
          'Accessibility has not been granted — buddy cannot click, type, read the element under the ' +
            'pointer, or tell your keystrokes from its own. M2 requires it, and the Operator will not dispatch without it.'}
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

function Mark({ active = false }: { active?: boolean }) {
  const safe = useMotionSafe();
  return (
    <motion.span
      className={`block h-[9px] w-[9px] rounded-[3px] ${active ? 'bg-moss-400' : 'bg-ember-500'}`}
      animate={
        safe
          ? active
            ? { scale: [1, 1.35, 1], opacity: [1, 0.55, 1] }
            : { rotate: [0, 90, 90, 0], borderRadius: ['3px', '9px', '3px', '3px'] }
          : {}
      }
      transition={
        active
          ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 6, repeat: Infinity, ease: 'easeInOut', times: [0, 0.25, 0.5, 1] }
      }
    />
  );
}
