import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Button, Card, useMotionSafe } from '../components/primitives.js';
import { describeStep } from '../components/run.js';
import type { RunSummary } from '../../shared/ipc.js';
import type { RunStep, RunView } from '../../shared/types.js';

/// The Run Log (PRD §8.5).
///
/// "Every run, expandable to per-step: action, target, result, and the
/// screenshot at that step. This is the trust surface — when buddy does
/// something wrong, this is where the user finds out what and why."
///
/// So the emphasis is on *why*, not only on *what*: every step that went
/// through a guardrail shows the verdict, the class, and which of §7.2's three
/// signals produced it. A blocked step is the most important row on the screen
/// and is styled as such.

export function RunLog({ activeRun }: { activeRun: RunView | null }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  const refresh = useCallback(async () => setRuns(await api.getRuns(50)), []);

  useEffect(() => {
    void refresh();
    return api.onRun(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    if (activeRun && openId === null) setOpenId(activeRun.id);
  }, [activeRun?.id]);

  if (!runs.length) {
    return (
      <Card className="px-5 py-8 text-center">
        <p className="text-[13px] text-fog-300">No runs yet.</p>
        <p className="mt-1.5 text-[11px] text-fog-500">
          Press {formatAccelerator()} and tell buddy what to finish. Every run lands here, with the
          screen at each step.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 pb-1 text-[11px] leading-relaxed text-fog-500">
        Every action buddy took, and why it was allowed. Screenshots are kept with the run rather
        than in the frame vault, so they outlive the daily purge — deleting a run deletes them.
      </p>
      {runs.map((r) => (
        <RunCard
          key={r.id}
          run={r}
          open={openId === r.id}
          live={activeRun?.id === r.id ? activeRun : null}
          onToggle={() => setOpenId(openId === r.id ? null : r.id)}
          onDeleted={() => void refresh()}
        />
      ))}
    </div>
  );
}

function RunCard({
  run,
  open,
  live,
  onToggle,
  onDeleted,
}: {
  run: RunSummary;
  open: boolean;
  live: RunView | null;
  onToggle: () => void;
  onDeleted: () => void;
}) {
  const [steps, setSteps] = useState<RunStep[]>([]);
  const safe = useMotionSafe();

  useEffect(() => {
    if (!open) return;
    if (live) {
      setSteps(live.steps);
      return;
    }
    void api.getRunSteps(run.id).then(setSteps);
  }, [open, run.id, live?.steps.length]);

  const outcome = run.outcome as { summary?: string } | null;
  const blocked = steps.some((s) => s.verdict?.decision === 'deny');

  return (
    <Card className="overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-800/40"
      >
        <StatusPip status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-fog-100">{run.goal}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-fog-500">
            {new Date(run.startedAt).toLocaleString()} · {run.profile} · {run.steps} steps · $
            {run.costUsd.toFixed(3)}
            {outcome?.summary ? ` · ${outcome.summary}` : ''}
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-fog-500">
          {run.status.replace('_', ' ')}
        </span>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={safe ? { duration: 0.18 } : { duration: 0 }}
          className="shrink-0 text-fog-500"
        >
          ›
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={safe ? { height: 0, opacity: 0 } : false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={safe ? { height: 0, opacity: 0 } : { opacity: 0 }}
            transition={safe ? { duration: 0.22, ease: 'easeOut' } : { duration: 0 }}
            className="overflow-hidden border-t border-ink-800"
          >
            {blocked && (
              <p className="border-b border-rust-400/25 bg-rust-400/10 px-4 py-2 text-[11px] text-rust-400">
                A guardrail blocked an action in this run. buddy stopped there — it did not look for
                another way to do the same thing.
              </p>
            )}
            <div className="flex flex-col divide-y divide-ink-800/70">
              {steps.map((s) => (
                <StepRow key={s.idx} step={s} />
              ))}
              {steps.length === 0 && (
                <p className="px-4 py-4 text-[12px] text-fog-500">No steps recorded.</p>
              )}
            </div>
            <div className="flex justify-end border-t border-ink-800 px-4 py-2.5">
              <Button
                variant="danger"
                onClick={async () => {
                  await api.deleteRun(run.id);
                  onDeleted();
                }}
              >
                Delete this run and its screenshots
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function StepRow({ step }: { step: RunStep }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [showFrame, setShowFrame] = useState(false);
  const denied = step.verdict?.decision === 'deny';
  const gated = step.verdict?.decision === 'confirm';

  useEffect(() => {
    if (!showFrame || frame || !step.framePath) return;
    void api.readFrame(step.framePath).then(setFrame);
  }, [showFrame, step.framePath]);

  return (
    <div className={`px-4 py-2.5 ${denied ? 'bg-rust-400/[0.07]' : ''}`}>
      <div className="flex items-baseline gap-3">
        <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-fog-500/70">
          {step.idx}
        </span>
        <span
          className={`min-w-0 flex-1 text-[12px] ${
            denied ? 'text-rust-400' : step.isError ? 'text-ember-300' : 'text-fog-100'
          }`}
        >
          {describeStep(step)}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-fog-500/70">
          {new Date(step.ts).toLocaleTimeString()}
        </span>
        {step.framePath && (
          <button
            onClick={() => setShowFrame(!showFrame)}
            className="shrink-0 rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-fog-500
                       transition-colors hover:border-ink-600 hover:text-fog-300"
          >
            {showFrame ? 'hide' : 'screen'}
          </button>
        )}
      </div>

      {/* The result, verbatim. A summary of a summary is where trust goes. */}
      <div className="mt-1 pl-9 font-mono text-[10px] leading-relaxed text-fog-500">
        {typeof step.result === 'string' ? truncate(step.result, 260) : JSON.stringify(step.result)?.slice(0, 260)}
      </div>

      {step.verdict && (
        <div className="mt-1 pl-9">
          <span
            className={`inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
              denied
                ? 'bg-rust-400/20 text-rust-400'
                : gated
                  ? 'bg-ember-500/15 text-ember-300'
                  : 'bg-ink-700 text-fog-500'
            }`}
          >
            {step.verdict.decision} · {step.verdict.class} · via {step.verdict.signal}
          </span>
          <span className="ml-2 text-[10px] text-fog-500">{step.verdict.reason}</span>
        </div>
      )}

      {step.scale != null && step.scale !== 1 && (
        <div className="mt-1 pl-9 font-mono text-[10px] text-ember-300">
          coordinate scale {step.scale.toFixed(4)} — model coordinates were divided by this
        </div>
      )}

      {showFrame && (
        <div className="mt-2 pl-9">
          {frame ? (
            <img
              src={frame}
              alt={`The screen at step ${step.idx}`}
              className="max-w-full rounded-lg border border-ink-700"
            />
          ) : (
            <p className="text-[10px] text-fog-500">
              The screenshot for this step is gone — the run was deleted, or the file was removed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPip({ status }: { status: string }) {
  const colour =
    status === 'done'
      ? 'bg-moss-400'
      : status === 'running' || status === 'gated'
        ? 'bg-ember-400'
        : status === 'waiting'
          ? 'bg-ember-300'
          : 'bg-rust-400';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${colour}`} />;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const formatAccelerator = () => '⌥⌘Space';
