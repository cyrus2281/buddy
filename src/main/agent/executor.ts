import fs from 'node:fs';
import { sidecar } from '../sidecar/supervisor.js';
import { log } from '../log.js';
import { runPaths } from '../store/runs.js';
import { classify, type TargetInfo } from './guardrails.js';
import type { Allowlist, GuardVerdict, RunProfile } from '../../shared/types.js';

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
  | { kind: 'error'; text: string; verdict: GuardVerdict }
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

export class Executor {
  /** Monotonic across the run, so every screenshot has its own file and the Run
   *  Log can show the screen at each step. */
  private frameSeq = 0;

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
      return { kind: 'gate', verdict };
    }

    // ── Dispatch ──────────────────────────────────────────────────────────
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
function renderTree(node: unknown, depth: number): string {
  if (!node || typeof node !== 'object' || depth > 14) return '';
  const n = node as Record<string, unknown>;
  const role = String(n.role ?? '');
  const subrole = n.subrole ? `/${n.subrole}` : '';
  const name = [n.title, n.description].filter((s) => typeof s === 'string' && s).join(' · ');
  const value = typeof n.value === 'string' && n.value ? ` = ${JSON.stringify(n.value.slice(0, 120))}` : '';
  const f = n.frame as { x: number; y: number; w: number; h: number } | undefined;
  const at = f ? ` @${Math.round(f.x + f.w / 2)},${Math.round(f.y + f.h / 2)} [${Math.round(f.w)}x${Math.round(f.h)}]` : '';
  const disabled = n.enabled === false ? ' (disabled)' : '';

  const kids = Array.isArray(n.children) ? n.children : [];
  const rendered = kids.map((k) => renderTree(k, depth + 1)).filter(Boolean);

  // A nameless container with one child adds a level of indentation and no
  // information. Hoist through it.
  const isNoise = !name && !value && ['AXGroup', 'AXSplitGroup', 'AXScrollArea', 'AXUnknown'].includes(role);
  if (isNoise && rendered.length <= 1) return rendered.join('\n');

  const self = `${'  '.repeat(depth)}${role}${subrole}${name ? ` "${name}"` : ''}${value}${at}${disabled}`;
  return [self, ...rendered].join('\n');
}
