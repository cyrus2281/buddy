import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useBuddy } from './useBuddy.js';
import { Hud } from './views/Hud.js';
import { Home } from './views/Home.js';
import { SettingsView } from './views/SettingsView.js';
import { Logs } from './views/Logs.js';
import { RunLog } from './views/RunLog.js';
import { StatusDot, useMotionSafe } from './components/primitives.js';

type Tab = 'home' | 'runs' | 'settings' | 'logs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'runs', label: 'Runs' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Log' },
];

export function App({ hud }: { hud: boolean }) {
  if (hud) return <Hud />;
  return <Shell />;
}

function Shell() {
  const b = useBuddy();
  const [tab, setTab] = useState<Tab>('home');
  const safe = useMotionSafe() && !b.settings?.reducedMotion;

  // A user who arrives with no permissions should land where the Grant buttons
  // are, not on an empty Home.
  useEffect(() => {
    if (b.permissions && !b.permissions.screenRecording) setTab('settings');
  }, [b.permissions?.screenRecording]);

  // A run in progress outranks whatever tab was last open.
  useEffect(() => {
    if (b.run && (b.run.status === 'running' || b.run.status === 'gated')) setTab('runs');
  }, [b.run?.status]);

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <header className="drag-region flex shrink-0 items-center justify-between border-b border-ink-800 px-5 pt-3.5 pb-2.5 pl-[86px]">
        <nav className="no-drag flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative rounded-lg px-3 py-1.5 text-[12px] transition-colors ${
                tab === t.id ? 'text-fog-100' : 'text-fog-500 hover:text-fog-300'
              }`}
            >
              {tab === t.id && (
                <motion.span
                  layoutId={safe ? 'tab-pill' : undefined}
                  className="absolute inset-0 rounded-lg bg-ink-800"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                />
              )}
              <span className="relative">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fog-500">
          <StatusDot ok={b.state === 'OBSERVING'} warn={b.state === 'PAUSED'} />
          {b.state.toLowerCase().replace('_', ' ')}
          <span className="ml-1 text-fog-500/60">v{b.snapshot?.version ?? '—'}</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={safe ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={safe ? { opacity: 0, y: -4 } : { opacity: 0 }}
            transition={safe ? { duration: 0.18, ease: 'easeOut' } : { duration: 0 }}
            className="mx-auto max-w-3xl"
          >
            {tab === 'home' && (
              <Home
                state={b.state}
                stats={b.stats}
                permissions={b.permissions}
                sidecar={b.sidecar}
                settings={b.settings}
                frames={b.frames}
                keepRate={b.keepRate}
                scaleWarning={b.snapshot?.scaleWarning ?? null}
              />
            )}
            {tab === 'runs' && <RunLog activeRun={b.run} />}
            {tab === 'settings' && (
              <SettingsView
                settings={b.settings}
                permissions={b.permissions}
                sidecar={b.sidecar}
                update={b.update}
              />
            )}
            {tab === 'logs' && <Logs logs={b.logs} />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
