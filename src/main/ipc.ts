import { ipcMain, app, shell } from 'electron';
import { CH, type Snapshot } from '../shared/ipc.js';
import { settings } from './settings.js';
import { secrets } from './secrets.js';
import { permissions } from './permissions.js';
import { sidecar } from './sidecar/supervisor.js';
import { retention } from './store/retention.js';
import { frames } from './store/frames.js';
import { paths } from './paths.js';
import { log } from './log.js';
import { broadcast, createHome, hideHud, resizeHud } from './windows.js';
import { operator } from './agent/orchestrator.js';
import { runs } from './store/runs.js';
import fs from 'node:fs';
import path from 'node:path';
import type { CaptureScheduler } from './capture/scheduler.js';
import { DEFAULT_BUDGETS, type Allowlist, type AppState, type DisplayInfo, type StartRunRequest } from '../shared/types.js';

/** The allowlist a run starts from. M3 replaces this with `target_apps` from
 *  goal inference; until then the user confirms it in the HUD, which is the
 *  same keystroke either way (PRD §6.1). */
export const DEFAULT_ALLOWLIST: Allowlist = {
  apps: [
    'com.apple.Safari',
    'com.google.Chrome',
    'com.apple.TextEdit',
    'com.apple.Notes',
    'com.apple.finder',
    'com.microsoft.VSCode',
  ],
  domains: [],
};

/// Every renderer-reachable operation, registered in one place. Handlers are
/// deliberately thin: they translate and delegate, so the behaviour under test
/// lives in the modules rather than in the IPC layer.

interface Ctx {
  scheduler: CaptureScheduler;
  getState: () => AppState;
  setState: (s: AppState) => void;
}

let displaysCache: DisplayInfo[] = [];
let scaleWarning: string | null = null;
let hotkeyIssues: { label: string; accelerator: string }[] = [];

/** Set by `bindHotkeys()` after every registration attempt. */
export function setHotkeyIssues(issues: { label: string; accelerator: string }[]) {
  hotkeyIssues = issues;
  broadcast(CH.onHotkeyIssues, issues);
}

/// PRD §6.2 / R3: a startup assertion that logs loudly when the coordinate
/// scale is not 1.0, so a 4K display in "More Space" is a visible caveat rather
/// than clicks landing in the wrong place.
export async function assertCoordinateScale(): Promise<string | null> {
  try {
    const { displays } = await sidecar.displays();
    displaysCache = displays;
    const off = displays.filter((d) => d.modelScale !== 1);
    if (off.length === 0) {
      log.info('displays', 'coordinate scale 1.0 on all displays', {
        displays: displays.map((d) => `${d.width}x${d.height}`),
      });
      scaleWarning = null;
      return null;
    }
    scaleWarning =
      `Coordinate scale is not 1.0 on ${off.length} display(s): ` +
      off.map((d) => `${d.width}x${d.height} → ${d.modelScale.toFixed(4)}`).join(', ') +
      '. The executor must divide model coordinates by this factor.';
    log.warn('displays', scaleWarning, { displays: off });
    return scaleWarning;
  } catch (e) {
    log.warn('displays', 'could not enumerate displays', { error: (e as Error).message });
    return null;
  }
}

export function registerIpc(ctx: Ctx) {
  const snapshot = async (): Promise<Snapshot> => ({
    state: ctx.getState(),
    settings: settings.get(),
    permissions: permissions.current(),
    sidecar: sidecar.status(),
    stats: ctx.scheduler.getStats(),
    secrets: secrets.status(),
    displays: displaysCache,
    version: app.getVersion(),
    framesDir: paths.frames(),
    scaleWarning,
    activeRun: operator.active(),
    hotkeyIssues,
    defaultBudgets: DEFAULT_BUDGETS,
    defaultAllowlist: DEFAULT_ALLOWLIST,
  });

  ipcMain.handle(CH.getSnapshot, snapshot);
  ipcMain.handle(CH.getSettings, () => settings.get());
  ipcMain.handle(CH.updateSettings, (_e, patch) => settings.update(patch));
  ipcMain.handle(CH.getPermissions, () => permissions.poll());
  ipcMain.handle(CH.requestPermission, (_e, kind) => permissions.request(kind));
  ipcMain.handle(CH.openPermissionSettings, (_e, kind) => permissions.openSettings(kind));
  ipcMain.handle(CH.getStats, () => ctx.scheduler.getStats());
  ipcMain.handle(CH.getRecentFrames, (_e, limit = 50) => frames.recent(limit));
  ipcMain.handle(CH.getSecretsStatus, () => secrets.status());
  ipcMain.handle(CH.getLogs, (_e, limit = 200) => log.recent(limit));

  ipcMain.handle(CH.setSecret, (_e, name, value) => {
    secrets.set(name, value);
    const s = secrets.status();
    broadcast(CH.onSettings, settings.get());
    return s;
  });
  ipcMain.handle(CH.clearSecret, (_e, name) => {
    secrets.clear(name);
    return secrets.status();
  });

  ipcMain.handle(CH.setPaused, (_e, paused: boolean) => {
    const next = settings.update({ paused });
    ctx.setState(paused ? 'PAUSED' : 'OBSERVING');
    return next;
  });

  ipcMain.handle(CH.purgeNow, () => {
    const r = retention.sweep();
    ctx.scheduler.refreshDiskStats();
    return r;
  });
  ipcMain.handle(CH.purgeAll, () => {
    const r = retention.purgeAll();
    ctx.scheduler.refreshDiskStats();
    return r;
  });

  ipcMain.handle(CH.restartSidecar, async () => {
    await sidecar.restartNow();
    await permissions.poll();
    return sidecar.status();
  });

  // ── M2 — the Operator ───────────────────────────────────────────────────

  ipcMain.handle(CH.startRun, async (_e, req: StartRunRequest) => {
    ctx.setState('ACTING');
    try {
      const view = await operator.start(req);
      // The run's own terminal state decides where the app lands, so a parked
      // run leaves a visible NEEDS_HUMAN rather than quietly resuming.
      ctx.setState(view.status === 'needs_human' ? 'NEEDS_HUMAN' : view.status === 'waiting' ? 'STANDBY' : 'OBSERVING');
      return view;
    } catch (e) {
      ctx.setState('OBSERVING');
      throw e;
    }
  });

  ipcMain.handle(CH.stopRun, () => operator.stop('stop-button'));
  ipcMain.handle(CH.resolveGate, (_e, answer) => operator.resolveGate(answer));
  ipcMain.handle(CH.getActiveRun, () => operator.active());
  ipcMain.handle(CH.getRuns, (_e, limit = 50) => operator.history(limit));
  ipcMain.handle(CH.getRunSteps, (_e, runId: number) => operator.stepsFor(runId));
  ipcMain.handle(CH.deleteRun, (_e, runId: number) => operator.deleteRun(runId));
  ipcMain.handle(CH.armHud, () => ctx.setState('ARMED'));
  ipcMain.handle(CH.hudResize, (_e, height: number) => resizeHud(height));
  ipcMain.handle(CH.cancelArm, () => {
    if (!operator.isRunning()) ctx.setState(ctx.scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
  });

  /** Run-step screenshots live with the run, outside the frame vault, and the
   *  renderer has no filesystem access — so it asks for the bytes. Reads are
   *  confined to the runs directory: a path from the renderer is untrusted
   *  input like any other. */
  ipcMain.handle(CH.readFrame, (_e, p: string) => {
    const root = path.join(paths.root(), 'runs');
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root + path.sep)) {
      log.warn('ipc', 'refused a frame read outside the runs directory', { path: resolved });
      return null;
    }
    try {
      return `data:image/png;base64,${fs.readFileSync(resolved).toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle(CH.hideHud, () => hideHud());
  ipcMain.handle(CH.openHome, () => {
    createHome();
  });
  ipcMain.handle(CH.revealFrames, () => shell.openPath(paths.frames()));

  operator.on('update', (v) => broadcast(CH.onRun, v));
  operator.on('step', (s) => broadcast(CH.onRunStep, s));
  operator.on('gate', (g) => broadcast(CH.onGate, g));
  operator.on('narration', (n) => broadcast(CH.onNarration, n));

  // A run interrupted by a crash or a quit must not still read as running.
  runs.reconcileOnLaunch();
}
