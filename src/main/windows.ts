import { BrowserWindow, screen, shell, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { log } from './log.js';

/// The two windows. The HUD is the one that matters (PRD §8.1): frameless,
/// always-on-top, vibrant, centred, ~560 px. Home is a normal window.

/// Where the preload script and the renderer's HTML actually are.
///
/// **Resolved from `app.getAppPath()`, never from `import.meta.url`**, and that
/// is a bug fix rather than a preference. The obvious version —
/// `path.dirname(fileURLToPath(import.meta.url))` plus `../preload` — is
/// correct exactly while this module is bundled into `out/main/index.js`, and
/// silently wrong the moment rollup decides to hoist it into
/// `out/main/chunks/`. Then the base is one directory deeper, `../preload`
/// resolves to `out/main/preload`, and the packaged app opens a window that
/// paints nothing: `ERR_FILE_NOT_FOUND` for the HTML and `ERR_MODULE_NOT_FOUND`
/// for the preload, both only in the renderer's console where nothing is
/// watching.
///
/// What decides the hoist is how many modules import this one — M4 added
/// `notify.ts`, which made it two — so the correctness of the path depended on
/// a bundler heuristic reacting to an unrelated file. `app.getAppPath()` is the
/// app root in a packaged build and the project root in development, and it
/// does not move.
const appRoot = () => app.getAppPath();

const preload = () => path.join(appRoot(), 'out', 'preload', 'index.mjs');
const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = () => path.join(appRoot(), 'out', 'renderer', 'index.html');

export const HUD_WIDTH = 560;
const HUD_HEIGHT = 420;

let hud: BrowserWindow | null = null;
let home: BrowserWindow | null = null;
let hudSticky: () => boolean = () => false;

/** Set by the orchestrator wiring: true while a run is live. */
export function setHudSticky(fn: () => boolean) {
  hudSticky = fn;
}

function load(win: BrowserWindow, hash: string) {
  if (devUrl) {
    void win.loadURL(`${devUrl}#${hash}`);
    return;
  }
  const file = rendererFile();
  // A window that fails to load its HTML is a black rectangle with a title bar,
  // and the error goes to a renderer console nobody has open. Say it where the
  // app's own log will show it.
  if (!fs.existsSync(file)) {
    log.error('windows', 'the renderer HTML is missing; the window will be blank', {
      expected: file,
      appPath: appRoot(),
    });
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error('windows', 'the renderer failed to load', { code, desc, url });
  });
  void win.loadFile(file, { hash });
}

export function createHud(): BrowserWindow {
  if (hud && !hud.isDestroyed()) return hud;

  hud = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    // macOS vibrancy: the glass look §8 asks for, drawn by the OS rather than
    // approximated with a translucent div.
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Above full-screen apps: the hotkey has to work over whatever the user is
  // doing, which is the entire point of it.
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  hud.on('blur', () => {
    // Never auto-dismiss while something is running: the Stop button is on this
    // window, and buddy's own clicks move focus to other apps constantly.
    if (hudSticky()) return;
    if (hud?.isVisible() && !process.env.BUDDY_HUD_STICKY) hideHud();
  });
  hud.on('closed', () => {
    hud = null;
  });

  load(hud, '/hud');
  return hud;
}

/** Centred on the display the pointer is on, a little above centre — a dialog
 *  pinned to true centre reads as lower than centre. */
export function showHud() {
  const win = createHud();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    x: Math.round(x + (width - HUD_WIDTH) / 2),
    y: Math.round(y + height * 0.28),
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
  });
  win.showInactive();
  win.focus();
  win.webContents.send('hud:shown');
  log.debug('hud', 'shown', { display: display.id });
}

/** The HUD grows and shrinks with what it is showing: a goal prompt, a live
 *  step feed, or a collapsed pill. Anchored at the top so the header stays put
 *  while the body changes size, which reads as growth rather than as a jump. */
export function resizeHud(height: number) {
  if (!hud || hud.isDestroyed()) return;
  const next = Math.max(90, Math.min(Math.round(height), 760));
  const b = hud.getBounds();
  if (Math.abs(b.height - next) < 2) return;
  hud.setBounds({ x: b.x, y: b.y, width: HUD_WIDTH, height: next }, false);
}

export function hideHud() {
  if (hud && !hud.isDestroyed() && hud.isVisible()) {
    hud.webContents.send('hud:hidden');
    hud.hide();
    log.debug('hud', 'hidden');
  }
}

export function toggleHud() {
  if (hud && !hud.isDestroyed() && hud.isVisible()) hideHud();
  else showHud();
}

export function isHudVisible(): boolean {
  return !!hud && !hud.isDestroyed() && hud.isVisible();
}

/**
 * Home, brought to the front.
 *
 * The `app.focus({ steal: true })` is not a flourish. buddy runs under the
 * `accessory` activation policy (no Dock icon, PRD §8), and an accessory app
 * does not become the active application on its own — so `show()` alone puts
 * the window on screen *behind* whatever the user is looking at. From the
 * user's side that is indistinguishable from the window never having opened,
 * which is exactly the bug this function used to have.
 */
export function createHome(): BrowserWindow {
  if (home && !home.isDestroyed()) {
    home.show();
    home.focus();
    app.focus({ steal: true });
    log.debug('home', 'raised the existing window');
    return home;
  }
  home = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  home.once('ready-to-show', () => {
    home?.show();
    app.focus({ steal: true });
    log.info('home', 'window opened');
  });
  home.on('closed', () => {
    home = null;
  });

  // Anything that isn't buddy opens in the user's browser, not in a chromeless
  // Electron window with node preloaded.
  home.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  load(home, '/');
  return home;
}

export function getHome(): BrowserWindow | null {
  return home && !home.isDestroyed() ? home : null;
}

export function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
