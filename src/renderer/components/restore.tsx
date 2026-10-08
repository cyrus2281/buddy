import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Button, Card, spring, useMotionSafe } from '../components/primitives.js';
import { describePlan, timeOfDay, type RestoreItem, type RestorePlan } from '../../shared/workspace.js';

/// "Where was I?" on Home: the arrangement buddy last saw, and a button that
/// puts it back.
///
/// It shows nothing at all when there is nothing missing, which is most of the
/// time — a card that says "everything is already open" every time you look at
/// Home is a card people learn to skip past, and then miss on the morning it
/// matters. What is already back is shown, greyed, only once there is
/// something that is not: "6 of 9 are already here" is the useful context for
/// deciding, and noise on its own.

const KIND_LABEL: Record<RestoreItem['kind'], string> = {
  app: 'app',
  document: 'file',
  page: 'page',
};

export function RestorePanel({ version = 0 }: { version?: number }) {
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ opened: number; failed: { label: string; why: string }[] } | null>(null);
  const safe = useMotionSafe();

  const refresh = useCallback(() => {
    void api.getRestorePlan().then((p) => {
      setPlan(p);
      setSkip(new Set());
    });
  }, []);

  useEffect(() => {
    refresh();
    return api.onWorkspace(refresh);
  }, [refresh, version]);

  const missing = (plan?.items ?? []).filter((i) => !i.present);
  const present = (plan?.items ?? []).filter((i) => i.present);
  const chosen = missing.filter((i) => !skip.has(keyOf(i)));

  if (!plan?.from || !missing.length) return null;

  const restore = async () => {
    setBusy(true);
    try {
      setDone(await api.restoreWorkspace(chosen));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.section
      initial={safe ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={safe ? spring : { duration: 0 }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-fog-100">Where you were</h3>
        <span className="font-mono text-[10px] text-fog-500">{timeOfDay(plan.from.t)}</span>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <p className="text-[12px] leading-relaxed text-fog-300">{describePlan(plan)}</p>

        <ul className="flex flex-col gap-1">
          {missing.map((item) => {
            const k = keyOf(item);
            const on = !skip.has(k);
            return (
              <li key={k}>
                <button
                  onClick={() =>
                    setSkip((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(k);
                      else next.delete(k);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-ink-800/50"
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                      on ? 'border-moss-400 bg-moss-400 text-ink-950' : 'border-ink-600 text-transparent'
                    }`}
                    aria-hidden
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fog-100">{item.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-fog-500">
                    {item.appName} · {KIND_LABEL[item.kind]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {present.length > 0 && (
          <p className="text-[11px] text-fog-500">
            {present.length} of {plan.items.length} {present.length === 1 ? 'is' : 'are'} already open — buddy
            leaves those alone.
          </p>
        )}

        {/* The exclusion list applies to snapshots too, and a partial picture
            presented as a whole one is the thing §5.2 is written against. */}
        {plan.excluded > 0 && (
          <p className="text-[11px] leading-relaxed text-fog-500">
            {plan.excluded} window{plan.excluded === 1 ? '' : 's'} {plan.excluded === 1 ? 'was' : 'were'} not
            recorded — a password manager or a private window. buddy cannot put those back.
          </p>
        )}

        <AnimatePresence>
          {done && (
            <motion.div
              initial={safe ? { opacity: 0, height: 0 } : false}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <p className="text-[11px] leading-relaxed text-moss-400">
                Opened {done.opened} — behind what you are doing, so nothing jumped in front of you.
              </p>
              {done.failed.map((f) => (
                <p key={f.label} className="text-[11px] leading-relaxed text-rust-400">
                  {f.label}: {f.why}
                </p>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-fog-500">
            Opened in the background. Nothing is closed, and nothing you have now is touched.
          </span>
          <Button variant="accent" disabled={busy || !chosen.length} onClick={() => void restore()}>
            {busy ? 'Opening…' : `Put ${chosen.length === missing.length ? 'it' : `${chosen.length}`} back`}
          </Button>
        </div>
      </Card>
    </motion.section>
  );
}

const keyOf = (i: RestoreItem) => `${i.kind}:${i.bundleId}:${i.target ?? ''}`;
