import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BuddyApi, Snapshot } from '../shared/ipc.js';
import type { AppState, CaptureStats, FrameRow, LogEntry, Permissions, Settings, SidecarStatus } from '../shared/types.js';

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
      setState(s.state);
      setFrames(await api.getRecentFrames(60));
      setLogs(await api.getLogs(200));
    })();

    const off = [
      api.onStats(setStats),
      api.onPermissions(setPermissions),
      api.onSidecar(setSidecar),
      api.onSettings(setSettings),
      api.onState(setState),
      api.onFrame((f) => setFrames((prev) => [f, ...prev].slice(0, 60))),
      api.onLog((e) => setLogs((prev) => [...prev, e].slice(-200))),
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

  return { snapshot, stats, permissions, sidecar, settings, state, frames, logs, update, keepRate };
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
