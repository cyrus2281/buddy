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
import { broadcast, createHome, hideHud } from './windows.js';
import type { CaptureScheduler } from './capture/scheduler.js';
import type { AppState, DisplayInfo } from '../shared/types.js';

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

  ipcMain.handle(CH.hideHud, () => hideHud());
  ipcMain.handle(CH.openHome, () => {
    createHome();
  });
  ipcMain.handle(CH.revealFrames, () => shell.openPath(paths.frames()));
}
