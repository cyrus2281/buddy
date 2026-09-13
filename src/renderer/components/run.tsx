import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useMotionSafe } from './primitives.js';
import type { RunStep, RunView } from '../../shared/types.js';

/// Pieces shared between the HUD's live feed and the Run Log's history, so the
/// two never disagree about what a step was. The Run Log is the trust surface
/// (PRD §8.5); a step that reads one way live and another way afterwards is
/// exactly the kind of thing that costs trust.

/** One line, in the user's terms: what it did, and to what. */
export function describeStep(s: RunStep): string {
  const input = (s.input ?? {}) as Record<string, unknown>;
  const target = s.verdict?.target;
  switch (s.tool) {
    case 'screenshot':
      return 'Looked at the screen';
    case 'zoom':
      return 'Zoomed in';
    case 'describe_focused_window':
      return 'Read the window’s accessibility tree';
    case 'type':
      return `Typed “${truncate(String(input.text ?? ''), 42)}”`;
    case 'key':
      return `Pressed ${String(input.text ?? '')}`;
    case 'hold_key':
      return `Held ${String(input.text ?? '')} for ${input.duration}s`;
    case 'scroll':
      return `Scrolled ${String(input.scroll_direction ?? '')}${target ? ` in ${target}` : ''}`;
    case 'wait':
      return `Waited ${input.duration}s`;
    case 'cursor_position':
      return 'Checked where the pointer is';
    case 'finish':
      return `Finished: ${truncate(String(input.summary ?? ''), 60)}`;
    case 'no-tool-call':
      return 'Ended a turn without calling a tool';
    case 'kill-switch':
      return String(s.result ?? 'Kill-switch note');
    // M4 (§6.6). Waiting is part of what a run did, so it reads as a step
    // rather than as an unexplained gap in the log.
    case 'wake-check':
      return `Checked ${input.attempt}/${input.of}: ${truncate(String(s.result ?? ''), 70)}`;
    case 'resume':
      return `Woke up and carried on — ${truncate(String(input.condition ?? ''), 50)}`;
    case 'human-input':
    case 'gate-granted':
      return truncate(String(s.result ?? ''), 90);
    default:
      if (s.tool.includes('click') || s.tool.includes('mouse') || s.tool.includes('drag')) {
        const c = input.coordinate as number[] | undefined;
        const where = target || (Array.isArray(c) ? `${c[0]},${c[1]}` : 'the screen');
        return `${sentence(s.tool)} on ${where}`;
      }
      return sentence(s.tool);
  }
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const sentence = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function StepLine({ step, dense = false }: { step: RunStep; dense?: boolean }) {
  const safe = useMotionSafe();
  const denied = step.verdict?.decision === 'deny';
  return (
    <motion.div
      layout={safe}
      initial={safe ? { opacity: 0, y: -6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={safe ? { duration: 0.2, ease: 'easeOut' } : { duration: 0 }}
      className={`flex items-baseline gap-2.5 ${dense ? 'py-0.5' : 'py-1'}`}
    >
      <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-fog-500/70">
        {step.idx}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[12px] ${
          denied ? 'text-rust-400' : step.isError ? 'text-ember-300' : 'text-fog-300'
        }`}
      >
        {describeStep(step)}
      </span>
      {step.framePath && <span className="shrink-0 text-[10px] text-fog-500/70">📷</span>}
      {step.isError && !denied && <span className="shrink-0 text-[10px] text-ember-400">!</span>}
      {denied && <span className="shrink-0 text-[10px] text-rust-400">blocked</span>}
    </motion.div>
  );
}

/** Three meters, live (PRD §6.5, §8.1). Time ticks locally: the main process
 *  only pushes on a step, and a clock that jumps in ten-second lurches reads as
 *  a hung run. */
export function BudgetMeters({ run }: { run: RunView }) {
  const [now, setNow] = useState(Date.now());
  const live = run.status === 'running' || run.status === 'gated';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [live]);

  const elapsed = live ? now - run.startedAt : run.usage.elapsedMs;
  return (
    <div className="flex gap-3">
      <Meter
        label="steps"
        value={`${run.usage.steps}`}
        of={`${run.budgets.maxSteps}`}
        pct={run.usage.steps / run.budgets.maxSteps}
      />
      <Meter
        label="time"
        value={`${Math.floor(elapsed / 60_000)}:${String(Math.floor((elapsed % 60_000) / 1000)).padStart(2, '0')}`}
        of={`${Math.round(run.budgets.maxWallClockMs / 60_000)}m`}
        pct={elapsed / run.budgets.maxWallClockMs}
      />
      <Meter
        label="cost"
        value={`$${run.usage.costUsd.toFixed(2)}`}
        of={`$${run.budgets.maxCostUsd.toFixed(2)}`}
        pct={run.usage.costUsd / run.budgets.maxCostUsd}
      />
    </div>
  );
}

function Meter({ label, value, of, pct }: { label: string; value: string; of: string; pct: number }) {
  const safe = useMotionSafe();
  const p = Math.max(0, Math.min(1, pct));
  const colour = p >= 1 ? 'bg-rust-400' : p > 0.8 ? 'bg-ember-400' : 'bg-ember-500/70';
  return (
    <div className="flex-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] uppercase tracking-[0.09em] text-fog-500">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-fog-300">
          {value}
          <span className="text-fog-500/70">/{of}</span>
        </span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-ink-700">
        <motion.div
          className={`h-full rounded-full ${colour}`}
          animate={{ width: `${p * 100}%` }}
          transition={safe ? { duration: 0.35, ease: 'easeOut' } : { duration: 0 }}
        />
      </div>
    </div>
  );
}
