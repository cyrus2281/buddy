import { useCallback, useEffect, useMemo, useState } from 'react';
import { setForcedReducedMotion } from './components/primitives.js';
import type { BuddyApi, Snapshot } from '../shared/ipc.js';
import type {
  AppState,
  CaptureStats,
  FrameRow,
  InferenceState,
  LogEntry,
  NotesStats,
  OperatorAvailability,
  PendingGate,
  Permissions,
  ProviderStatus,
  RunView,
  Settings,
  SidecarStatus,
  SpendReport,
  WakeupView,
} from '../shared/types.js';

declare global {
  interface Window {
    buddy: BuddyApi;
  }
}

export const api = window.buddy;

/// One hook that owns the live view of main-process state. Everything arrives
/// as a push, so the UI never polls and never shows a stale permission — which
/// is the whole requirement of §8.6.
export function useBuddy() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stats, setStats] = useState<CaptureStats | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState>('IDLE');
  const [frames, setFrames] = useState<FrameRow[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [run, setRun] = useState<RunView | null>(null);
  const [gate, setGate] = useState<PendingGate | null>(null);
  const [hotkeyIssues, setHotkeyIssues] = useState<{ label: string; accelerator: string }[]>([]);
  const [inference, setInference] = useState<InferenceState | null>(null);
  const [notesStats, setNotesStats] = useState<NotesStats | null>(null);
  const [spend, setSpend] = useState<SpendReport | null>(null);
  /** Bumped whenever a note changes anywhere, so every open list refetches
   *  without each one having to subscribe to the specific thing that changed. */
  const [notesVersion, setNotesVersion] = useState(0);
  const [wakeups, setWakeups] = useState<WakeupView[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [operator, setOperator] = useState<OperatorAvailability | null>(null);
  /** Bumped on every purge so the Timeline refetches. A day whose frames were
   *  unlinked by the hourly sweep must not keep showing thumbnails of files
   *  that are gone. */
  const [purgeVersion, setPurgeVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await api.getSnapshot();
      if (!alive) return;
      setSnapshot(s);
      setStats(s.stats);
      setPermissions(s.permissions);
      setSidecar(s.sidecar);
      setSettings(s.settings);
      setForcedReducedMotion(s.settings.reducedMotion);
      setState(s.state);
      setRun(s.activeRun);
      setHotkeyIssues(s.hotkeyIssues);
      setInference(s.inference);
      setNotesStats(s.notesStats);
      setSpend(s.spend);
      setWakeups(s.wakeups);
      setProviders(s.providers);
      setOperator(s.operator);
      setGate(s.activeRun?.gate ?? null);
      setFrames(await api.getRecentFrames(60));
      setLogs(await api.getLogs(200));
    })();

    const off = [
      api.onStats(setStats),
      api.onPermissions(setPermissions),
      api.onSidecar(setSidecar),
      api.onSettings((next) => {
        setSettings(next);
        // §8: motion is disabled, not shortened, and the switch has to reach
        // every spring rather than only the ones this component renders.
        setForcedReducedMotion(next.reducedMotion);
      }),
      api.onState(setState),
      api.onFrame((f) => setFrames((prev) => [f, ...prev].slice(0, 60))),
      // A purge tombstones rows and unlinks files, so the list has to be re-read
      // rather than filtered locally — refetching is the only thing that is
      // right for both "deleted everything" and "the hourly sweep took four".
      api.onFramesPurged(() => {
        void api.getRecentFrames(60).then(setFrames);
        setPurgeVersion((v) => v + 1);
      }),
      api.onLog((e) => setLogs((prev) => [...prev, e].slice(-200))),
      // The run view carries the gate, so a gate cleared by another window (or
      // by a kill switch) disappears here too rather than lingering.
      api.onRun((v) => {
        setRun(v);
        setGate(v.gate);
      }),
      api.onGate(setGate),
      api.onHotkeyIssues(setHotkeyIssues),
      api.onInference(setInference),
      api.onNotesStats(setNotesStats),
      api.onSpend(setSpend),
      api.onNotesChanged(() => setNotesVersion((v) => v + 1)),
      api.onWakeups(setWakeups),
      // A key added or removed changes what the Operator and the providers can
      // do, and `setSecret` broadcasts settings — so the capability matrix is
      // re-read rather than left showing what was true at mount.
      api.onSettings(() => {
        void api.getProviders().then((p) => {
          setProviders(p.providers);
          setOperator(p.operator);
        });
      }),
    ];
    return () => {
      alive = false;
      for (const fn of off) fn();
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.updateSettings(patch));
  }, []);

  const keepRate = useMemo(
    () => (stats && stats.considered > 0 ? stats.kept / stats.considered : null),
    [stats],
  );

  return {
    snapshot,
    stats,
    permissions,
    sidecar,
    settings,
    state,
    frames,
    logs,
    run,
    gate,
    hotkeyIssues,
    inference,
    notesStats,
    spend,
    notesVersion,
    wakeups,
    providers,
    operator,
    purgeVersion,
    update,
    keepRate,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} m`;
  return `${s} s`;
}
