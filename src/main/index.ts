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
import { StandbyManager } from './agent/standby.js';
import { notify } from './notify.js';
import { CH } from '../shared/ipc.js';
import type { AppState } from '../shared/types.js';

/// Orchestrator: the single source of truth for buddy's state (PRD §3.2).
/// M1 occupies IDLE → OBSERVING → ARMED and PAUSED; the ACTING half arrives in
/// M2 behind the same state field.

let state: AppState = 'IDLE';
let scheduler: CaptureScheduler;
let engine: NotesEngine;
let activation: Activation;
let standby: StandbyManager;
let tray: Tray | null = null;
/** The last T0 signal, so the provisional goal has a window title to fall back
 *  on without waiting for a sidecar round trip on the hotkey path. */
let lastFront = { bundleId: '', windowTitle: '' };
/** The run id already announced as needing a person, so one parked run does not
 *  produce a notification per `update` event. */
let notifiedNeedsHuman = 0;

function setState(next: AppState) {
  if (next === state) return;
  log.info('state', `${state} → ${next}`);
  state = next;
  broadcast(CH.onState, state);
  updateTray();
}

let pendingWakeups = 0;

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
      // Standby is the one state that is entirely invisible otherwise: the HUD
      // is dismissed, nothing is moving, and buddy is still on the hook for
      // something. The menu bar is where that belongs.
      ...(pendingWakeups > 0
        ? [
            {
              label: `Waiting on ${pendingWakeups} thing${pendingWakeups === 1 ? '' : 's'}`,
              click: () => createHome(),
            } as const,
          ]
        : []),
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

/// The menu bar icon: a rounded-square aperture, the same mark the HUD uses, so
/// the two read as one product. A template image, so macOS recolours it for
/// light and dark menu bars and for the highlighted state.
///
/// Two representations rather than one, because a 16pt icon upscaled to a
/// Retina menu bar is visibly soft. And asserted non-empty at startup, because
/// the first version of this constant was a corrupt PNG: `nativeImage` returned
/// a 0x0 image, `new Tray()` accepted it without complaint, and the result was
/// a menu bar item that occupied space and drew nothing. The app was running
/// perfectly and looked, to the only person who mattered, like it had not
/// launched.
const TRAY_ICON_16 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAN0lEQVR42mNggIA+BgaG/yTiPgYKNKMY8p9CPEgNgAcQEugjxQBcYCQZQHEgDrGERHFmoig7AwA7a9XZ/XO6jQAAAABJRU5ErkJggg==';
const TRAY_ICON_32 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgElEQVR42u2X0QmAMBBDM4hr3SBd8hbpIBWlFq2K9OOMSAL5zqOldw1wVALgAEqQvWacNAHIgcG9c81sejN8D9GOvZC8XocTAZZsWvhmAQhg+NnYg1MUwOUIvVGKALABABOAAATwSwD6IKKPYm1DAYQB0L/l9GJCr2afKKe0ej4DuidgUue2pQsAAAAASUVORK5CYII=';

function trayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_16);
  if (icon.isEmpty()) {
    // Nothing here can recover a bad constant, but a loud line beats a silent
    // blank space in the menu bar.
    log.error('tray', 'the menu bar icon did not decode; the tray will be invisible');
  }
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 });
  icon.setTemplateImage(true);
  return icon;
}

function createTray() {
  tray = new Tray(trayIcon());
  // Clicking the icon itself opens the window, rather than only ever dropping
  // the menu: "click the thing, see the thing" is what people expect, and the
  // menu is still one click away on the same item.
  tray.on('click', () => createHome());
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
  standby = new StandbyManager({
    operator,
    spend: engine.spend,
    // The wake check is a structured-output call like the Observer's, so it
    // rides the same client rather than opening a second one — and it is
    // deliberately Anthropic-only for now: §9.1's other providers are for
    // observation and Q&A, and this one drives a decision to take the machine.
    client: () => engine.client(),
    settings: () => settings.get(),
  });
  scheduler.on('signal', (sig) => {
    lastFront = { bundleId: sig.bundleId, windowTitle: sig.windowTitle };
  });
  registerIpc({ scheduler, engine, activation, standby, getState: () => state, setState });
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

  // Standby (PRD §6.6) starts after the sidecar, because its first act on a
  // due wakeup is to capture the screen. Everything it needs to know is in
  // SQLite, so a restart picks up exactly what was pending when buddy quit.
  pendingWakeups = standby.start().length;
  standby.on('change', (w: unknown[]) => {
    pendingWakeups = w.length;
    if (pendingWakeups > 0 && state === 'OBSERVING') setState('STANDBY');
    else if (pendingWakeups === 0 && state === 'STANDBY') setState('OBSERVING');
    updateTray();
  });
  standby.on('resuming', () => setState('ACTING'));
  if (pendingWakeups > 0 && state !== 'ACTING') setState('STANDBY');

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
  operator.on('update', (v) => {
    updateTray();
    // §7.1: `needs_human` is a terminal state with a notification and a
    // preserved log. Latched on the transition so a view emitted twice does not
    // notify twice.
    if (v.status === 'needs_human' && v.id !== notifiedNeedsHuman) {
      notifiedNeedsHuman = v.id;
      notify.needsHuman(v.id, v.goal, v.haltReason ?? v.outcome?.summary ?? 'The run stopped.');
    }
    if (v.status === 'running') notifiedNeedsHuman = 0;
    // A run's own terminal state decides where the app lands; standby is the
    // one that outlives the run.
    if (v.status === 'waiting') {
      pendingWakeups = standby.pending().length;
      setState('STANDBY');
      updateTray();
    }
  });
  settings.on('changed', (next) => {
    scheduler.updateSettings(next);
    engine.updateSettings(next);
    standby.updateSettings(next);
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
  }

  // A menu bar app should not put a window on screen when the machine boots —
  // but somebody who has just double-clicked the app is asking to see it, and
  // an app that answers a double-click with nothing at all reads as broken
  // however well it is running in the background. `wasOpenedAtLogin` is what
  // separates the two, and it is the only thing that should.
  const atLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  if (!perms.screenRecording) {
    log.warn('app', 'Screen Recording not granted; opening the permissions window');
    createHome();
  } else if (!atLogin) {
    createHome();
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

/// macOS sends this when the app is opened again while it is already running —
/// a double-click in Finder, a click in the Dock, `open -a buddy`. Without a
/// handler the event is swallowed and the app appears to do nothing, which is
/// the same symptom as failing to launch. `second-instance` does not cover it:
/// macOS activates the running app rather than starting a second process, so
/// that event never fires on this path.
app.on('activate', () => {
  createHome();
});

app.on('will-quit', async (e) => {
  e.preventDefault();
  log.info('app', 'shutting down');
  operator.stop('stop-button');
  activation?.cancel('dismissed');
  hotkeys.unregisterAll();
  permissions.stop();
  retention.stop();
  // Nothing to persist: every pending wakeup is already a row. That is the
  // whole design (§6.6) — quitting buddy does not make it forget what it was
  // waiting for, and the next launch picks the same rows back up.
  standby?.stop();
  // Ends the session, which triggers a final rollup. It is fire-and-forget:
  // blocking quit on a model call would make buddy feel wedged on exit, and
  // the observations survive to be rolled up at next launch either way.
  engine?.stop();
  scheduler?.stop();
  await sidecar.stop();
  closeDb();
  app.exit(0);
});
