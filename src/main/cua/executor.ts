import fs from 'node:fs';
import { sidecar } from '../sidecar/supervisor.js';
import { log } from '../log.js';
import { runPaths } from '../store/runs.js';
import { classify, type AxElement, type TargetInfo } from '../agent/guardrails.js';
import type { ExecContext, ExecOutcome, Frame, IntentSink } from '../agent/executor.js';
import { isCuaTool } from '../agent/tools.js';
import { cuaDriver, type CuaDriver, type CuaToolResult } from './driver.js';
import cuaSchemas from './schemas.json';
import type { GuardVerdict } from '../../shared/types.js';

/// The executor for the cua backend: cua-driver's tools in, the same
/// `ExecOutcome` out as `Executor`, and the same classify-then-dispatch rule —
/// the guardrail runs before every call that reaches cua-driver, never after,
/// and a deny is never dispatched (PRD §7.2).
///
/// **Where the guardrail's facts come from: buddyd, not cua-driver.** Both can
/// describe an element. buddyd is the one that reads `AXSubrole`, and a password
/// field is `AXTextField` + subrole `AXSecureTextField` — cua-driver's snapshot
/// carries no subrole at all (its `AXNode` never reads it), so on its word alone
/// a password field is an ordinary text field. buddyd also reads the browser URL
/// from the web area rather than the address bar, and its answers are the ones
/// both other executors classify against, so a Send button is the same verdict
/// whichever backend reached it. What buddyd is asked is the *target app's own*
/// hit test at the element's screen point (`ax_target {pid, x, y}`), not the
/// system-wide one: in the background the target window is often behind the
/// person's, and the system-wide hit test answers with whatever is on top
/// (measured: Claude's scroll area, for a Calculator button under it).
///
/// cua-driver's own snapshot element is classified as well, and the stricter
/// verdict wins. It can only add a gate, never remove one.
///
/// **One coordinate translation, and it is not for dispatch.** The model's
/// pixels go to cua-driver unchanged: they are pixels of the screenshot
/// cua-driver itself produced and sized, and it reverses its own downscale.
/// buddy never resizes the image. The only mapping buddy computes is
/// `toScreen` — window pixels to screen points — so the guardrail can ask what
/// is at that point. `from_zoom` is not offered, so there is no second space.

/** PRD §6.2's image ceiling. */
export const IMAGE_MAX_LONG_EDGE = 2576;
export const IMAGE_MAX_PIXELS = 3_750_000;

const MAX_TEXT = 12_000;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SnapElement {
  index: number;
  role: string;
  label: string;
  value: string;
  frame: Rect | null;
  shot: Rect | null;
}

interface Snapshot {
  id: string;
  pid: number;
  windowId: number;
  appName: string;
  windowTitle: string;
  bounds: Bounds | null;
  shotW: number;
  shotH: number;
  elements: Map<number, SnapElement>;
  /** Which MCP session took it. A restart of cua-driver ends the session, and
   *  every snapshot and token with it. */
  generation: number;
}

/** What the guardrail is told it is touching. Injected in the checks. */
export type TargetFacts = (q: { pid: number; point?: { x: number; y: number } }) => Promise<TargetInfo>;

export interface CuaExecutorDeps {
  driver?: CuaDriver;
  facts?: TargetFacts;
  /** buddy's own pid, whose windows (the HUD, the island) are never the
   *  opening observation. */
  selfPid?: number;
}

/** The properties the model may send for each tool — the curated schema's,
 *  and nothing else. A hallucinated `scope: "desktop"` would otherwise reach
 *  cua-driver and act on the frontmost app with no pid to classify against. */
const ALLOWED_PROPS = new Map<string, Set<string>>(
  cuaSchemas.tools.map((t) => [t.name, new Set(Object.keys((t.input_schema as { properties?: object }).properties ?? {}))]),
);

const TIMEOUT_MS: Record<string, number> = {
  get_window_state: 30_000,
  launch_app: 45_000,
  type_text: 60_000,
  drag: 20_000,
};

const STRICTNESS = { allow: 0, confirm: 1, deny: 2 } as const;

export class CuaExecutor {
  readonly kind = 'cua' as const;

  /** The orchestrator sets this for every run; the cua backend never draws the
   *  ghost. Its input goes to a window that is often behind the person's, and
   *  a pointer gliding over their editor to preview a click that lands in a
   *  hidden Calculator would be the ghost describing the wrong place. */
  intents: IntentSink | null = null;

  /** When buddy last asked for foreground delivery (or a drag, which is always
   *  foreground on macOS). That input is real HID input, untagged by
   *  `BUDDY_MAGIC`, so the runner discounts the event tap around it. */
  lastForegroundAt = 0;

  private readonly driver: CuaDriver;
  private readonly facts: TargetFacts;
  private readonly selfPid: number;
  private frameSeq = 0;
  private snapshots = new Map<string, Snapshot>();
  /** `pid:windowId` → the snapshot cua-driver currently honours for it. */
  private latest = new Map<string, string>();
  /** `pid:windowId` → bounds in screen points, from any listing that had them. */
  private bounds = new Map<string, Bounds>();
  private generation = 0;

  constructor(deps: CuaExecutorDeps = {}) {
    this.driver = deps.driver ?? cuaDriver;
    this.facts =
      deps.facts ??
      ((q) => sidecar.axTarget(q.point ? { pid: q.pid, x: q.point.x, y: q.point.y } : { pid: q.pid }) as Promise<TargetInfo>);
    this.selfPid = deps.selfPid ?? process.pid;
  }

  /** §6.2's ceiling as a long-edge cap for one window: 2576 px, or less when
   *  the window's aspect would put 2576 over 3.75 MP. */
  static imageCap(b: { width: number; height: number }): number {
    const long = Math.max(b.width, b.height);
    const short = Math.max(1, Math.min(b.width, b.height));
    return Math.floor(Math.min(IMAGE_MAX_LONG_EDGE, Math.sqrt((IMAGE_MAX_PIXELS * long) / short)));
  }

  /** Window-local screenshot pixels → screen points. The guardrail's hit test
   *  needs a screen point; dispatch never goes through here. */
  static toScreen(px: { x: number; y: number }, s: { bounds: Bounds; shotW: number; shotH: number }): { x: number; y: number } {
    return {
      x: s.bounds.x + px.x * (s.bounds.width / s.shotW),
      y: s.bounds.y + px.y * (s.bounds.height / s.shotH),
    };
  }

  /** Cancel whatever cua-driver is doing for this run. The kill switch's path. */
  cancelInFlight(): number {
    return this.driver.cancelInFlight('kill switch');
  }

  // ── The opening observation ───────────────────────────────────────────────

  /**
   * `get_window_state` on the frontmost window that is not buddy's — the cua
   * backend's equivalent of the toolset's opening screenshot. It is not
   * classified, for the reason that one is not: it is buddy looking before
   * the model has asked for anything.
   */
  async observeFrontmost(runId: number): Promise<{ frame: Frame | null; text: string }> {
    const lw = await this.callChecked('list_windows', { on_screen_only: true });
    const windows = asArray(lw.structuredContent?.windows);
    this.rememberBounds(windows);
    const apps = asArray((await this.callChecked('list_apps', {})).structuredContent?.apps);
    const active = apps.find((a) => a.active === true && Number(a.pid) !== this.selfPid);

    const candidates = windows.filter(
      (w) =>
        Number(w.pid) !== this.selfPid &&
        !/^cua ?driver$/i.test(String(w.app_name ?? '')) &&
        num(rec(w.bounds).width) >= 120 &&
        num(rec(w.bounds).height) >= 80,
    );
    const byZ = (a: Record<string, unknown>, b: Record<string, unknown>) => num(b.z_index, -1) - num(a.z_index, -1);
    const pick =
      candidates.filter((w) => active && Number(w.pid) === Number(active.pid)).sort(byZ)[0] ?? candidates.sort(byZ)[0];

    const list = renderWindows(candidates.slice(0, 20));
    if (!pick) {
      return { frame: null, text: `No window is on screen to look at.\n\nWindows:\n${list}` };
    }
    const shot = await this.windowState(runId, Number(pick.pid), Number(pick.window_id), {});
    if (shot.isError) {
      return { frame: null, text: `${shot.text}\n\nWindows on screen:\n${list}` };
    }
    return { frame: shot.frame, text: `${shot.text}\n\nOther windows on screen:\n${list}` };
  }

  // ── Classify, then dispatch ────────────────────────────────────────────────

  async execute(tool: string, rawInput: Record<string, unknown>, ctx: ExecContext): Promise<ExecOutcome> {
    if (!isCuaTool(tool)) return { kind: 'error', text: `Unknown tool: ${tool}`, verdict: null };
    const allowed = ALLOWED_PROPS.get(tool)!;
    const input = Object.fromEntries(Object.entries(rawInput).filter(([k]) => allowed.has(k)));

    // ── Where is this going? ────────────────────────────────────────────────
    const where = this.resolve(tool, input);
    if ('problem' in where) return { kind: 'error', text: where.problem, verdict: null };

    // ── What is there? (buddyd, the target app's own hit test) ─────────────
    let target: TargetInfo;
    if (tool === 'launch_app') {
      const urls = Array.isArray(input.urls) ? input.urls.map(String) : [];
      target = openTarget(String(input.bundle_id ?? ''), urls.find((u) => /^https?:\/\//i.test(u)) ?? null);
    } else if (where.pid == null) {
      target = emptyTarget();
    } else {
      try {
        target = await this.facts({ pid: where.pid, ...(where.point ? { point: where.point } : {}) });
      } catch (e) {
        // Fail closed. Without buddyd's reading there is no AX signal, no
        // bundle id for the allowlist, and no way to see a password field —
        // and the cua backend acts on windows the person may not be looking at.
        log.warn('cua', 'guardrail facts unavailable; not dispatching', { tool, error: (e as Error).message });
        return {
          kind: 'error',
          verdict: null,
          text:
            `buddy could not read what this would touch (${(e as Error).message}), so it did not act. ` +
            'The guardrails need buddyd’s accessibility reading of the target app.',
        };
      }
    }

    const verdict = this.verdictFor(tool, input, target, where.element, ctx);
    if (verdict.decision === 'deny') {
      log.warn('cua', 'action denied', { tool, class: verdict.class, signal: verdict.signal, target: verdict.target });
      return { kind: 'denied', verdict };
    }
    if (verdict.decision === 'confirm' && !ctx.preApproved) {
      log.info('cua', 'action gated, awaiting the user', { tool, class: verdict.class });
      return { kind: 'gate', verdict };
    }

    // ── Dispatch ────────────────────────────────────────────────────────────
    try {
      if (tool === 'get_window_state') {
        const r = await this.windowState(ctx.runId, Number(input.pid), Number(input.window_id), input);
        return r.isError
          ? { kind: 'error', text: r.text, verdict }
          : { kind: 'ok', text: r.text, verdict, ...(r.frame ? { frame: r.frame } : {}) };
      }
      if (input.delivery_mode === 'foreground' || tool === 'drag') this.lastForegroundAt = Date.now();
      const res = await this.driver.call(tool, input, TIMEOUT_MS[tool] ?? 30_000);
      if (res.isError) return { kind: 'error', text: this.refusalText(res), verdict };
      if (tool === 'zoom') {
        const frame = this.saveImage(ctx.runId, res, null);
        return { kind: 'ok', text: textOf(res).slice(0, MAX_TEXT) || 'Zoomed.', verdict, ...(frame ? { frame } : {}) };
      }
      if (tool === 'list_windows') this.rememberBounds(asArray(res.structuredContent?.windows));
      if (tool === 'launch_app') this.rememberBounds(asArray(res.structuredContent?.windows), Number(res.structuredContent?.pid));
      return { kind: 'ok', text: this.describe(tool, res), verdict };
    } catch (e) {
      return { kind: 'error', text: (e as Error).message, verdict };
    }
  }

  /**
   * Every classification this call amounts to, and the strictest of them.
   *
   * A `type_text` at `x,y` is a click and then typing, so it is both. A key is
   * a key (Return in Slack sends) and also text (the content rules). And the
   * element is read twice — buddyd's hit test and cua-driver's snapshot entry —
   * and either one naming a Send button gates it.
   */
  private verdictFor(
    tool: string,
    input: Record<string, unknown>,
    base: TargetInfo,
    snapEl: SnapElement | null,
    ctx: ExecContext,
  ): GuardVerdict {
    const hasXY = typeof input.x === 'number' && typeof input.y === 'number';
    const aimed = typeof input.element_token === 'string' || hasXY;
    const asAx: AxElement | null = snapEl
      ? {
          role: snapEl.role,
          subrole: '',
          title: snapEl.label,
          description: '',
          value: snapEl.value,
          help: '',
          isSecureTextField: snapEl.role === 'AXSecureTextField',
          ...(snapEl.frame ? { frame: snapEl.frame } : {}),
        }
      : null;
    const elements = [base.element, asAx].filter((e): e is AxElement => !!e);
    if (!elements.length) elements.push(null as unknown as AxElement);

    const calls: { action: string; input: Record<string, unknown>; keyboard?: boolean }[] = [];
    const keys = (arr: unknown) => (Array.isArray(arr) ? arr.map(String) : []);
    switch (tool) {
      case 'get_window_state':
        calls.push({ action: 'ax_look', input: {} });
        break;
      case 'list_apps':
      case 'list_windows':
        calls.push({ action: 'screenshot', input: {} });
        break;
      case 'zoom':
        calls.push({ action: 'zoom', input: {} });
        break;
      case 'scroll':
        calls.push({ action: 'scroll', input: {} });
        break;
      case 'click':
        calls.push({ action: input.button === 'right' || input.action === 'show_menu' ? 'right_click' : 'left_click', input: {} });
        break;
      case 'double_click':
        calls.push({ action: 'double_click', input: {} });
        break;
      case 'right_click':
        calls.push({ action: 'right_click', input: {} });
        break;
      case 'drag':
        calls.push({ action: 'left_click_drag', input: {} });
        break;
      case 'type_text':
        calls.push({ action: 'type', input: { text: String(input.text ?? '') }, keyboard: true });
        if (hasXY) calls.push({ action: 'left_click', input: {} });
        break;
      case 'press_key': {
        const combo = [...keys(input.modifiers), String(input.key ?? '')].join('+');
        calls.push({ action: 'key', input: { text: combo }, keyboard: true });
        calls.push({ action: 'type', input: { text: String(input.key ?? '') }, keyboard: true });
        if (hasXY) calls.push({ action: 'left_click', input: {} });
        break;
      }
      case 'hotkey': {
        const combo = keys(input.keys).join('+');
        calls.push({ action: 'key', input: { text: combo }, keyboard: true });
        calls.push({ action: 'type', input: { text: combo }, keyboard: true });
        if (hasXY) calls.push({ action: 'left_click', input: {} });
        break;
      }
      case 'launch_app':
        calls.push({ action: 'ax_open', input: {} });
        break;
    }

    let worst: GuardVerdict | null = null;
    for (const c of calls) {
      for (const el of elements) {
        // Keys and text go to the element the call names when it names one —
        // that element is what cua-driver focuses and writes — and otherwise
        // to whatever has focus in *that* app.
        const focused =
          c.keyboard && aimed && el
            ? { role: el.role, subrole: el.subrole, title: el.title, isSecureTextField: el.isSecureTextField }
            : base.focused;
        const v = classify({
          action: c.action,
          input: c.input,
          target: { ...base, element: el ?? null, focused },
          allowlist: ctx.allowlist,
          profile: ctx.profile,
        });
        if (!worst || STRICTNESS[v.decision] > STRICTNESS[worst.decision]) worst = v;
      }
    }
    return worst!;
  }

  /** The pid, the screen point and the snapshot element a call is aimed at —
   *  or why buddy cannot tell, which is reported rather than dispatched. */
  private resolve(
    tool: string,
    input: Record<string, unknown>,
  ): { pid: number | null; point: { x: number; y: number } | null; element: SnapElement | null } | { problem: string } {
    const token = typeof input.element_token === 'string' ? input.element_token : null;
    let pid = typeof input.pid === 'number' ? input.pid : null;

    if (token) {
      const [snapId, idx] = token.split(':');
      const snap = this.snapshots.get(snapId);
      const current = snap && this.latest.get(`${snap.pid}:${snap.windowId}`) === snapId && snap.generation === this.driver.generation;
      if (!snap || !current) {
        return {
          problem:
            `element_token ${token} is stale or was never issued: ` +
            (snap
              ? `a newer get_window_state replaced snapshot ${snapId}. `
              : 'it is not from a get_window_state buddy has seen in this run. ') +
            'Call get_window_state again and use a token from it.',
        };
      }
      const el = snap.elements.get(Number(idx)) ?? null;
      if (!el) {
        // cua-driver would take it — a filtered snapshot stays whole on its
        // side — but buddy cannot classify an element it was never shown, and
        // a Send button that was filtered out must not slip past the gate.
        return {
          problem:
            `Element ${idx} was not in what snapshot ${snapId} returned (a query, max_elements or max_depth ` +
            'left it out), and buddy only acts on elements it has seen. Take a snapshot that includes it.',
        };
      }
      if (pid != null && pid !== snap.pid) {
        return { problem: `element_token ${token} belongs to pid ${snap.pid}, not ${pid}.` };
      }
      pid = snap.pid;
      const point = el.frame ? { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 } : null;
      return { pid, point, element: el };
    }

    const xy = (k1: string, k2: string) =>
      typeof input[k1] === 'number' && typeof input[k2] === 'number' ? { x: input[k1] as number, y: input[k2] as number } : null;
    const px = tool === 'drag' ? xy('from_x', 'from_y') : xy('x', 'y');
    if (tool === 'zoom' && pid == null) pid = this.pidOfWindow(Number(input.window_id));
    if (!px || tool === 'zoom') return { pid, point: null, element: null };

    if (pid == null) return { problem: 'Pass `pid` with pixel coordinates.' };
    const snap = this.snapshotFor(pid, typeof input.window_id === 'number' ? input.window_id : null);
    if (!snap || !snap.bounds || !snap.shotW || !snap.shotH) {
      return {
        problem:
          'Pixel coordinates are read off a get_window_state screenshot, and buddy has none for that window ' +
          'in this run' +
          (typeof input.window_id === 'number' ? '' : ' (or the app has several windows — pass `window_id`)') +
          '. Call get_window_state first.',
      };
    }
    const point = CuaExecutor.toScreen(px, { bounds: snap.bounds, shotW: snap.shotW, shotH: snap.shotH });
    return { pid, point, element: elementAt(snap, px) };
  }

  // ── get_window_state ─────────────────────────────────────────────────────

  /** One snapshot: sized to the image ceiling, its frame saved into the run
   *  directory for the Run Log, its elements kept for the guardrail. */
  private async windowState(
    runId: number,
    pid: number,
    windowId: number,
    input: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; frame: Frame | null }> {
    let b = this.bounds.get(`${pid}:${windowId}`);
    if (!b) {
      const lw = await this.driver.call('list_windows', { pid }, 15_000).catch(() => null);
      if (lw && !lw.isError) this.rememberBounds(asArray(lw.structuredContent?.windows));
      b = this.bounds.get(`${pid}:${windowId}`);
    }
    const args: Record<string, unknown> = { ...input, pid, window_id: windowId };
    // Without bounds the cap is the long-edge limit alone; the area check
    // after the capture says so loudly if that was not enough.
    args.max_image_dimension = b ? CuaExecutor.imageCap(b) : IMAGE_MAX_LONG_EDGE;
    const timeout = Math.max(TIMEOUT_MS.get_window_state, num(input.timeout_ms) + 10_000);
    log.debug('cua', 'get_window_state', { pid, windowId, cap: args.max_image_dimension, bounds: b ?? null });
    const res = await this.driver.call('get_window_state', args, timeout);
    if (res.isError) return { isError: true, text: this.refusalText(res), frame: null };

    const sc = res.structuredContent ?? {};
    const snap = this.remember(sc);
    const frame = this.saveImage(runId, res, snap);
    const bnds = snap?.bounds;
    const lines = [
      `app: ${String(sc.app_name ?? '?')} — pid ${pid}, window ${windowId} ${JSON.stringify(String(sc.window_title ?? ''))}`,
      ...(snap
        ? [`snapshot ${snap.id}: the element_token for [N] below is ${snap.id}:N. A newer get_window_state of this window makes these stale.`]
        : []),
      frame && bnds
        ? `screenshot ${frame.width}×${frame.height} px of a ${Math.round(bnds.width)}×${Math.round(bnds.height)} pt window — pixel x,y are read off this image.`
        : 'no screenshot came back for this window; work from the tree.',
      '',
      textOf(res),
    ];
    return { isError: false, text: lines.join('\n').slice(0, MAX_TEXT), frame };
  }

  private remember(sc: Record<string, unknown>): Snapshot | null {
    const id = typeof sc.snapshot_id === 'string' ? sc.snapshot_id : null;
    if (!id) return null;
    for (const old of asArray(sc.invalidated_snapshot_ids)) this.snapshots.delete(String(old));
    const wb = rec(sc.window_bounds);
    const bounds: Bounds | null =
      Number.isFinite(num(wb.width, NaN)) && num(wb.width) > 0
        ? { x: num(wb.x), y: num(wb.y), width: num(wb.width), height: num(wb.height) }
        : null;
    const pid = num(sc.pid);
    const windowId = num(sc.window_id);
    if (bounds) this.bounds.set(`${pid}:${windowId}`, bounds);
    const elements = new Map<number, SnapElement>();
    for (const e of asArray(sc.elements)) {
      const idx = num(e.element_index, -1);
      if (idx < 0) continue;
      elements.set(idx, {
        index: idx,
        role: String(e.role ?? ''),
        label: String(e.label ?? ''),
        value: String(e.value ?? ''),
        frame: rect(e.frame),
        shot: rect(e.screenshot_frame),
      });
    }
    const snap: Snapshot = {
      id,
      pid,
      windowId,
      appName: String(sc.app_name ?? ''),
      windowTitle: String(sc.window_title ?? ''),
      bounds: bounds ?? this.bounds.get(`${pid}:${windowId}`) ?? null,
      shotW: num(sc.screenshot_width),
      shotH: num(sc.screenshot_height),
      elements,
      generation: this.driver.generation,
    };
    this.snapshots.set(id, snap);
    this.latest.set(`${pid}:${windowId}`, id);
    return snap;
  }

  private snapshotFor(pid: number, windowId: number | null): Snapshot | null {
    if (windowId != null) {
      const id = this.latest.get(`${pid}:${windowId}`);
      const s = id ? this.snapshots.get(id) : undefined;
      return s && s.generation === this.driver.generation ? s : null;
    }
    const mine = [...this.latest.entries()].filter(([k]) => k.startsWith(`${pid}:`));
    if (mine.length !== 1) return null;
    const s = this.snapshots.get(mine[0][1]);
    return s && s.generation === this.driver.generation ? s : null;
  }

  private pidOfWindow(windowId: number): number | null {
    for (const k of this.latest.keys()) {
      const [p, w] = k.split(':').map(Number);
      if (w === windowId) return p;
    }
    for (const k of this.bounds.keys()) {
      const [p, w] = k.split(':').map(Number);
      if (w === windowId) return p;
    }
    return null;
  }

  private rememberBounds(windows: Record<string, unknown>[], pidHint?: number) {
    for (const w of windows) {
      const b = rec(w.bounds);
      const pid = num(w.pid, pidHint ?? NaN);
      if (!Number.isFinite(pid) || !(num(b.width) > 0)) continue;
      this.bounds.set(`${pid}:${num(w.window_id)}`, { x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height) });
    }
  }

  /** The image in a result, written into the run's directory so the Run Log
   *  shows the screen at every step, as it does for the toolset (§8.5). */
  private saveImage(runId: number, res: CuaToolResult, snap: Snapshot | null): Frame | null {
    const img = res.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    if (!img) return null;
    const mediaType = img.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const p = runPaths.frame(runId, this.frameSeq++).replace(/\.png$/, mediaType === 'image/jpeg' ? '.jpg' : '.png');
    fs.mkdirSync(runPaths.dir(runId), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(img.data, 'base64');
    fs.writeFileSync(p, bytes);
    const { width, height } = imageSize(bytes, mediaType);
    if (Math.max(width, height) > IMAGE_MAX_LONG_EDGE || width * height > IMAGE_MAX_PIXELS) {
      log.error('cua', 'a frame exceeds the model image ceiling — coordinates will not mean what the model thinks', {
        width,
        height,
      });
    }
    const scale = snap?.bounds && width ? width / snap.bounds.width : 1;
    return {
      path: p,
      base64: img.data,
      width,
      height,
      // Pixels per screen point. 2 is a Retina window sent whole; less means
      // it was capped to fit the ceiling. cua-driver maps it back on dispatch.
      scale,
      originX: snap?.bounds?.x ?? 0,
      originY: snap?.bounds?.y ?? 0,
      displayId: 0,
      mediaType,
    };
  }

  // ── Results, in words ────────────────────────────────────────────────────

  private refusalText(res: CuaToolResult): string {
    const sc = res.structuredContent ?? {};
    const code = String(rec(sc.refusal).code ?? sc.code ?? '');
    let text = textOf(res) || String(rec(sc.refusal).message ?? 'cua-driver refused.');
    if (code === 'stale_element_token') text += ' Call get_window_state again and act on a token from it.';
    return `${code ? `${code}: ` : ''}${text}`.slice(0, MAX_TEXT);
  }

  private describe(tool: string, res: CuaToolResult): string {
    const sc = res.structuredContent ?? {};
    if (tool === 'list_windows') return renderWindows(asArray(sc.windows)).slice(0, MAX_TEXT) || textOf(res);
    if (tool === 'list_apps') {
      const apps = asArray(sc.apps).filter((a) => a.running === true);
      return (
        apps
          .map((a) => `- ${a.bundle_id ?? '?'} — ${a.name ?? '?'} (pid ${a.pid})${a.active ? ' — frontmost (the person’s)' : ''}`)
          .join('\n') || textOf(res)
      ).slice(0, MAX_TEXT);
    }
    if (tool === 'launch_app') {
      const wins = asArray(sc.windows);
      return (
        `OK — launched ${sc.bundle_id ?? sc.name ?? 'the app'} in the background, pid ${sc.pid}. ` +
        (wins.length
          ? `Windows: ${wins.map((w) => `${w.window_id} ${JSON.stringify(String(w.title ?? ''))}`).join(', ')}.`
          : 'No window yet — call list_windows with this pid in a moment.')
      );
    }
    const summary = String(sc.summary ?? '') || textOf(res) || 'OK';
    const effect = typeof sc.effect === 'string' ? sc.effect : null;
    const parts = [summary.slice(0, 600)];
    if (effect === 'suspected_noop') {
      parts.push(
        'effect: suspected_noop — this probably did nothing. Check with get_window_state; if it did not land, ' +
          'repeat the same action with delivery_mode: "foreground".',
      );
    } else if (effect === 'unverifiable') {
      parts.push('effect: unverifiable — confirm from a fresh get_window_state before relying on it.');
    } else if (effect) {
      parts.push(`effect: ${effect}`);
    }
    if (sc.verified === false) parts.push('verified: false');
    return parts.join(' ');
  }

  /** A call buddy makes for itself (the opening), not one the model asked
   *  for. Refusals are failures here, not results. */
  private async callChecked(tool: string, args: Record<string, unknown>): Promise<CuaToolResult> {
    const res = await this.driver.call(tool, args, TIMEOUT_MS[tool] ?? 30_000);
    if (res.isError) throw new Error(this.refusalText(res));
    return res;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function textOf(res: CuaToolResult): string {
  return res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function rect(v: unknown): Rect | null {
  const r = rec(v);
  return typeof r.x === 'number' && typeof r.y === 'number' && typeof r.w === 'number' && typeof r.h === 'number'
    ? { x: r.x, y: r.y, w: r.w, h: r.h }
    : null;
}

/** The smallest snapshot element whose screenshot frame holds the point. */
function elementAt(snap: Snapshot, px: { x: number; y: number }): SnapElement | null {
  let best: SnapElement | null = null;
  for (const e of snap.elements.values()) {
    const f = e.shot;
    if (!f || px.x < f.x || px.y < f.y || px.x > f.x + f.w || px.y > f.y + f.h) continue;
    if (!best || f.w * f.h < best.shot!.w * best.shot!.h) best = e;
  }
  return best;
}

function renderWindows(windows: Record<string, unknown>[]): string {
  return windows
    .map((w) => {
      const b = rec(w.bounds);
      return (
        `- pid ${w.pid} window ${w.window_id} — ${w.app_name ?? '?'} ${JSON.stringify(String(w.title ?? ''))} ` +
        `${Math.round(num(b.width))}×${Math.round(num(b.height))}${w.is_on_screen === false ? ' (off screen)' : ''}`
      );
    })
    .join('\n');
}

function emptyTarget(): TargetInfo {
  return { bundleId: '', appName: '', pid: -1, windowTitle: '', secureInput: false, focused: null, url: null, element: null };
}

/** What `launch_app` is classified against: the app named, which may not be
 *  running yet — the same shape hands-off's `open` uses. */
function openTarget(bundleId: string, url: string | null): TargetInfo {
  return { ...emptyTarget(), bundleId, appName: bundleId, url };
}

/** Width and height from the image header, without decoding it. */
export function imageSize(b: Buffer, mediaType: string): { width: number; height: number } {
  if (mediaType === 'image/png' && b.length >= 24 && b.readUInt32BE(12) === 0x49484452) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (mediaType === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}
