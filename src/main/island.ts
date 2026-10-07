import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { log } from './log.js';
import { sidecar } from './sidecar/supervisor.js';
import { settings } from './settings.js';
import { placeIsland, type IslandDisplay, type IslandNotice, type IslandPlacement } from '../shared/island.js';
import type { DisplayInfo, GhostIntent } from '../shared/types.js';

/// The island in the notch, and the ghost cursor (see `shared/island.ts` for
/// what the island says and where it goes).
///
/// Both are windows that must never get in the way, and the properties that
/// guarantee it are set here rather than hoped for:
///
///   - **They never take focus.** `focusable: false` and the `panel` type: a
///     click on the island must not pull the keyboard out of the app the
///     person is typing in, and the ghost is never clickable at all.
///   - **They are click-through until they mean otherwise.** The ghost always;
///     the island everywhere except the shape it is drawing, and only while
///     the pointer is over it (the renderer asks, `setInteractive`).
///   - **They are not in buddy's screenshots.** buddyd leaves every window of
///     this process out of a display capture, so the model never reads its own
///     status pill and never "clicks" its own ghost.

/// The app root: `app.getAppPath()`, which is the project (or the packaged
/// app) — except when a built entry is run directly, as the checks are, where
/// it is the entry's own directory. Walk up to the directory that actually has
/// `out/renderer`, the same way the sidecar supervisor finds buddyd.
function appRoot(): string {
  let dir = app.getAppPath();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'out', 'renderer', 'index.html'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return app.getAppPath();
}
const preload = () => path.join(appRoot(), 'out', 'preload', 'index.mjs');
const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = () => path.join(appRoot(), 'out', 'renderer', 'index.html');

function load(win: BrowserWindow, hash: string) {
  if (devUrl) {
    void win.loadURL(`${devUrl}#${hash}`);
    return;
  }
  const file = rendererFile();
  if (!fs.existsSync(file)) log.error('island', 'the renderer HTML is missing', { expected: file });
  void win.loadFile(file, { hash });
}

function overlayWindow(opts: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const win = new BrowserWindow({
    ...opts,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    // A non-activating panel: shown or clicked, it does not make buddy the
    // active app.
    type: 'panel',
    // Over the menu bar is the whole point of the island.
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: preload(), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // macOS keeps windows out of the menu bar unless asked; setting the bounds
  // after creation, at this level, is what puts the island over it.
  win.setBounds(opts);
  return win;
}

class Island {
  private notch: BrowserWindow | null = null;
  private placement: IslandPlacement | null = null;
  private ghosts = new Map<number, BrowserWindow>();
  private displays: DisplayInfo[] = [];
  private notice: IslandNotice | null = null;
  private started = false;

  /** Called once the sidecar is up: the notch geometry comes from buddyd,
   *  because Electron does not expose `safeAreaInsets`. */
  async start(): Promise<void> {
    this.started = true;
    await this.refreshDisplays();
    screen.on('display-added', () => void this.refreshDisplays());
    screen.on('display-removed', () => void this.refreshDisplays());
    screen.on('display-metrics-changed', () => void this.refreshDisplays());
    settings.on('changed', () => this.reconcile());
    this.reconcile();
  }

  async refreshDisplays(): Promise<void> {
    try {
      this.displays = (await sidecar.displays()).displays;
    } catch (e) {
      log.warn('island', 'could not read displays; the island stays where it was', { error: (e as Error).message });
      return;
    }
    // Ghost overlays are per display and sized to it; a display that changed
    // shape gets a fresh one on its next intent.
    for (const w of this.ghosts.values()) w.destroy();
    this.ghosts.clear();
    this.reconcile();
  }

  /** Bring the windows in line with the settings and the displays. */
  reconcile(): void {
    if (!this.started) return;
    const s = settings.get();
    if (!s.islandEnabled) {
      this.notch?.destroy();
      this.notch = null;
      return;
    }
    const placement = placeIsland(this.displays.map(toIslandDisplay), s.islandPlacement);
    if (!placement) return;
    this.placement = placement;
    if (!this.notch || this.notch.isDestroyed()) {
      this.notch = overlayWindow(placement.window);
      // Click-through until the renderer says the pointer is over the island.
      // `forward` keeps mouse-move events coming so it can say so.
      this.notch.setIgnoreMouseEvents(true, { forward: true });
      this.notch.webContents.on('did-finish-load', () => this.sendPlacement());
      load(this.notch, '/island');
      this.notch.showInactive();
      log.info('island', 'shown', { display: placement.displayId, real: placement.real });
    } else {
      this.notch.setBounds(placement.window);
      this.sendPlacement();
    }
  }

  private sendPlacement() {
    if (this.notch && !this.notch.isDestroyed() && this.placement) {
      this.notch.webContents.send('buddy:islandPlacement', this.placement);
      if (this.notice) this.notch.webContents.send('buddy:islandNotice', this.notice);
    }
  }

  /** The renderer, as the pointer enters or leaves the shape it is drawing. */
  setInteractive(on: boolean) {
    if (!this.notch || this.notch.isDestroyed()) return;
    this.notch.setIgnoreMouseEvents(!on, { forward: true });
  }

  /** A "welcome back", an offer: something the island shows when nothing more
   *  urgent is using it. */
  showNotice(n: IslandNotice | null) {
    this.notice = n;
    if (this.notch && !this.notch.isDestroyed()) this.notch.webContents.send('buddy:islandNotice', n);
  }

  currentNotice(): IslandNotice | null {
    return this.notice;
  }

  current(): { placement: IslandPlacement | null; notice: IslandNotice | null } {
    return { placement: this.placement, notice: this.notice };
  }

  private actions = new Map<string, () => void | Promise<void>>();

  /** A notice's button names an action; whoever posted the notice registers
   *  what it does. Named rather than passed as a callback because the click
   *  arrives over IPC from a renderer, where a function cannot travel. */
  onAction(name: string, fn: () => void | Promise<void>) {
    this.actions.set(name, fn);
  }

  async runAction(name: string): Promise<void> {
    const fn = this.actions.get(name);
    if (!fn) {
      log.warn('island', 'no such action', { name });
      return;
    }
    await fn();
  }

  // ── The ghost cursor ──────────────────────────────────────────────────────

  /** One intent, routed to the overlay on the display it lands on, in that
   *  overlay's own coordinates. */
  intent(i: GhostIntent): void {
    if (!settings.get().ghostCursor) return;
    const d = this.displays.find((x) => inside(i, x)) ?? this.displays.find((x) => x.isMain);
    if (!d) return;
    const win = this.ghostFor(d);
    const local = {
      ...i,
      x: i.x - d.originX,
      y: i.y - d.originY,
      ...(i.to ? { to: { x: i.to.x - d.originX, y: i.to.y - d.originY } } : {}),
    };
    const send = () => win.webContents.send('buddy:intent', local);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  }

  private ghostFor(d: DisplayInfo): BrowserWindow {
    const existing = this.ghosts.get(d.id);
    if (existing && !existing.isDestroyed()) return existing;
    const win = overlayWindow({ x: d.originX, y: d.originY, width: d.width, height: d.height });
    // Never interactive. A ghost that could be clicked would be a second,
    // invisible thing between the person and their screen.
    win.setIgnoreMouseEvents(true);
    load(win, '/ghost');
    win.showInactive();
    this.ghosts.set(d.id, win);
    return win;
  }

  stop() {
    this.notch?.destroy();
    this.notch = null;
    for (const w of this.ghosts.values()) w.destroy();
    this.ghosts.clear();
  }
}

function inside(p: { x: number; y: number }, d: DisplayInfo): boolean {
  return p.x >= d.originX && p.x < d.originX + d.width && p.y >= d.originY && p.y < d.originY + d.height;
}

export function toIslandDisplay(d: DisplayInfo): IslandDisplay {
  return {
    id: d.id,
    x: d.originX,
    y: d.originY,
    width: d.width,
    height: d.height,
    notch: d.notch ?? null,
    menuBarHeight: d.menuBarHeight ?? 0,
    builtIn: !!d.builtIn,
    isMain: d.isMain,
  };
}

export const island = new Island();
