/**
 * Shared window chrome for the recorded fixture scenes.
 *
 * These are reconstructions rendered at real frame dimensions, not captures of
 * anybody's live desktop — see `evals/goal-inference/README.md` for exactly what
 * that does and does not prove. The chrome is here because it is most of what
 * makes a screenshot noisy: a menu bar, a traffic-light title bar, a sidebar of
 * things that are not the task, and text at the size the OS actually renders it.
 */

export const FRAME_WIDTH = 1728;
export const FRAME_HEIGHT = 1117;

const MENU_BAR_H = 24;

export function page(opts: {
  /** Menu-bar app name, bolded the way macOS does it. */
  app: string;
  menus?: string[];
  clock: string;
  body: string;
  css?: string;
  /** Page background behind everything, for apps with their own dark shell. */
  bg?: string;
}): string {
  const menus = opts.menus ?? ['File', 'Edit', 'View', 'Window', 'Help'];
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${FRAME_WIDTH}px; height: ${FRAME_HEIGHT}px; overflow: hidden;
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    background: ${opts.bg ?? '#1d1d1f'};
  }
  .menubar {
    height: ${MENU_BAR_H}px; background: rgba(245,245,247,0.92); color: #1d1d1f;
    display: flex; align-items: center; gap: 18px; padding: 0 14px;
    font-size: 13px; border-bottom: 1px solid rgba(0,0,0,0.08);
  }
  .menubar .apple { font-size: 15px; }
  .menubar .app { font-weight: 600; }
  .menubar .spacer { flex: 1; }
  .menubar .status { display: flex; gap: 14px; align-items: center; color: #3a3a3c; }
  .stage { height: ${FRAME_HEIGHT - MENU_BAR_H}px; overflow: hidden; }
  .titlebar { display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 38px; }
  .lights { display: flex; gap: 8px; }
  .light { width: 12px; height: 12px; border-radius: 50%; }
  .r { background: #ff5f57; } .y { background: #febc2e; } .g { background: #28c840; }
  .caret {
    display: inline-block; width: 1.5px; height: 1.1em; background: #2e6fdf;
    vertical-align: text-bottom; margin-left: 1px;
  }
  ${opts.css ?? ''}
</style></head>
<body>
  <div class="menubar">
    <span class="apple">&#63743;</span>
    <span class="app">${opts.app}</span>
    ${menus.map((m) => `<span>${m}</span>`).join('')}
    <span class="spacer"></span>
    <span class="status"><span>100%</span><span>&#9992;</span><span>${opts.clock}</span></span>
  </div>
  <div class="stage">${opts.body}</div>
</body></html>`;
}

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
