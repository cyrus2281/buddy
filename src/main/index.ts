import { app, Menu, Tray, nativeImage, dialog, powerMonitor } from 'electron';
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
import { broadcast, createHome, createHud, hideHud, setHudSticky, showHud, toggleHud, isHudVisible } from './windows.js';
import { registerIpc, assertCoordinateScale, setHotkeyIssues } from './ipc.js';
import { operator } from './agent/orchestrator.js';
import { NotesEngine } from './notes/engine.js';
import { Activation } from './agent/activation.js';
import { CH } from '../shared/ipc.js';
import type { AppState } from '../shared/types.js';

/// Orchestrator: the single source of truth for buddy's state (PRD §3.2).
/// M1 occupies IDLE → OBSERVING → ARMED and PAUSED; the ACTING half arrives in
/// M2 behind the same state field.

let state: AppState = 'IDLE';
let scheduler: CaptureScheduler;
let engine: NotesEngine;
let activation: Activation;
let tray: Tray | null = null;
/** The last T0 signal, so the provisional goal has a window title to fall back
 *  on without waiting for a sidecar round trip on the hotkey path. */
let lastFront = { bundleId: '', windowTitle: '' };

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
      // §7.3 kill switch 4: always present, always enabled during ACTING, and
      // reachable when every window is closed.
      ...(operator.isRunning()
        ? [
            { type: 'separator' as const },
            {
              label: 'Stop the run',
              accelerator: settings.get().abortHotkey,
              click: () => {
                operator.stop('stop-button');
                showHudNow();
              },
            },
          ]
        : []),
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

/** Show the HUD and bring it forward, whatever it was doing. */
function showHudNow() {
  showHud();
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
  engine = new NotesEngine({ scheduler, settings: s });
  activation = new Activation({
    engine,
    scheduler,
    frontWindowTitle: () => lastFront.windowTitle,
  });
  scheduler.on('signal', (sig) => {
    lastFront = { bundleId: sig.bundleId, windowTitle: sig.windowTitle };
  });
  registerIpc({ scheduler, engine, activation, getState: () => state, setState });
  createTray();
  createHud(); // built now so the hotkey is instant later
  // buddy's own clicks steal focus from the HUD constantly; blur must not
  // dismiss the window the Stop button lives on.
  setHudSticky(() => operator.isRunning());

  // Retention runs before capture starts: a machine that was asleep overnight
  // should not accumulate a second day of frames before the first sweep.
  retention.start();
  retention.onSweep((report) => {
    scheduler.refreshDiskStats();
    // Any view holding a list of frames is now showing thumbnails whose PNGs
    // have been unlinked. This fires for the hourly sweep as much as for the
    // Delete-all button, so a grid left open overnight does not rot.
    broadcast(CH.onFramesPurged, report);
  });

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
      if (settings.get().notesEnabled) engine.start();
      setState('OBSERVING');
    } else if (!p.screenRecording && scheduler.isRunning()) {
      scheduler.stop();
      engine.stop();
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

  // §4.1's other session boundary. `lock-screen` is included because a locked
  // Mac is a Mac nobody is working at, even when the display stays awake.
  powerMonitor.on('suspend', () => {
    log.info('app', 'system suspended; ending the session');
    engine.onSystemSleep();
  });
  powerMonitor.on('lock-screen', () => {
    log.info('app', 'screen locked; ending the session');
    engine.onSystemSleep();
  });
  powerMonitor.on('resume', () => log.info('app', 'system resumed'));
  // The tray menu is rebuilt on every state change, which is what keeps the
  // Stop item present for exactly as long as there is something to stop.
  operator.on('update', () => updateTray());
  settings.on('changed', (next) => {
    scheduler.updateSettings(next);
    engine.updateSettings(next);
    bindHotkeys();
    broadcast(CH.onSettings, next);
    updateTray();
  });
  log.onEntry((e) => broadcast(CH.onLog, e));

  const perms = await permissions.poll();
  if (perms.screenRecording && !s.paused) {
    scheduler.start();
    if (s.notesEnabled) engine.start();
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
        // During a run the hotkey re-expands the HUD rather than dismissing it:
        // hiding the thing with the Stop button on it is the wrong instinct.
        if (operator.isRunning()) {
          showHudNow();
          return;
        }
        if (isHudVisible()) {
          activation.cancel('dismissed');
          hideHud();
          setState(scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
        } else {
          // §6.1 step 2: the provisional goal is computed *before* the window is
          // shown, so the HUD's first paint already has it. It is one indexed
          // SQLite read; the model call it kicks off lands seconds later.
          activation.begin();
          showHudNow();
          setState('ARMED');
        }
      },
    },
    {
      // §7.3 kill switch 1. Registered since M1 so the binding could never be
      // taken by something else before M2 needed it.
      label: 'Abort run',
      accelerator: s.abortHotkey,
      handler: () => {
        log.warn('hotkey', 'abort pressed', { state });
        activation.cancel('dismissed');
        if (operator.stop('hotkey')) {
          // Show the HUD rather than hiding it: the user needs to see that it
          // stopped and what it had done.
          showHudNow();
          return;
        }
        hideHud();
        setState(scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
      },
    },
  ]);
  const failed = results.filter((r) => !r.ok);
  setHotkeyIssues(failed.map((f) => ({ label: f.label, accelerator: f.accelerator })));
  if (failed.length) {
    // One of these is a kill switch. A log line is not enough: the UI has to
    // say so at the moment the user is about to hand over the keyboard.
    const abort = failed.find((f) => f.label === 'Abort run');
    if (abort) {
      log.error('hotkey', 'the abort kill switch is NOT registered', { accelerator: abort.accelerator });
    }
    broadcast(CH.onLog, {
      t: Date.now(),
      level: 'warn' as const,
      scope: 'hotkey',
      msg: `Could not register: ${failed.map((f) => f.accelerator).join(', ')} — another app may own it, or it is not an accelerator Electron accepts`,
    });
  }
}

app.on('window-all-closed', () => {
  // Menu-bar app: closing the window stops nothing. Quitting is the tray's job.
});

app.on('will-quit', async (e) => {
  e.preventDefault();
  log.info('app', 'shutting down');
  operator.stop('stop-button');
  activation?.cancel('dismissed');
  hotkeys.unregisterAll();
  permissions.stop();
  retention.stop();
  // Ends the session, which triggers a final rollup. It is fire-and-forget:
  // blocking quit on a model call would make buddy feel wedged on exit, and
  // the observations survive to be rolled up at next launch either way.
  engine?.stop();
  scheduler?.stop();
  await sidecar.stop();
  closeDb();
  app.exit(0);
});
