import type {
  ActionClass,
  Allowlist,
  Decision,
  GuardVerdict,
  RunProfile,
} from '../../shared/types.js';

/// Guardrails (PRD §7.1, §7.2).
///
/// Two halves, deliberately separate:
///
///   `classify()`  — what *is* this action? Pure, synchronous, and given the
///                   AX facts rather than fetching them, so every rule here is
///                   testable without a Mac, a granted permission, or a model.
///   `enforce()`   — what does the profile say about that class? One table.
///                   The second profile is a column, not a second implementation.
///
/// The model is never asked to police itself. Nothing in this file reads a
/// prompt, a thinking block, or a tool_use rationale — only the action about to
/// be dispatched and what the accessibility tree says is under it (§7.4: screen
/// content is data, never instruction).

// ─── The policy matrix (PRD §7.1) ────────────────────────────────────────────

const POLICY: Record<ActionClass, Record<RunProfile, Decision>> = {
  //                          attended     unattended
  read: { attended: 'allow', unattended: 'allow' },
  type_editor: { attended: 'allow', unattended: 'allow' },
  send: { attended: 'confirm', unattended: 'deny' },
  purchase: { attended: 'deny', unattended: 'deny' },
  credentials: { attended: 'deny', unattended: 'deny' },
  delete: { attended: 'confirm', unattended: 'deny' },
  install: { attended: 'confirm', unattended: 'deny' },
  system_settings: { attended: 'confirm', unattended: 'deny' },
  off_allowlist: { attended: 'confirm', unattended: 'deny' },
};

/** `read` and `type_editor` are "allow if app allowlisted" under unattended.
 *  The allowlist check runs first and rewrites the class to `off_allowlist`,
 *  so the table itself stays a plain lookup. */
const ALLOWLIST_GATED: ActionClass[] = ['read', 'type_editor'];

export function enforce(cls: ActionClass, profile: RunProfile): Decision {
  return POLICY[cls][profile];
}

// ─── The AX facts the classifier is given ────────────────────────────────────

export interface AxElement {
  role: string;
  subrole: string;
  title: string;
  description: string;
  value: string;
  help: string;
  isSecureTextField: boolean;
  enabled?: boolean;
  frame?: { x: number; y: number; w: number; h: number };
  parent?: Partial<AxElement>;
}

export interface TargetInfo {
  bundleId: string;
  appName: string;
  pid: number;
  windowTitle: string;
  secureInput: boolean;
  /** The element that currently has keyboard focus. */
  focused: { role: string; subrole: string; title: string; isSecureTextField: boolean } | null;
  /** The page URL of the frontmost browser window, read from the web area. */
  url: string | null;
  /** The element under the action's coordinate, via the app's own hit test. */
  element: AxElement | null;
}

export interface ClassifyInput {
  /** A `computer_toolset_20260801` member name, or a custom tool name. */
  action: string;
  input: Record<string, unknown>;
  target: TargetInfo;
  allowlist: Allowlist;
  profile: RunProfile;
}

// ─── Signal 1: the AX tree (authoritative) ───────────────────────────────────

/** PRD §7.2, fixed wording. Everything this matches is gated or denied; the
 *  split between the two is by reversibility, not by which word matched. */
const GATED_BUTTON = /^(send|post|publish|submit|buy|pay|place order|confirm|delete)/i;

const PURCHASE_WORD = /^(buy|pay|place order)/i;
const DELETE_WORD = /^delete/i;

/** Apps where a bare Return in the composer sends rather than inserts a line.
 *  This is the one send path a button title cannot see. */
const MESSAGING_APPS = new Set([
  'com.tinyspeck.slackmacgap',
  'com.apple.MobileSMS',
  'com.apple.mail',
  'com.hnc.Discord',
  'com.microsoft.teams',
  'com.microsoft.teams2',
  'com.microsoft.Outlook',
  'com.readdle.smartemail-Mac',
  'com.superhuman.electron',
  'ru.keepcoder.Telegram',
  'com.facebook.archon',
  'com.linkedin.LinkedIn',
]);

const SYSTEM_APPS = new Set([
  'com.apple.systempreferences',
  'com.apple.SystemProfiler',
  'com.apple.installer',
  'com.apple.InstallAssistant',
]);

const INSTALLER_APPS = new Set(['com.apple.appstore', 'com.apple.AppStore', 'com.apple.installer']);

const TERMINAL_APPS = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'io.alacritty',
]);

// ─── Signal 3: keystroke content (heuristic) ─────────────────────────────────

const KEY_SHAPES: { re: RegExp; what: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'an API key' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, what: 'a GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: 'a GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/, what: 'a Google API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
];

const INSTALL_SHAPES =
  /(^|[\s;&|])(sudo\s|brew\s+(install|cask)|npm\s+(i|install)\s+(-g|--global)|pnpm\s+add\s+-g|yarn\s+global\s+add|pip3?\s+install|gem\s+install|cargo\s+install|apt(-get)?\s+install|curl\s[^|]*\|\s*(ba|z)?sh)/i;

const DESTRUCTIVE_SHAPES =
  /(^|[\s;&|])(rm\s+-[rRf]|rmdir\s|git\s+push\s+(-f|--force)|git\s+reset\s+--hard|DROP\s+TABLE|TRUNCATE\s+TABLE|shred\s)/i;

/** 13–19 digits that pass Luhn. Group separators are stripped first, so
 *  "4111 1111 1111 1111" is caught and a 16-digit order number is not. */
function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** A BIP-39 seed phrase is 12 or 24 lowercase words with no punctuation. The
 *  shape is distinctive enough without shipping the 2048-word list. */
function looksLikeSeedPhrase(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 15 && words.length !== 18 && words.length !== 24) return false;
  return words.every((w) => /^[a-z]{3,8}$/.test(w));
}

// ─── Action kinds ────────────────────────────────────────────────────────────

const READ_ONLY_ACTIONS = new Set([
  'screenshot',
  'zoom',
  'cursor_position',
  'mouse_move',
  'scroll',
  'wait',
  'describe_focused_window',
]);

const CLICK_ACTIONS = new Set([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
]);

const KEYBOARD_ACTIONS = new Set(['type', 'key', 'hold_key']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Suffix match so `notion.so` covers `www.notion.so` but not `evilnotion.so`. */
export function hostAllowed(url: string | null, domains: string[]): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => {
    const dd = d.toLowerCase().replace(/^\*\./, '');
    return host === dd || host.endsWith('.' + dd);
  });
}

/** An element's best human-readable name. AX scatters it across four
 *  attributes and apps disagree about which one to use. */
export function elementName(el: AxElement | null | undefined): string {
  if (!el) return '';
  return (
    el.title?.trim() ||
    el.description?.trim() ||
    el.help?.trim() ||
    el.parent?.title?.trim() ||
    el.parent?.description?.trim() ||
    ''
  );
}

function keyTokens(combo: string): { mods: Set<string>; key: string } {
  const parts = combo
    .split('+')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : '';
  return { mods: new Set(parts.slice(0, -1)), key };
}

// ─── The classifier ──────────────────────────────────────────────────────────

/**
 * Runs in the executor, immediately before the `CGEvent` is dispatched.
 *
 * Order is PRD §7.2's trust order, and it matters: a deny found by the AX tree
 * must not be softened by a later allowlist rule that happens to like the app.
 * Each rule returns as soon as it fires.
 */
export function classify(c: ClassifyInput): GuardVerdict {
  const { action, input, target, allowlist, profile } = c;
  const el = target.element;
  const name = elementName(el);
  const app = target.appName || target.bundleId || 'the frontmost app';

  const verdict = (cls: ActionClass, signal: GuardVerdict['signal'], reason: string, tgt: string): GuardVerdict => ({
    decision: enforce(cls, profile),
    class: cls,
    reason,
    signal,
    target: tgt,
  });

  // ── 1. AX tree ────────────────────────────────────────────────────────────

  // A password field with focus. Typing into one is a credential action no
  // matter what the model believes it is doing, and clicking into one is the
  // step immediately before that — buddy has no business filling either.
  if (KEYBOARD_ACTIONS.has(action) && (target.focused?.isSecureTextField || target.secureInput)) {
    return verdict(
      'credentials',
      'ax-tree',
      `A secure text field has focus in ${app}. buddy does not type into password fields.`,
      target.focused?.title || 'a password field',
    );
  }
  if (CLICK_ACTIONS.has(action) && el?.isSecureTextField) {
    return verdict(
      'credentials',
      'ax-tree',
      `That click targets a password field in ${app}.`,
      name || 'a password field',
    );
  }

  // A button whose title says what it does. This is the signal PRD §7.2 ranks
  // first, and the regex is the one it fixes.
  if (CLICK_ACTIONS.has(action) && name && GATED_BUTTON.test(name)) {
    const cls: ActionClass = PURCHASE_WORD.test(name)
      ? 'purchase'
      : DELETE_WORD.test(name)
        ? 'delete'
        : 'send';
    return verdict(
      cls,
      'ax-tree',
      `That click targets the “${name}” button in ${app}. ` +
        (cls === 'purchase'
          ? 'buddy never completes a payment.'
          : cls === 'delete'
            ? 'Deleting is hard to undo with nobody watching.'
            : 'A sent message cannot be recalled.'),
      `the “${name}” button`,
    );
  }

  // ── 2. App + domain (authoritative for unattended) ────────────────────────

  // Payment and system surfaces are classified by where they are, not by what
  // is written on them, because a checkout button is often an image.
  if (SYSTEM_APPS.has(target.bundleId) && !READ_ONLY_ACTIONS.has(action)) {
    return verdict('system_settings', 'app-domain', `That acts inside ${app}.`, app);
  }
  if (INSTALLER_APPS.has(target.bundleId) && !READ_ONLY_ACTIONS.has(action)) {
    return verdict('install', 'app-domain', `That installs software through ${app}.`, app);
  }

  // ── 3. Keystroke content (heuristic, but deny-strength) ───────────────────

  if (action === 'type') {
    const text = String(input.text ?? '');
    for (const { re, what } of KEY_SHAPES) {
      if (re.test(text)) {
        return verdict('credentials', 'keystroke-content', `That types ${what}.`, app);
      }
    }
    if (looksLikeCardNumber(text)) {
      return verdict('credentials', 'keystroke-content', 'That types what looks like a card number.', app);
    }
    if (looksLikeSeedPhrase(text)) {
      return verdict('credentials', 'keystroke-content', 'That types what looks like a recovery phrase.', app);
    }
    if (TERMINAL_APPS.has(target.bundleId) && INSTALL_SHAPES.test(text)) {
      return verdict('install', 'keystroke-content', `That runs an install command in ${app}.`, app);
    }
    if (TERMINAL_APPS.has(target.bundleId) && DESTRUCTIVE_SHAPES.test(text)) {
      return verdict('delete', 'keystroke-content', `That runs a destructive command in ${app}.`, app);
    }
  }

  // Return in a message composer is a send that no button title can reveal.
  if (action === 'key') {
    const { mods, key } = keyTokens(String(input.text ?? ''));
    const isEnter = key === 'return' || key === 'enter' || key === 'kp_enter';
    if (isEnter && !mods.has('shift') && MESSAGING_APPS.has(target.bundleId)) {
      return verdict(
        'send',
        'ax-tree',
        `Return in ${app} sends the message rather than adding a line.`,
        app,
      );
    }
    if (isEnter && mods.has('cmd') && MESSAGING_APPS.has(target.bundleId)) {
      return verdict('send', 'ax-tree', `⌘Return sends in ${app}.`, app);
    }
    // ⌘⌫ is "move to Trash" in Finder and most file browsers.
    if ((key === 'delete' || key === 'backspace') && mods.has('cmd')) {
      return verdict('delete', 'ax-tree', `⌘⌫ moves the selection to the Trash in ${app}.`, app);
    }
  }

  // ── 4. Allowlist, for the classes that are otherwise free ─────────────────

  const baseClass: ActionClass = READ_ONLY_ACTIONS.has(action) ? 'read' : 'type_editor';

  if (ALLOWLIST_GATED.includes(baseClass)) {
    // Screenshots and waits are not "in" an app in any meaningful sense; the
    // allowlist governs acting on an app, not looking at the screen.
    const touchesApp = !['screenshot', 'zoom', 'wait', 'cursor_position'].includes(action);
    if (touchesApp && target.bundleId && !allowlist.apps.includes(target.bundleId)) {
      return verdict(
        'off_allowlist',
        'app-domain',
        `${app} is not on this run's allowlist.`,
        target.bundleId,
      );
    }
    // For a browser, the app being allowlisted is not enough — a browser is
    // every site at once.
    if (touchesApp && target.url && !hostAllowed(target.url, allowlist.domains)) {
      let host = target.url;
      try {
        host = new URL(target.url).hostname;
      } catch {
        /* keep the raw string; it still names the thing in the log */
      }
      return verdict('off_allowlist', 'app-domain', `${host} is not on this run's allowlist.`, host);
    }
  }

  return verdict(
    baseClass,
    'action-kind',
    baseClass === 'read' ? `Reads the screen in ${app}.` : `Types into ${app}.`,
    name || app,
  );
}

/** Exposed for the checks and the Settings UI: the matrix as data. */
export const policyMatrix = POLICY;
