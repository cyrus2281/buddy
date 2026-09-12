import { app, Menu, Tray, nativeImage, dialog } from 'electron';
import path from 'node:path';
import { log } from './log.js';
import { paths } from './paths.js';
import { openDb, closeDb } from './store/db.js';
import { retention } from './store/retention.js';
import { settings } from './settings.js';
import { sidecar } from './sidecar/supervisor.js';
import { permissions } from './permissions.js';
import { CaptureScheduler } from './capture/scheduler.js';
import { hotkeys } from './hotkey.js';
import { broadcast, createHome, createHud, hideHud, toggleHud, isHudVisible } from './windows.js';
import { registerIpc, assertCoordinateScale } from './ipc.js';
import { CH } from '../shared/ipc.js';
import type { AppState } from '../shared/types.js';

/// Orchestrator: the single source of truth for buddy's state (PRD §3.2).
/// M1 occupies IDLE → OBSERVING → ARMED and PAUSED; the ACTING half arrives in
/// M2 behind the same state field.

let state: AppState = 'IDLE';
let scheduler: CaptureScheduler;
let tray: Tray | null = null;

function setState(next: AppState) {
  if (next === state) return;
  log.info('state', `${state} → ${next}`);
  state = next;
  broadcast(CH.onState, state);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const stats = scheduler?.getStats();
  const rate = scheduler?.keepRate();
  tray.setToolTip(
    `buddy — ${state.toLowerCase()}` +
      (stats ? `\n${stats.kept} kept / ${stats.considered} frames` : '') +
      (rate != null ? ` (${Math.round(rate * 100)}%)` : ''),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `buddy — ${state.toLowerCase()}`, enabled: false },
      { type: 'separator' },
      { label: 'Open buddy', click: () => createHome() },
      { label: 'Show HUD', accelerator: settings.get().hotkey, click: () => toggleHud() },
      { type: 'separator' },
      {
        label: settings.get().paused ? 'Resume observing' : 'Pause observing',
        click: () => {
          const paused = !settings.get().paused;
          settings.update({ paused });
          setState(paused ? 'PAUSED' : 'OBSERVING');
        },
      },
      { label: 'Purge frames now', click: () => { retention.sweep(); scheduler.refreshDiskStats(); } },
      { type: 'separator' },
      { label: 'Quit buddy', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  // A 16pt template image: macOS recolours it for light and dark menu bars.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAcElEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AU0BsAAOwAAWHMKMoAAAAASUVORK5CYII=',
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray();
}

/// Single instance. Two copies of buddy would both capture, both purge, and
/// fight over the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createHome());

  app.whenReady().then(main).catch((e) => {
    // Nothing else has run yet, so there is no UI to show this in.
    dialog.showErrorBox('buddy failed to start', String(e?.stack ?? e));
    app.exit(1);
  });
}

async function main() {
  paths.ensure();
  log.init(paths.logs());
  log.info('app', 'starting', { version: app.getVersion(), electron: process.versions.electron });

  openDb();
  const s = settings.load();

  // Menu-bar app: no Dock icon, no windows on launch. Observation is the
  // default mode, and it should not require a window to be open.
  app.setActivationPolicy?.('accessory');

  scheduler = new CaptureScheduler(s);
  registerIpc({ scheduler, getState: () => state, setState });
  createTray();
  createHud(); // built now so the hotkey is instant later

  // Retention runs before capture starts: a machine that was asleep overnight
  // should not accumulate a second day of frames before the first sweep.
  retention.start();
  retention.onSweep(() => scheduler.refreshDiskStats());

  try {
    await sidecar.start();
  } catch (e) {
    log.error('app', 'sidecar unavailable at launch', { error: (e as Error).message });
  }
  sidecar.on('status', (st) => broadcast(CH.onSidecar, st));
  sidecar.on('gave-up', () => {
    setState('NEEDS_HUMAN');
    log.error('app', 'observation halted: buddyd will not stay up');
  });

  permissions.start();
  permissions.on('changed', (p) => {
    broadcast(CH.onPermissions, p);
    // Capture cannot start before Screen Recording exists, and should start the
    // moment it does — without the user relaunching anything.
    if (p.screenRecording && !scheduler.isRunning() && !settings.get().paused) {
      scheduler.start();
      setState('OBSERVING');
    } else if (!p.screenRecording && scheduler.isRunning()) {
      scheduler.stop();
      setState('IDLE');
      log.warn('app', 'Screen Recording was revoked; observation stopped');
    }
  });

  await assertCoordinateScale();

  scheduler.on('stats', (st) => {
    broadcast(CH.onStats, st);
    updateTray();
  });
  scheduler.on('frame', (f) => broadcast(CH.onFrame, f));
  settings.on('changed', (next) => {
    scheduler.updateSettings(next);
    bindHotkeys();
    broadcast(CH.onSettings, next);
    updateTray();
  });
  log.onEntry((e) => broadcast(CH.onLog, e));

  const perms = await permissions.poll();
  if (perms.screenRecording && !s.paused) {
    scheduler.start();
    setState('OBSERVING');
  } else {
    setState(s.paused ? 'PAUSED' : 'IDLE');
    if (!perms.screenRecording) {
      log.warn('app', 'Screen Recording not granted; opening the permissions window');
      createHome();
    }
  }

  bindHotkeys();
  log.info('app', 'ready', { state, framesDir: paths.frames() });
}

function bindHotkeys() {
  const s = settings.get();
  const results = hotkeys.register([
    {
      label: 'Activate buddy',
      accelerator: s.hotkey,
      handler: () => {
        if (isHudVisible()) {
          hideHud();
          setState(scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
        } else {
          toggleHud();
          setState('ARMED');
        }
      },
    },
    {
      // Registered from M1 so the binding is never available to something else
      // by the time M2 needs it; the handler gains teeth when ACTING exists.
      label: 'Abort run',
      accelerator: s.abortHotkey,
      handler: () => {
        log.warn('hotkey', 'abort pressed', { state });
        hideHud();
        setState(scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
      },
    },
  ]);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    broadcast(CH.onLog, {
      t: Date.now(),
      level: 'warn' as const,
      scope: 'hotkey',
      msg: `Could not register: ${failed.map((f) => f.accelerator).join(', ')} — another app may own it`,
    });
  }
}

app.on('window-all-closed', () => {
  // Menu-bar app: closing the window stops nothing. Quitting is the tray's job.
});

app.on('will-quit', async (e) => {
  e.preventDefault();
  log.info('app', 'shutting down');
  hotkeys.unregisterAll();
  permissions.stop();
  retention.stop();
  scheduler?.stop();
  await sidecar.stop();
  closeDb();
  app.exit(0);
});
