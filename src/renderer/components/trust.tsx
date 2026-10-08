import React, { useEffect, useState } from 'react';
import { Card } from './primitives.js';
import { MIN_JUDGED, type TrustCluster, type TrustLevel } from '../../shared/trust.js';
import { api } from '../useBuddy.js';

/// Shadow mode, on the You tab: how often you take buddy's read, per kind of
/// task.
///
/// It is on the same screen as the beliefs and the corrections because it is
/// the same claim, measured rather than asserted: the other sections say what
/// buddy thinks it knows about you, and this one says how often that turned
/// out to be right. A task buddy keeps getting wrong is shown in the same list
/// as one it gets right, and coloured as plainly.

const LEVEL: Record<TrustLevel, { label: string; cls: string; bar: string }> = {
  unknown: { label: 'too early to say', cls: 'text-fog-500', bar: 'bg-ink-600' },
  learning: { label: 'learning', cls: 'text-fog-300', bar: 'bg-fog-500' },
  shaky: { label: 'often wrong', cls: 'text-rust-400', bar: 'bg-rust-400' },
  trusted: { label: 'reads you well', cls: 'text-moss-400', bar: 'bg-moss-400' },
};

export function TrustPanel({ version = 0 }: { version?: number }) {
  const [clusters, setClusters] = useState<TrustCluster[] | null>(null);

  useEffect(() => {
    void api.getTrust().then(setClusters);
  }, [version]);

  if (!clusters) return null;
  const judged = clusters.filter((c) => c.judged > 0);
  if (!judged.length) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-fog-100">How well buddy reads you</h3>
        <span className="font-mono text-[10px] text-fog-500">by the apps a task touches</span>
      </div>
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-[11px] leading-relaxed text-fog-500">
          Every time you press the hotkey, buddy guesses what you are doing — and you either run that
          guess or type something else. This is how that has gone, per kind of task. Nothing here was
          recorded for it: it is the runs buddy already remembers, counted.
        </p>
        <ul className="flex flex-col divide-y divide-ink-700/60">
          {judged.map((c) => (
            <li key={c.key} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] text-fog-100">{c.label}</span>
                <span className={`shrink-0 font-mono text-[10px] ${LEVEL[c.level].cls}`}>
                  {LEVEL[c.level].label}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="h-1 min-w-[40px] flex-1 overflow-hidden rounded-full bg-ink-700">
                  <span
                    className={`block h-full ${LEVEL[c.level].bar}`}
                    style={{ width: `${Math.round(c.rate * 100)}%` }}
                  />
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-fog-500">
                  {c.accepted}/{c.judged} taken · {c.runs} run{c.runs === 1 ? '' : 's'}
                </span>
              </div>
              {c.example && <p className="truncate text-[11px] text-fog-500">e.g. “{c.example}”</p>}
              {c.judged < MIN_JUDGED && (
                <p className="text-[11px] text-fog-500">
                  Not enough yet — buddy says nothing about a kind of task until it has {MIN_JUDGED}.
                </p>
              )}
              {c.level === 'trusted' && c.gatedRuns > 0 && (
                <p className="text-[11px] leading-relaxed text-fog-500">
                  buddy will not offer to run this unattended: {c.gatedRuns} of these needed you to approve
                  something, and unattended would stop dead there instead of asking.
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
