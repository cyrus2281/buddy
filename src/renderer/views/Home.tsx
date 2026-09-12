import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, formatBytes, formatDuration } from '../useBuddy.js';
import { Button, Card, Stat, StatusDot, spring, useMotionSafe } from '../components/primitives.js';
import { PermissionsPanel } from './Permissions.js';
import type {
  AnyNote,
  AppState,
  CaptureStats,
  NotesStats,
  Permissions,
  Settings,
  SidecarStatus,
  SpendReport,
  TaskRow,
  TaskStatus,
} from '../../shared/types.js';

/// Home (PRD §8.2): what buddy has been doing, what it thinks you are working
/// on, and one button to hand the machine over.
///
/// The ordering is the argument. Today's recap and the task cards come first
/// because they are the evidence that the memory is real — a user who reads
/// them and recognises their own morning will press Activate; a user who reads
/// a generic summary of nothing will not, and should not. The capture
/// statistics that used to lead this screen are true but they are plumbing, so
/// they moved below the fold.

export function Home({
  state,
  stats,
  notesStats,
  spend,
  permissions,
  sidecar,
  settings,
  keepRate,
  scaleWarning,
  notesVersion,
  onOpenNotes,
}: {
  state: AppState;
  stats: CaptureStats | null;
  notesStats: NotesStats | null;
  spend: SpendReport | null;
  permissions: Permissions | null;
  sidecar: SidecarStatus | null;
  settings: Settings | null;
  keepRate: number | null;
  scaleWarning: string | null;
  notesVersion: number;
  onOpenNotes: () => void;
}) {
  const safe = useMotionSafe();
  const [recap, setRecap] = useState<AnyNote | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const observing = state === 'OBSERVING';
  const since = stats?.observingSinceMs ? Date.now() - stats.observingSinceMs : 0;

  const refresh = useCallback(async () => {
    const [r, t] = await Promise.all([api.getTodayRecap(), api.getOpenTasks()]);
    setRecap(r);
    setTasks(t as TaskRow[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, notesVersion, notesStats?.tasks, notesStats?.recaps]);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
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
          <p className="mt-1.5 font-mono text-[11px] tabular-nums text-fog-500">
            {stats?.considered ?? 0} frames · {stats?.kept ?? 0} kept
            {keepRate != null && ` (${Math.round(keepRate * 100)}%)`}
            {notesStats ? ` · ${notesStats.observations} observations · ${notesStats.recaps} recaps` : ''}
            {spend && ` · $${spend.total.toFixed(2)} today`}
          </p>
        </div>

        <Button
          variant="accent"
          className="!px-4 !py-2 !text-[13px]"
          onClick={() => void api.activate()}
          disabled={state === 'ACTING'}
          title={settings?.hotkey}
        >
          Activate buddy
          <kbd className="ml-1.5 font-mono text-[10px] opacity-70">
            {(settings?.hotkey ?? '').replace('Command', '⌘').replace('Alt', '⌥').replaceAll('+', '')}
          </kbd>
        </Button>
      </section>

      {spend?.capped && (
        <Card className="border-ember-400/40 bg-ember-500/5 p-3.5">
          <p className="text-[12px] leading-relaxed text-ember-300">
            <span className="font-medium">The daily cap is reached</span> (${spend.total.toFixed(2)} of $
            {spend.capUsd.toFixed(2)}). buddy has stopped observing and summarising for today. Activating
            still works — that is money you asked it to spend. Raise the cap in Settings.
          </p>
        </Card>
      )}

      {scaleWarning && (
        <Card className="border-ember-400/40 bg-ember-500/5 p-3.5">
          <p className="text-[12px] leading-relaxed text-ember-300">
            <span className="font-medium">Coordinate scale is not 1.0.</span> {scaleWarning}
          </p>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium text-fog-100">Today</h3>
          <button
            onClick={onOpenNotes}
            className="text-[11px] text-fog-500 transition-colors hover:text-fog-100"
          >
            All notes →
          </button>
        </div>
        <Card className="p-4">
          {recap ? (
            <>
              <h4 className="text-[13px] text-fog-100">{recap.title}</h4>
              <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-fog-300">
                {recap.body}
              </p>
              <p className="mt-2.5 font-mono text-[10px] text-fog-500">
                written {new Date(recap.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' · '}
                from {recap.sourceObs.length} observation{recap.sourceObs.length === 1 ? '' : 's'}
              </p>
            </>
          ) : (
            <p className="text-[12px] leading-relaxed text-fog-500">
              {observing
                ? 'Nothing summarised yet today. buddy writes a recap every hour it watches, and one when you stop for a while.'
                : 'buddy is not watching, so there is nothing to recap.'}
            </p>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium text-fog-100">What you are in the middle of</h3>
          {tasks.length > 0 && (
            <span className="font-mono text-[10px] text-fog-500">
              {tasks.length} open · newest is what the hotkey picks up
            </span>
          )}
        </div>
        {tasks.length === 0 ? (
          <Card className="p-6 text-center">
            <p className="text-[12px] leading-relaxed text-fog-500">
              No open tasks. These appear as buddy watches you work — and they are what it offers to
              finish when you press the hotkey.
            </p>
          </Card>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <AnimatePresence initial={false}>
              {tasks.slice(0, 6).map((t, i) => (
                <motion.div
                  key={t.id}
                  layout={safe}
                  initial={safe ? { opacity: 0, y: 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  exit={safe ? { opacity: 0, scale: 0.97 } : { opacity: 0 }}
                  transition={safe ? spring : { duration: 0 }}
                >
                  <TaskCard task={t} newest={i === 0} onChanged={() => void refresh()} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      {permissions && (!permissions.screenRecording || !permissions.accessibility) && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[13px] font-medium text-fog-100">Permissions</h3>
          <PermissionsPanel permissions={permissions} sidecar={sidecar} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-medium text-fog-100">Capture</h3>
        <Card className="p-5">
          <div className="grid grid-cols-2 gap-y-5 sm:grid-cols-4">
            <Stat label="Frames kept" value={stats?.kept ?? 0} sub={`${stats?.considered ?? 0} considered`} />
            <Stat
              label="Keep rate"
              value={keepRate == null ? '—' : `${Math.round(keepRate * 100)}%`}
              sub="20–35% expected"
            />
            <Stat
              label="On disk"
              value={formatBytes(stats?.bytesOnDisk ?? 0)}
              sub={`${stats?.framesOnDisk ?? 0} files`}
            />
            <Stat label="Discarded" value={stats?.skippedDuplicate ?? 0} sub="near-identical frames" />
          </div>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-ink-700/60 pt-4 font-mono text-[11px] tabular-nums text-fog-500">
            <span>skipped idle {stats?.skippedIdle ?? 0}</span>
            <span>skipped excluded {stats?.skippedExcluded ?? 0}</span>
            <span className={stats?.skippedSecureInput ? 'text-ember-300' : ''}>
              skipped secure input {stats?.skippedSecureInput ?? 0}
            </span>
            <span className={stats?.errors ? 'text-rust-400' : ''}>errors {stats?.errors ?? 0}</span>
          </div>
          <p className="mt-4 border-t border-ink-700/60 pt-3 text-[11px] leading-relaxed text-fog-500">
            Screenshots stay on this machine and are deleted after {settings?.retentionDays ?? 1} day
            {(settings?.retentionDays ?? 1) === 1 ? '' : 's'}. They leave only as model input when buddy
            observes or acts — that is the product, and it is worth knowing. The notes made from them are
            kept.
          </p>
        </Card>
      </section>

      <section className="flex flex-wrap items-center gap-2.5">
        <Button
          variant={settings?.paused ? 'accent' : 'default'}
          onClick={() => void api.setPaused(!settings?.paused)}
        >
          {settings?.paused ? 'Resume observing' : 'Pause observing'}
        </Button>
        <Button onClick={() => void api.purgeNow()}>Run retention sweep</Button>
        <Button onClick={() => void api.revealFrames()}>Reveal frames in Finder</Button>
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

const STATUS_STYLE: Record<TaskStatus, string> = {
  open: 'border-moss-400/40 bg-moss-400/10 text-moss-400',
  blocked: 'border-rust-400/40 bg-rust-400/10 text-rust-400',
  waiting: 'border-ember-500/40 bg-ember-500/10 text-ember-300',
  done: 'border-ink-600 bg-ink-800 text-fog-500',
};

/** A task card is the closest thing buddy has to a promise: press the hotkey
 *  and this is what it offers to finish. Marking one done from here is the
 *  cheapest correction available, so it is one click, not a detail view. */
function TaskCard({ task, newest, onChanged }: { task: TaskRow; newest: boolean; onChanged: () => void }) {
  return (
    <Card className={`flex h-full flex-col p-3.5 ${newest ? 'border-ember-500/35' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[task.status]}`}>
          {task.status}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-fog-500">
          {task.scope} · {new Date(task.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <h4 className="mt-2 text-[12.5px] leading-snug text-fog-100">{task.title}</h4>
      {task.body && <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-fog-500">{task.body}</p>}
      <div className="mt-auto flex items-center justify-between gap-2 pt-2.5">
        {newest ? (
          <span className="font-mono text-[10px] text-ember-300">the hotkey picks this up</span>
        ) : (
          <span />
        )}
        {task.status !== 'done' && (
          <button
            onClick={() => void api.setTaskStatus(task.id, 'done').then(onChanged)}
            className="shrink-0 text-[11px] text-fog-500 transition-colors hover:text-moss-400"
          >
            Mark done
          </button>
        )}
      </div>
    </Card>
  );
}
