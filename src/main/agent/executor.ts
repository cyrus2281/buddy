import fs from 'node:fs';
import { sidecar } from '../sidecar/supervisor.js';
import { log } from '../log.js';
import { runPaths } from '../store/runs.js';
import { classify, type TargetInfo } from './guardrails.js';
import { ACT_VERBS, type HandsOffTool } from './tools.js';
import type { AxActResult, AxLook } from '../sidecar/supervisor.js';
import type { Allowlist, GhostIntent, GuardVerdict, RunProfile } from '../../shared/types.js';

/// The executor: the one place a `CGEvent` is dispatched, and therefore the one
/// place guardrails are enforced (PRD §7.2).
///
/// Two invariants this file exists to hold:
///
///   1. **Classification happens here, immediately before dispatch** — after the
///      model has chosen an action and after the AX tree has been read, so the
///      facts are current rather than whatever the model believed a turn ago.
///      The model is never asked to police itself.
///   2. **Coordinates are translated in exactly one place.** `screenPoint =
///      origin + modelCoord / scale`. Nothing downstream of `translate()` knows
///      about the model's pixel space, so §6.2's worst failure mode has one
///      possible home and a test that pins it.

export interface Frame {
  /** Path on disk, inside the run's directory. */
  path: string;
  base64: string;
  width: number;
  height: number;
  scale: number;
  originX: number;
  originY: number;
  displayId: number;
}

export type ExecOutcome =
  // `verdict` rides along on success too: the Run Log is the trust surface
  // (PRD §8.5), and "why was this allowed" is as much a part of it as "why was
  // this blocked".
  | { kind: 'ok'; text: string; frame?: Frame; verdict: GuardVerdict }
  /** `verdict` is null only when the call was malformed before anything could
   *  be classified — an element id that is not an id, a verb that is not one. */
  | { kind: 'error'; text: string; verdict: GuardVerdict | null }
  /** A gated action in `attended`: the loop must ask the user and re-dispatch. */
  | { kind: 'gate'; verdict: GuardVerdict }
  /** A denial. The run parks. buddy does not route around it (PRD §7.1). */
  | { kind: 'denied'; verdict: GuardVerdict };

export interface ExecContext {
  runId: number;
  profile: RunProfile;
  allowlist: Allowlist;
  /** The frame the model's coordinates are expressed in. Null before the first
   *  screenshot, which is why the loop takes one before anything else. */
  lastFrame: Frame | null;
  /** Set once a gate has been approved for this exact block, so the re-dispatch
   *  does not ask again. */
  preApproved?: boolean;
}

/** Members that return an image; everything else returns text like "OK"
 *  (PRD §6.3). */
const IMAGE_ACTIONS = new Set(['screenshot', 'zoom']);

const ACTIONS_WITH_COORDINATE = new Set([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'scroll',
]);

/** Where the ghost cursor is told about the next action, and how far ahead.
 *  Null — the default, and what every check that does not ask for it gets — is
 *  no ghost and no delay. */
export interface IntentSink {
  send: (i: Omit<GhostIntent, 'runId'>) => void;
  leadMs: () => number;
}

/** What the ghost previews, and as what. Screenshots, zooms, waits and cursor
 *  reads are not things a person needs warning of. */
const GHOST_KIND: Record<string, GhostIntent['kind']> = {
  left_click: 'click',
  middle_click: 'click',
  triple_click: 'double',
  double_click: 'double',
  right_click: 'right',
  mouse_move: 'move',
  left_mouse_down: 'click',
  left_mouse_up: 'click',
  left_click_drag: 'drag',
  scroll: 'scroll',
  type: 'type',
  key: 'key',
  hold_key: 'key',
};

export class Executor {
  /** Monotonic across the run, so every screenshot has its own file and the Run
   *  Log can show the screen at each step. */
  private frameSeq = 0;

  /** The ghost cursor (`island.ts`). Set by the orchestrator for a shared-hands
   *  run; never consulted by `executeHands`, which must not draw on the
   *  person's screen at all. */
  intents: IntentSink | null = null;

  /** Where the last pointer action went, so a `type` or `key` — which has no
   *  coordinate — is previewed where the text is actually going. */
  private lastPoint: { x: number; y: number } | null = null;

  /** §6.2: `screenPoint = origin + modelCoord / scale`. The only translation in
   *  the product. A scale other than 1.0 means the display did not fit Opus 5's
   *  image ceiling and the frame was shrunk further. */
  static translate(coord: [number, number], frame: Frame): { x: number; y: number } {
    return {
      x: frame.originX + coord[0] / frame.scale,
      y: frame.originY + coord[1] / frame.scale,
    };
  }

  private coordOf(input: Record<string, unknown>, key: string): [number, number] | null {
    const raw = input[key];
    if (Array.isArray(raw) && raw.length >= 2 && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
      return [raw[0], raw[1]];
    }
    return null;
  }

  /** The AX facts the classifier needs, at the point of dispatch. One sidecar
   *  round trip, in the coordinate space `CGEvent` uses. */
  private async targetInfo(screenPoint: { x: number; y: number } | null): Promise<TargetInfo> {
    try {
      return await sidecar.targetInfo(screenPoint ?? undefined);
    } catch (e) {
      // Accessibility is required in M2; without it the AX signal — the one
      // §7.2 ranks first — is simply absent. Report the app as unknown so the
      // allowlist rule fails closed rather than silently passing.
      log.warn('executor', 'target_info failed; guardrails lose the AX signal', {
        error: (e as Error).message,
      });
      return {
        bundleId: '',
        appName: '',
        pid: -1,
        windowTitle: '',
        secureInput: false,
        focused: null,
        url: null,
        element: null,
      };
    }
  }

  /**
   * Classify, then dispatch. Never the other way round, and never both in one
   * expression — the separation is what makes the deny path auditable.
   */
  async execute(action: string, input: Record<string, unknown>, ctx: ExecContext): Promise<ExecOutcome> {
    // `screenshot` and `zoom` are served by the capture path so that one piece
    // of code owns the scale factor. They still get classified: under
    // `unattended` a screenshot of a non-allowlisted app is still a read of it.
    const frame = ctx.lastFrame;

    // Where on screen is this going? Needed before classification, because the
    // AX hit test is what tells us the button says "Send".
    let screenPoint: { x: number; y: number } | null = null;
    if (ACTIONS_WITH_COORDINATE.has(action) && frame) {
      const c = this.coordOf(input, 'coordinate') ?? this.coordOf(input, 'start_coordinate');
      if (c) screenPoint = Executor.translate(c, frame);
    }

    const target = await this.targetInfo(screenPoint);
    const verdict = classify({ action, input, target, allowlist: ctx.allowlist, profile: ctx.profile });
    this.lastFrame = frame;

    if (verdict.decision === 'deny') {
      log.warn('executor', 'action denied', {
        action,
        class: verdict.class,
        signal: verdict.signal,
        target: verdict.target,
      });
      return { kind: 'denied', verdict };
    }
    if (verdict.decision === 'confirm' && !ctx.preApproved) {
      log.info('executor', 'action gated, awaiting the user', { action, class: verdict.class });
      // The ghost waits on the thing being asked about, so the gate's "the
      // Send button" has a place on screen. Only for an ask, never a deny:
      // previewing an action buddy will not take would be showing intent it
      // does not have.
      this.preview(action, input, screenPoint, verdict, true);
      return { kind: 'gate', verdict };
    }

    // ── Dispatch ──────────────────────────────────────────────────────────
    await this.preview(action, input, screenPoint, verdict, false);
    try {
      if (IMAGE_ACTIONS.has(action)) {
        const f = await this.capture(ctx.runId, action === 'zoom' ? this.zoomRegion(input, frame) : null);
        return { kind: 'ok', text: '', frame: f, verdict };
      }

      const params = this.toSidecarParams(action, input, frame);
      const result = await sidecar.input(params);
      return { kind: 'ok', text: this.describe(action, result), verdict };
    } catch (e) {
      const msg = (e as Error).message;
      // Secure Event Input is the error the model most needs stated plainly:
      // the OS swallowed the keystrokes and it must not believe it typed.
      if (msg.includes('secure_event_input_held')) {
        return {
          kind: 'error',
          verdict,
          text:
            msg.replace(/^secure_event_input_held:\s*/, '') +
            ' Ask the user to dismiss the password prompt, or use a non-keyboard approach.',
        };
      }
      return { kind: 'error', text: msg, verdict };
    }
  }

  /**
   * Tell the ghost cursor where this is about to land, then give it time to
   * get there. After classification and before dispatch, so the ghost only
   * ever previews something buddy is actually about to do.
   */
  private async preview(
    action: string,
    input: Record<string, unknown>,
    point: { x: number; y: number } | null,
    verdict: GuardVerdict,
    pending: boolean,
  ): Promise<void> {
    const kind = GHOST_KIND[action];
    if (!this.intents || !kind) return;
    let at = point ?? this.lastPoint;
    let to: { x: number; y: number } | undefined;
    if (action === 'left_click_drag' && point && this.lastFrame) {
      // `execute` resolved `coordinate` — the far end — as the point; the
      // drag starts at `start_coordinate`.
      const start = this.coordOf(input, 'start_coordinate');
      if (start) {
        at = Executor.translate(start, this.lastFrame);
        to = point;
      }
    }
    if (!at) return;
    if (point) this.lastPoint = point;
    const label =
      kind === 'type'
        ? String(input.text ?? '').slice(0, 48)
        : kind === 'key'
          ? String(input.text ?? '')
          : verdict.target && verdict.target !== verdict.appName
            ? verdict.target
            : '';
    const leadMs = pending ? 0 : Math.max(0, this.intents.leadMs());
    try {
      this.intents.send({ kind: pending ? 'pending' : kind, x: at.x, y: at.y, ...(to ? { to } : {}), label, leadMs, at: Date.now() });
    } catch {
      return; // a ghost that cannot be drawn is not a reason to stop a run
    }
    if (leadMs > 0 && (kind !== 'type' && kind !== 'key')) await new Promise((r) => setTimeout(r, leadMs));
  }

  /** The frame the last dispatch translated against, for a drag's far end. */
  private lastFrame: Frame | null = null;

  /** Coordinates leave the model's pixel space here and nowhere else. */
  private toSidecarParams(
    action: string,
    input: Record<string, unknown>,
    frame: Frame | null,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...input, action };
    if (!frame) return out;
    for (const key of ['coordinate', 'start_coordinate']) {
      const c = this.coordOf(input, key);
      if (!c) continue;
      const p = Executor.translate(c, frame);
      out[key] = [p.x, p.y];
    }
    return out;
  }

  /** `zoom` is a crop of the screen, so its region is in the model's pixel
   *  space too and gets the same translation. */
  private zoomRegion(
    input: Record<string, unknown>,
    frame: Frame | null,
  ): { x: number; y: number; w: number; h: number } | null {
    const r = input.region;
    if (!Array.isArray(r) || r.length < 4 || !frame) return null;
    const [x0, y0, x1, y1] = r.map(Number);
    if ([x0, y0, x1, y1].some((n) => !Number.isFinite(n))) return null;
    const a = Executor.translate([x0, y0], frame);
    const b = Executor.translate([x1, y1], frame);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.max(1, Math.abs(b.x - a.x)),
      h: Math.max(1, Math.abs(b.y - a.y)),
    };
  }

  /**
   * A screenshot, written into the run's own directory so the Run Log can show
   * the screen at each step (§8.5) after the frame vault has expired.
   *
   * The scale factor comes back on the capture and travels with the frame — it
   * is never recomputed here, because two places computing it is exactly how it
   * ends up wrong in one of them.
   */
  async capture(runId: number, region: { x: number; y: number; w: number; h: number } | null): Promise<Frame> {
    const idx = this.frameSeq++;
    const path = runPaths.frame(runId, idx);
    fs.mkdirSync(runPaths.dir(runId), { recursive: true, mode: 0o700 });

    const shot = region
      ? await sidecar.capture({ path, target: 'region', region })
      : await sidecar.capture({ path, target: 'display' });

    if (shot.scale !== 1) {
      log.warn('executor', 'coordinate scale is not 1.0 — clicks are being divided by it', {
        scale: shot.scale,
        logical: `${shot.logicalWidth}x${shot.logicalHeight}`,
        sent: `${shot.width}x${shot.height}`,
      });
    }

    return {
      path,
      base64: fs.readFileSync(path).toString('base64'),
      width: shot.width,
      height: shot.height,
      scale: shot.scale,
      originX: shot.originX ?? 0,
      originY: shot.originY ?? 0,
      displayId: shot.displayId,
    };
  }

  // ── Hands-off ───────────────────────────────────────────────────────────

  /**
   * A hands-off tool call: classify, then dispatch — the same classifier and
   * the same enforcement point as `execute`, so a hands-off run is held to
   * exactly the policy a normal one is. What differs is what the guardrail is
   * told it is touching: the element or app the call *names*, read from that
   * app's own accessibility tree, rather than whatever is frontmost or under
   * the pointer. In hands-off the frontmost app is the person's, and checking
   * Slack's Send button against their editor's allowlist entry would be the
   * classifier answering a question nobody asked.
   */
  async executeHands(tool: HandsOffTool, input: Record<string, unknown>, ctx: ExecContext): Promise<ExecOutcome> {
    const fail = (text: string): ExecOutcome => ({ kind: 'error', text, verdict: null });
    const app = typeof input.app === 'string' ? input.app.trim() : '';
    let ref: number | null = null;
    let classAs: string;
    let classInput: Record<string, unknown> = {};
    let verb = '';

    switch (tool) {
      case 'look':
        if (!app) return fail('Name the app to look at by its bundle id.');
        classAs = 'ax_look';
        break;
      case 'act':
        ref = parseRef(input.element);
        verb = String(input.action ?? '');
        if (ref == null) return fail('Name an element from the last look, like "e42".');
        if (!(ACT_VERBS as readonly string[]).includes(verb)) {
          return fail(`"${verb}" is not an action. Use one of: ${ACT_VERBS.join(', ')}.`);
        }
        // Moving focus or scrolling changes nothing a person would undo; every
        // other verb is a click in all but name, and is classified as one.
        classAs = ['focus', 'scroll_to_visible', 'raise'].includes(verb) ? 'ax_focus' : 'ax_press';
        break;
      case 'set_value':
        ref = parseRef(input.element);
        if (ref == null) return fail('Name an element from the last look, like "e42".');
        if (typeof input.text !== 'string') return fail('set_value needs `text`.');
        classAs = 'ax_set_value';
        classInput = { text: input.text };
        break;
      case 'send_keys': {
        if (!app) return fail('Name the app to send keys to by its bundle id.');
        const key = typeof input.key === 'string' && input.key ? input.key : null;
        const text = typeof input.text === 'string' && input.text ? input.text : null;
        if ((key == null) === (text == null)) return fail('Give exactly one of `key` or `text`.');
        // The classifier's own `key` and `type` rules apply unchanged — Return
        // in a messaging app is a send whichever way the keystroke arrives.
        classAs = key ? 'key' : 'type';
        classInput = { text: key ?? text };
        break;
      }
      case 'open':
        if (!app) return fail('Name the app to open by its bundle id.');
        classAs = 'ax_open';
        break;
    }

    let target: TargetInfo;
    try {
      target =
        tool === 'open'
          ? this.openTarget(app, typeof input.url === 'string' ? input.url : null)
          : await sidecar.axTarget(ref != null ? { ref } : { bundleId: app });
    } catch (e) {
      // A stale element or an app that is not running: facts the model can
      // act on (look again, open it), not a guardrail decision.
      return fail(cleanRpcError((e as Error).message));
    }

    const verdict = classify({
      action: classAs,
      input: classInput,
      target,
      allowlist: ctx.allowlist,
      profile: ctx.profile,
    });
    if (verdict.decision === 'deny') {
      log.warn('executor', 'hands-off action denied', { tool, class: verdict.class, target: verdict.target });
      return { kind: 'denied', verdict };
    }
    if (verdict.decision === 'confirm' && !ctx.preApproved) return { kind: 'gate', verdict };

    try {
      switch (tool) {
        case 'look':
          return await this.look(ctx.runId, app, typeof input.window_title === 'string' ? input.window_title : undefined, verdict);
        case 'act': {
          const r = await sidecar.axAct({ ref: ref!, action: verb });
          return { kind: 'ok', text: describeAct(r, verb), verdict };
        }
        case 'set_value': {
          const r = await sidecar.axAct({ ref: ref!, action: 'set_value', value: String(input.text) });
          return { kind: 'ok', text: describeAct(r, 'set_value'), verdict };
        }
        case 'send_keys': {
          const key = typeof input.key === 'string' && input.key ? input.key : undefined;
          const r = await sidecar.keysToApp({ bundleId: app, ...(key ? { key } : { text: String(input.text) }) });
          return {
            kind: 'ok',
            verdict,
            text:
              (key ? `OK — pressed ${key} in ${target.appName || app}.` : `OK — typed ${r.characters ?? 0} characters into ${target.appName || app}.`) +
              (r.stoleFocus ? ' It came to the front in response.' : ''),
          };
        }
        case 'open': {
          const url = typeof input.url === 'string' && input.url ? input.url : undefined;
          const r = await sidecar.openApp({ bundleId: app, ...(url ? { url } : {}) });
          return {
            kind: 'ok',
            verdict,
            text: `OK — opened ${url ? `${url} in ` : ''}${r.appName || app} without bringing it forward. Look at it next.`,
          };
        }
      }
    } catch (e) {
      return { kind: 'error', text: cleanRpcError((e as Error).message), verdict };
    }
  }

  /** What a hands-off run is told is running, one line per app, so its first
   *  `look` names a real bundle id. Windows are listed by title because that
   *  is how a person would say which one. */
  async describeRunningApps(): Promise<string> {
    const { apps } = await sidecar.appWindows();
    return apps
      .filter((a) => a.bundleId && a.windows.length > 0)
      .map((a) => {
        const wins = a.windows
          .filter((w) => w.title)
          .slice(0, 6)
          .map((w) => JSON.stringify(w.title.slice(0, 80)))
          .join(', ');
        return `- ${a.bundleId} — ${a.appName}${a.active ? ' (in front: the person’s)' : ''}${wins ? `: ${wins}` : ''}`;
      })
      .join('\n');
  }

  /** What `open` is classified against. The app may not be running yet, so
   *  this is built from the request rather than read from AX — and only a web
   *  URL is a URL to the domain allowlist; a file path is not a host. */
  private openTarget(bundleId: string, url: string | null): TargetInfo {
    return {
      bundleId,
      appName: bundleId,
      pid: -1,
      windowTitle: '',
      secureInput: false,
      focused: null,
      url: url && /^https?:\/\//i.test(url) ? url : null,
      element: null,
    };
  }

  /** `look`: the tree with element ids, and a picture of just that window —
   *  taken by window id, so a window behind others is photographed as itself
   *  rather than as whatever covers it. */
  private async look(runId: number, bundleId: string, windowTitle: string | undefined, verdict: GuardVerdict): Promise<ExecOutcome> {
    const l = await sidecar.axLook({ bundleId, ...(windowTitle ? { windowTitle } : {}), maxNodes: 900 });
    let frame: Frame | undefined;
    let note = '';
    if (l.windowId && !l.minimized) {
      try {
        frame = await this.captureWindow(runId, l.windowId);
      } catch (e) {
        note = `(No picture: ${cleanRpcError((e as Error).message)} — work from the tree.)`;
      }
    } else {
      note = l.minimized
        ? '(The window is minimised, so there is no picture — the tree still works.)'
        : '(No picture of this window is available — the tree still works.)';
    }
    return { kind: 'ok', text: renderLook(l, note), frame, verdict };
  }

  async captureWindow(runId: number, windowId: number): Promise<Frame> {
    const idx = this.frameSeq++;
    const path = runPaths.frame(runId, idx);
    fs.mkdirSync(runPaths.dir(runId), { recursive: true, mode: 0o700 });
    const shot = await sidecar.capture({ path, target: 'window', windowId });
    return {
      path,
      base64: fs.readFileSync(path).toString('base64'),
      width: shot.width,
      height: shot.height,
      scale: shot.scale,
      originX: shot.originX ?? 0,
      originY: shot.originY ?? 0,
      displayId: shot.displayId,
    };
  }

  /** What the model sees as the tool result for a non-image action. Short on
   *  purpose: "OK" plus the one fact worth knowing (PRD §6.3). */
  private describe(action: string, result: unknown): string {
    const r = (result ?? {}) as Record<string, unknown>;
    if (action === 'cursor_position') return `X=${r.x},Y=${r.y}`;
    if (action === 'type') return `OK — typed ${r.characters ?? 0} characters.`;
    if (action === 'key') return `OK — pressed ${r.key}.`;
    if (action === 'wait') return `OK — waited ${r.duration}s.`;
    return 'OK';
  }

  /** The `describe_focused_window` custom tool (PRD §6.3): the AX tree of the
   *  frontmost window, returned alongside every screenshot so the model targets
   *  a named element instead of guessing a pixel. */
  async describeFocusedWindow(): Promise<string> {
    const tree = (await sidecar.axTree({ depth: 12, maxNodes: 900 })) as {
      appName?: string;
      bundleId?: string;
      truncated?: boolean;
      focused?: unknown;
      tree?: unknown;
    };
    const lines: string[] = [];
    lines.push(`app: ${tree.appName ?? '?'} (${tree.bundleId ?? '?'})`);
    if (tree.focused) lines.push(`focused: ${JSON.stringify(tree.focused)}`);
    if (tree.truncated) lines.push('(tree truncated at the node budget)');
    lines.push('');
    lines.push(renderTree(tree.tree, 0));
    return lines.join('\n');
  }
}

/**
 * The AX tree as indented text rather than JSON.
 *
 * Frames are printed because they are the point: the model reads "AXButton
 * 'Send' at 1204,688" and clicks a named element at a known centre instead of
 * estimating a pixel from a screenshot. Empty structural nodes are collapsed so
 * the useful lines are not buried under fifty `AXGroup`s.
 */
function renderTree(node: unknown, depth: number, opts: { ids?: boolean; frames?: boolean } = {}): string {
  if (!node || typeof node !== 'object' || depth > 14) return '';
  const n = node as Record<string, unknown>;
  const withFrames = opts.frames !== false;
  const id = opts.ids && typeof n.id === 'number' ? `e${n.id} ` : '';
  const role = String(n.role ?? '');
  const subrole = n.subrole ? `/${n.subrole}` : '';
  const name = [n.title, n.description].filter((s) => typeof s === 'string' && s).join(' · ');
  const value = typeof n.value === 'string' && n.value ? ` = ${JSON.stringify(n.value.slice(0, 120))}` : '';
  const f = n.frame as { x: number; y: number; w: number; h: number } | undefined;
  const at =
    f && withFrames ? ` @${Math.round(f.x + f.w / 2)},${Math.round(f.y + f.h / 2)} [${Math.round(f.w)}x${Math.round(f.h)}]` : '';
  const disabled = n.enabled === false ? ' (disabled)' : '';

  const kids = Array.isArray(n.children) ? n.children : [];
  const rendered = kids.map((k) => renderTree(k, depth + 1, opts)).filter(Boolean);

  // A nameless container with one child adds a level of indentation and no
  // information. Hoist through it.
  const isNoise = !name && !value && ['AXGroup', 'AXSplitGroup', 'AXScrollArea', 'AXUnknown'].includes(role);
  if (isNoise && rendered.length <= 1) return rendered.join('\n');

  const self = `${'  '.repeat(depth)}${id}${role}${subrole}${name ? ` "${name}"` : ''}${value}${at}${disabled}`;
  return [self, ...rendered].join('\n');
}

/** A hands-off reading as the model sees it: which app, whether it is in
 *  front, which window, then the tree with ids and without coordinates —
 *  there is no pointer to aim, so pixel centres would be tokens spent on
 *  nothing. */
export function renderLook(l: AxLook, note = ''): string {
  return [
    `app: ${l.appName} (${l.bundleId}) — ${l.active ? 'in front' : 'in the background; it stays there'}`,
    `window: ${JSON.stringify(l.windowTitle)}${l.minimized ? ' (minimised)' : ''}`,
    ...(l.truncated ? ['(tree truncated at the node budget)'] : []),
    ...(note ? [note] : []),
    '',
    renderTree(l.tree, 0, { ids: true, frames: false }),
  ].join('\n');
}

/** `e42`, `42`, or 42 → 42. Anything else is not an element id. */
export function parseRef(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw !== 'string') return null;
  const m = /^\s*e?(\d+)\s*$/i.exec(raw);
  // Ids start at 1; e0 was never issued.
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/** buddyd errors arrive as "code: sentence (code -32603)"; the model needs
 *  the sentence. */
function cleanRpcError(msg: string): string {
  return msg.replace(/\s*\(code -?\d+\)\s*$/, '').replace(/^[a-z_]+:\s*/, '');
}

function describeAct(r: AxActResult, verb: string): string {
  const what = `${r.role || 'element'}${r.title ? ` "${r.title}"` : ''} (e${r.ref})`;
  let text =
    verb === 'set_value'
      ? r.verified
        ? `OK — ${what} now reads what you set.`
        : `The app accepted the value but ${what} now reads ${JSON.stringify((r.value ?? '').slice(0, 120))} — it did not keep it. Focus the field and use send_keys instead.`
      : `OK — ${verb.replace(/_/g, ' ')} on ${what}.`;
  if (r.stoleFocus) {
    text += r.restoredFocus
      ? ` ${r.tookFocusTo || 'The app'} came to the front in response; buddy handed focus back.`
      : ` ${r.tookFocusTo || 'The app'} came to the front in response.`;
  }
  return text;
}
