import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, formatBytes, formatDuration } from '../useBuddy.js';
import { Button, Card, Stat, StatusDot, spring, useMotionSafe } from '../components/primitives.js';
import { PermissionsPanel } from './Permissions.js';
import type { AppState, CaptureStats, FrameRow, Permissions, Settings, SidecarStatus } from '../../shared/types.js';

/// Home (PRD §8.2). M1 shows the honest version: what buddy can see, what it is
/// keeping, and what it has thrown away. The recap and task cards arrive at M3
/// with the notes engine behind them.

export function Home({
  state,
  stats,
  permissions,
  sidecar,
  settings,
  frames,
  keepRate,
  scaleWarning,
}: {
  state: AppState;
  stats: CaptureStats | null;
  permissions: Permissions | null;
  sidecar: SidecarStatus | null;
  settings: Settings | null;
  frames: FrameRow[];
  keepRate: number | null;
  scaleWarning: string | null;
}) {
  const safe = useMotionSafe();
  const observing = state === 'OBSERVING';
  const since = stats?.observingSinceMs ? Date.now() - stats.observingSinceMs : 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center gap-2.5">
          <StatusDot ok={observing} warn={state === 'PAUSED'} />
          <h2 className="text-[15px] font-light tracking-tight text-fog-100">
            {observing
              ? `Watching for ${formatDuration(since)}`
              : state === 'PAUSED'
                ? 'Paused — nothing is being captured'
                : 'Not observing'}
          </h2>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-fog-500">
          Screenshots stay on this machine and are deleted after{' '}
          {settings?.retentionDays ?? 1} day{(settings?.retentionDays ?? 1) === 1 ? '' : 's'}. They
          leave only as model input when buddy observes or acts — that is the product, and it is
          worth knowing.
        </p>
      </section>

      {scaleWarning && (
        <Card className="border-ember-400/40 bg-ember-500/5 p-3.5">
          <p className="text-[12px] leading-relaxed text-ember-300">
            <span className="font-medium">Coordinate scale is not 1.0.</span> {scaleWarning}
          </p>
        </Card>
      )}

      <Card className="p-5">
        <div className="grid grid-cols-2 gap-y-5 sm:grid-cols-4">
          <Stat label="Frames kept" value={stats?.kept ?? 0} sub={`${stats?.considered ?? 0} considered`} />
          <Stat
            label="Keep rate"
            value={keepRate == null ? '—' : `${Math.round(keepRate * 100)}%`}
            sub="20–35% expected"
          />
          <Stat label="On disk" value={formatBytes(stats?.bytesOnDisk ?? 0)} sub={`${stats?.framesOnDisk ?? 0} files`} />
          <Stat
            label="Discarded"
            value={stats?.skippedDuplicate ?? 0}
            sub="near-identical frames"
          />
        </div>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-ink-700/60 pt-4 font-mono text-[11px] tabular-nums text-fog-500">
          <span>skipped idle {stats?.skippedIdle ?? 0}</span>
          <span>skipped excluded {stats?.skippedExcluded ?? 0}</span>
          <span className={stats?.skippedSecureInput ? 'text-ember-300' : ''}>
            skipped secure input {stats?.skippedSecureInput ?? 0}
          </span>
          <span className={stats?.errors ? 'text-rust-400' : ''}>errors {stats?.errors ?? 0}</span>
        </div>
      </Card>

      {permissions && (!permissions.screenRecording || !permissions.accessibility) && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[13px] font-medium text-fog-100">Permissions</h3>
          <PermissionsPanel permissions={permissions} sidecar={sidecar} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium text-fog-100">Recent frames</h3>
          <button
            onClick={() => void api.revealFrames()}
            className="text-[11px] text-fog-500 transition-colors hover:text-fog-100"
          >
            Reveal in Finder
          </button>
        </div>
        {frames.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-[12px] text-fog-500">
              No frames yet. They start appearing once Screen Recording is granted and you use the
              machine.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <AnimatePresence initial={false}>
              {frames.slice(0, 12).map((f) => (
                <motion.figure
                  key={f.id}
                  layout={safe}
                  initial={safe ? { opacity: 0, scale: 0.94 } : false}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={safe ? { opacity: 0, scale: 0.94 } : { opacity: 0 }}
                  transition={safe ? spring : { duration: 0 }}
                  className="overflow-hidden rounded-lg border border-ink-700/70 bg-ink-900"
                >
                  <img
                    src={`file://${f.path}`}
                    alt={`${f.app_name} at ${new Date(f.ts).toLocaleTimeString()}`}
                    className="aspect-[16/10] w-full object-cover object-top"
                    loading="lazy"
                  />
                  <figcaption className="flex items-baseline justify-between gap-2 px-2 py-1.5">
                    <span className="truncate text-[11px] text-fog-300">{f.app_name || '—'}</span>
                    <span className="shrink-0 font-mono text-[10px] text-fog-500">
                      {new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </figcaption>
                </motion.figure>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <section className="flex flex-wrap items-center gap-2.5">
        <Button
          variant={settings?.paused ? 'accent' : 'default'}
          onClick={() => void api.setPaused(!settings?.paused)}
        >
          {settings?.paused ? 'Resume observing' : 'Pause observing'}
        </Button>
        <Button onClick={() => void api.purgeNow()}>Run retention sweep</Button>
        <Button
          variant="danger"
          onClick={() => {
            if (confirm('Delete every captured frame right now? Notes made from them are kept.')) {
              void api.purgeAll();
            }
          }}
        >
          Delete all frames
        </Button>
      </section>
    </div>
  );
}
