import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, useBuddy } from '../useBuddy.js';
import { spring, useMotionSafe } from '../components/primitives.js';
import { BudgetMeters, StepLine, describeStep } from '../components/run.js';
import {
  Alternatives,
  AlreadyDone,
  Evidence,
  GoalLine,
  InjectionNotice,
  RiskFlags,
} from '../components/inference.js';
import type {
  Allowlist,
  InferenceState,
  PendingGate,
  RunProfile,
  RunView,
} from '../../shared/types.js';

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
/// **M3 made the typed goal optional.** The ARMED panel now opens with a goal
/// already in it — provisional within ~200 ms from the newest open task note,
/// then replaced in place by the model's reading with evidence, risk flags, a
/// proposed profile and the app allowlist it seeds. One Enter runs it, which is
/// what §6.1 means by confirming the goal and the app set in the same keystroke.
///
/// Typing still works and always wins. It is the override for the case the
/// reading gets wrong, the case where there is no key, and the case where the
/// user simply wants something else — and it is one keystroke away rather than
/// behind a mode.

type Phase = 'armed' | 'typing' | 'acting' | 'ended';

const PROFILE_COPY: Record<RunProfile, string> = {
  attended: 'You are watching. Anything that sends, deletes, or installs asks you first.',
  unattended: 'Nobody is watching. Those are refused outright and the run stops.',
  leashless: 'Nobody is watching and nothing is refused. Everything is pre-approved.',
};
export function Hud() {
  const { state, permissions, snapshot, run, gate, hotkeyIssues, inference, settings } = useBuddy();
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<Phase>('armed');
  /** Null until the user types. Non-null means the typed goal wins over the
   *  inferred one, for the rest of this activation. */
  const [typed, setTyped] = useState<string | null>(null);
  const [profile, setProfile] = useState<RunProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const safe = useMotionSafe();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const running = run?.status === 'running' || run?.status === 'gated';
  const ended = !!run && ['done', 'waiting', 'needs_human', 'cancelled'].includes(run.status);
  const reading = inference?.reading ?? null;

  /** The goal that will actually run: what the user typed, else what buddy
   *  read, else the provisional guess. One expression, so there is never a
   *  question of which one the Enter key is about to use. */
  const goal = (typed ?? inference?.goal ?? '').trim();

  /** §6.1 step 6. Below 0.5 buddy asks instead of acting — unless the user has
   *  typed, in which case there is nothing left to be unsure about. */
  const mustAsk = !typed && !!reading && reading.confidence < 0.5;

  /** §6.1: `target_apps` seeds the allowlist the user confirms in the same
   *  keystroke as the goal. Before the reading lands there is nothing to seed
   *  it with, so the configured default stands and the panel says which. */
  const allowlist: Allowlist = reading?.target_apps.length
    ? { apps: reading.target_apps, domains: snapshot?.defaultAllowlist.domains ?? [] }
    : (snapshot?.defaultAllowlist ?? { apps: [], domains: [] });
  const allowlistSeeded = !!reading?.target_apps.length;

  const effectiveProfile: RunProfile = profile ?? reading?.proposed_profile ?? 'attended';

  /** §7.1: leashless is not offered until it is turned on in Settings. */
  const profiles: RunProfile[] = settings?.leashlessEnabled
    ? ['attended', 'unattended', 'leashless']
    : ['attended', 'unattended'];

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
        setPhase('armed');
        setTyped(null);
        setProfile(null);
        setError(null);
      }
    });
    const offHide = api.onHudHidden(() => setVisible(false));
    return () => {
      offShow();
      offHide();
    };
  }, [running, ended]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setTyped(null);
    setProfile(null);
    setPhase('armed');
    setError(null);
    void api.cancelArm();
    void api.hideHud();
  }, []);

  const start = useCallback(
    async (withGoal: string, withProfile: RunProfile) => {
      setError(null);
      setPhase('acting');
      try {
        await api.startRun({
          goal: withGoal,
          profile: withProfile,
          allowlist,
          budgets: snapshot?.defaultBudgets,
        });
      } catch (e) {
        setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        setPhase('armed');
      }
    },
    [allowlist, snapshot],
  );

  /** Start typing to take over the goal. Deliberately not a button: the PRD's
   *  interaction is "Enter to run, type to amend, Esc to cancel", and putting
   *  the amend path behind a click would make the fast case slower. */
  const beginTyping = useCallback(
    (seed: string) => {
      setTyped(seed);
      setPhase('typing');
      setTimeout(() => {
        inputRef.current?.focus();
        const el = inputRef.current;
        if (el) el.selectionStart = el.selectionEnd = el.value.length;
      }, 40);
    },
    [],
  );

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
      if (phase === 'typing') {
        setTyped(null);
        setPhase('armed');
        return;
      }
      dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gate, running, phase, dismiss]);

  // The ARMED keyboard surface: Enter runs, a digit picks an alternative, and
  // any other printable key starts amending the goal rather than being dropped.
  useEffect(() => {
    if (phase !== 'armed' || gate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (mustAsk || !goal) {
          beginTyping(goal);
          return;
        }
        void start(goal, effectiveProfile);
        return;
      }
      if (mustAsk && reading && /^[1-3]$/.test(e.key)) {
        const options = [reading.goal, ...reading.alternatives.map((a) => a.goal)];
        const picked = options[Number(e.key) - 1];
        if (picked) {
          e.preventDefault();
          setTyped(picked);
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const i = profiles.indexOf(effectiveProfile);
        setProfile(profiles[(i + 1) % profiles.length]!);
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        beginTyping(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, gate, goal, mustAsk, reading, effectiveProfile, profiles, start, beginTyping]);

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

  // The window is sized to its content, so a pill is actually a pill.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => void api.hudResize(el.getBoundingClientRect().height + 24);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, collapsed, gate, run?.steps.length, error, inference?.phase]);

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
                  ) : phase === 'acting' ? (
                    <Acting run={run} />
                  ) : phase === 'ended' ? (
                    <Ended run={run} onClose={dismiss} />
                  ) : phase === 'typing' ? (
                    <TypedGoal
                      ref={inputRef}
                      goal={typed ?? ''}
                      setGoal={setTyped}
                      profile={effectiveProfile}
                      onBack={() => {
                        setTyped(null);
                        setPhase('armed');
                      }}
                      onRun={() => (typed ?? '').trim() && void start((typed ?? '').trim(), effectiveProfile)}
                    />
                  ) : (
                    <Armed
                      inference={inference}
                      goal={goal}
                      mustAsk={mustAsk}
                      profile={effectiveProfile}
                      profileIsMine={profile !== null}
                      setProfile={setProfile}
                      allowlist={allowlist}
                      allowlistSeeded={allowlistSeeded}
                      profiles={profiles}
                      budgets={snapshot?.defaultBudgets}
                      abortHotkey={hotkeyIssues.find((h) => h.label === 'Abort run')?.accelerator ?? null}
                      error={error}
                      onPick={(g) => setTyped(g)}
                      onAmend={() => beginTyping(goal)}
                      onRun={() => goal && void start(goal, effectiveProfile)}
                    />
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

/**
 * The panel the hotkey opens onto (PRD §8.1).
 *
 * It is the same panel from the first 200 ms to the end: the goal line changes
 * from the local guess to the model's reading in place, and the evidence, risk
 * flags, and allowlist fill in beneath it. Nothing appears above the goal after
 * the first paint, because a layout that pushes the headline down at second
 * nine reads as a different screen rather than the same one, updated.
 */
function Armed({
  inference,
  goal,
  mustAsk,
  profile,
  profileIsMine,
  setProfile,
  allowlist,
  allowlistSeeded,
  profiles,
  budgets,
  abortHotkey,
  error,
  onPick,
  onAmend,
  onRun,
}: {
  inference: InferenceState | null;
  goal: string;
  mustAsk: boolean;
  profile: RunProfile;
  /** True once the user has overridden the proposal, so the panel can stop
   *  claiming the profile is buddy's suggestion. */
  profileIsMine: boolean;
  setProfile: (p: RunProfile) => void;
  allowlist: Allowlist;
  allowlistSeeded: boolean;
  /** `leashless` appears only when it has been turned on in Settings (§7.1). */
  profiles: RunProfile[];
  budgets?: { maxSteps: number; maxWallClockMs: number; maxCostUsd: number };
  abortHotkey: string | null;
  error: string | null;
  onPick: (goal: string) => void;
  onAmend: () => void;
  onRun: () => void;
}) {
  const reading = inference?.reading ?? null;
  const state: InferenceState = inference ?? {
    phase: 'idle',
    goal: null,
    source: 'none',
    reading: null,
    error: null,
    ms: null,
    costUsd: null,
    requestId: 0,
  };
  const nothingToGoOn = state.phase !== 'provisional' && !goal;

  return (
    <div className="no-drag flex flex-col gap-4">
      <GoalLine state={state} />

      {reading?.injection_notice && <InjectionNotice quote={reading.injection_notice} />}

      {mustAsk && reading ? (
        <Alternatives reading={reading} onPick={onPick} />
      ) : (
        <>
          {reading && <Evidence items={reading.evidence} />}
          {reading && <AlreadyDone items={reading.already_done} />}
        </>
      )}

      {nothingToGoOn && (
        <p className="text-[11px] leading-relaxed text-fog-500">
          {state.phase === 'error'
            ? state.error
            : 'Nothing recent enough to pick up. Type what you want finished.'}
        </p>
      )}

      <div className="flex gap-2">
        {profiles.map((p) => (
          <button
            key={p}
            onClick={() => setProfile(p)}
            className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              profile === p
                ? p === 'leashless'
                  ? 'border-rust-400/70 bg-rust-400/10'
                  : 'border-ember-500/60 bg-ember-500/10'
                : 'border-ink-700 bg-ink-850/50 hover:border-ink-600'
            }`}
          >
            <div className="flex items-baseline gap-1.5">
              <span
                className={`text-[12px] font-medium ${p === 'leashless' ? 'text-rust-400' : 'text-fog-100'}`}
              >
                {p}
              </span>
              {!profileIsMine && reading?.proposed_profile === p && (
                <span className="font-mono text-[9px] uppercase tracking-wider text-fog-500">
                  buddy’s pick
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-fog-500">
              {PROFILE_COPY[p]}
            </div>
          </button>
        ))}
      </div>

      {reading && <RiskFlags flags={reading.risk_flags} />}

      <div className="rounded-xl border border-ink-700/60 bg-ink-950/40 px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 text-[10px] uppercase tracking-[0.09em] text-fog-500">
            {allowlistSeeded ? 'Apps buddy may touch' : 'Allowlist (default)'}
          </span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-fog-300">
            {allowlist.apps.length ? allowlist.apps.join(' · ') : 'none'}
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

      {profile === 'leashless' ? (
        <p className="rounded-lg border border-rust-400/50 bg-rust-400/10 px-3 py-2.5 text-[11px] leading-relaxed text-rust-400">
          <span className="font-medium">Nothing will ask you.</span> buddy can send messages and
          email, delete files, install software, complete a purchase, and type passwords or keys,
          with nobody watching and no confirmation. The allowlist does not apply. Stopping it is
          still yours — the hotkey, Stop, <span className="font-mono">~/.buddy/ABORT</span> — and
          the step, time, and cost budgets still end the run.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-fog-500">
          {profile === 'attended'
            ? 'Attended mode assumes you are watching. The guardrails are defence in depth, not a proof.'
            : 'buddy will not send, post, delete, install, or leave the allowlist. It stops and asks instead.'}
        </p>
      )}

      {/* A kill switch that did not register must be said out loud, at the
          moment the user is about to hand over the keyboard — not left in a
          log nobody opens. The other two still work, and it says so. */}
      {abortHotkey && (
        <p className="rounded-lg border border-ember-500/40 bg-ember-500/10 px-3 py-2 text-[11px] leading-relaxed text-ember-300">
          The abort hotkey <span className="font-mono">{abortHotkey}</span> could not be registered —
          another app may own it, or it is not a combination Electron accepts. The Stop button and{' '}
          <span className="font-mono">~/.buddy/ABORT</span> both still stop the run. Change it in
          Settings.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-rust-400/40 bg-rust-400/10 px-3 py-2 text-[11px] text-rust-400">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <button onClick={onAmend} className="text-[11px] text-fog-500 transition-colors hover:text-fog-100">
          Type to change it
        </button>
        <div className="flex items-center gap-2">
          {state.phase === 'ready' && state.ms != null && (
            <span className="font-mono text-[10px] text-fog-500/70">
              read in {(state.ms / 1000).toFixed(1)}s
            </span>
          )}
          <button
            onClick={mustAsk || !goal ? onAmend : onRun}
            disabled={!goal && !mustAsk}
            className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[12px] font-medium text-ink-950
                       transition-colors hover:bg-ember-400 disabled:opacity-30"
          >
            {mustAsk ? 'Pick one ⏎' : 'Run it ⏎'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The override (PRD §6.1 step 5). Same panel, one field, and the profile and
 *  allowlist the ARMED panel already settled. */
const TypedGoal = React.forwardRef<
  HTMLTextAreaElement,
  {
    goal: string;
    setGoal: (s: string) => void;
    profile: RunProfile;
    onBack: () => void;
    onRun: () => void;
  }
>(function TypedGoal({ goal, setGoal, profile, onBack, onRun }, ref) {
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
            onRun();
          }
        }}
        rows={3}
        placeholder="Open the Q3 Migration note and paste the connector-rename issue under Blockers"
        className="w-full resize-none rounded-xl border border-ink-700 bg-ink-950/70 px-3.5 py-3
                   text-[14px] leading-relaxed text-fog-100 outline-none
                   placeholder:text-fog-500/60 focus:border-ember-500/70"
      />
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-[11px] text-fog-500 transition-colors hover:text-fog-100">
          ← Back to what buddy read
        </button>
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[10px] text-fog-500">{profile}</span>
          <button
            onClick={onRun}
            disabled={!goal.trim()}
            className="rounded-lg bg-ember-500 px-3 py-1.5 text-[12px] font-medium text-ink-950
                       transition-colors hover:bg-ember-400 disabled:opacity-30"
          >
            Run it ⏎
          </button>
        </div>
      </div>
    </div>
  );
});

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

      {run.sessionGrants.length > 0 && (
        <p className="rounded-lg border border-ember-500/30 bg-ember-500/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-ember-300">
          Not asking again about: {run.sessionGrants.join(' · ')} — until this run ends.
        </p>
      )}

      <div className="flex items-center justify-between">
        <span
          className={`font-mono text-[10px] ${run.profile === 'leashless' ? 'text-rust-400' : 'text-fog-500'}`}
        >
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
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void api.resolveGate('approve')}
            className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[12px] font-medium text-ink-950
                       transition-colors hover:bg-ember-400"
          >
            Approve
          </button>
          {/* The blanket grant. Deliberately not offered on the first ask: a
              task that needs one confirmation should get one confirmation, and
              putting "stop asking" in front of someone before they know how
              often they will be asked is how people grant more than they meant
              to. The second ask is when it becomes the useful answer. */}
          <button
            onClick={() => void api.resolveGate('approve-session')}
            className="rounded-lg border border-ember-500/50 bg-ember-500/10 px-3.5 py-1.5
                       text-[12px] text-ember-300 transition-colors hover:bg-ember-500/20"
            title={`buddy will not ask again about ${gate.sessionScope} until this run ends.`}
          >
            Allow {gate.sessionScope} for this run
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
          Allowing for the run covers {gate.sessionScope} and nothing else — it ends when the run
          does, and every action it covers is still in the log.
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
      {/* §6.6, and the whole of Story B. The wakeup is already a row in SQLite
          by the time this renders — so this is a statement about what buddy
          will do, not a promise the window is holding on to. Saying that out
          loud is the point: "you can close this" is the difference between
          standby and a dialog someone is afraid to dismiss. */}
      {waiting && run.outcome?.wake && (
        <div className="rounded-xl border border-ember-500/35 bg-ember-500/5 px-3.5 py-3">
          <p className="text-[12px] leading-snug text-ember-300">
            Watching for: “{run.outcome.wake.condition}”
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fog-500">
            Looking every {Math.round(run.outcome.wake.after_s / 60) || 1} min, up to{' '}
            {run.outcome.wake.max_attempts} times. Each look is one screenshot through a small
            model — a fraction of a cent. buddy picks this run back up where it left off when the
            answer is yes, and asks you if it runs out of looks.
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fog-500">
            You can close this, and you can quit buddy. The wait is stored, not held in this window.
          </p>
        </div>
      )}
      {run.resumes > 0 && (
        <p className="font-mono text-[10px] text-fog-500">
          resumed {run.resumes} time{run.resumes === 1 ? '' : 's'} from standby
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
