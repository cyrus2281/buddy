import { EventEmitter } from 'node:events';
import { kv } from './store/db.js';
import { log } from './log.js';
import { DEFAULT_SETTINGS, type ExclusionRule, type Settings } from '../shared/types.js';

/// Settings live in SQLite as one JSON blob per key. Never secrets — those go
/// through safeStorage (PRD §7.5), and the type system helps by not having a
/// field for them here.

const KEY = 'settings.v1';

/** Key names Electron's accelerator parser does not accept, and what it wants
 *  instead. A stored `Control+Shift+Period` is a perfectly reasonable spelling
 *  of ⌃⇧. and only fails because Electron takes the punctuation character
 *  itself — and when the accelerator that fails is the abort hotkey, the cost
 *  is a kill switch that silently does not exist (PRD §7.3). */
const KEY_ALIASES: Record<string, string> = {
  period: '.',
  comma: ',',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  apostrophe: "'",
  grave: '`',
  backtick: '`',
  minus: '-',
  hyphen: '-',
  equal: '=',
  equals: '=',
  leftbracket: '[',
  rightbracket: ']',
  option: 'Alt',
  opt: 'Alt',
  cmd: 'Command',
  ctrl: 'Control',
  meta: 'Command',
  super: 'Command',
  esc: 'Escape',
};

/** Rewrites an accelerator into the spelling Electron accepts, or returns it
 *  unchanged. Deliberately conservative: it renames tokens, never reorders or
 *  drops them, so a combination it does not understand is passed through to
 *  fail loudly rather than being silently turned into a different one. */
export function normalizeAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const t = part.trim();
      return KEY_ALIASES[t.toLowerCase()] ?? t;
    })
    .join('+');
}

const CLAMPS: Partial<Record<keyof Settings, [number, number]>> = {
  captureIntervalMs: [3_000, 300_000],
  signalIntervalMs: [1_000, 30_000],
  retentionDays: [1, 7],
  phashThreshold: [0, 32],
  idleSkipSeconds: [10, 3_600],
  // M3. The floors are cost controls, not preferences: a 10-second T2 would
  // bill roughly eighteen times the budget PRD §5 sets, and a user who typed it
  // into a number field should not be able to.
  observeIntervalMs: [60_000, 1_800_000],
  observeMinGapMs: [15_000, 600_000],
  rollupIntervalMs: [600_000, 21_600_000],
  sessionIdleMs: [60_000, 3_600_000],
  dailyCapUsd: [0, 50],
  // M4. The budget floors are not preferences either: a run with zero steps is
  // a run that cannot take its opening screenshot, and a user who typed 0 into
  // a number field meant "small", not "broken".
  budgetMaxSteps: [1, 500],
  budgetMaxWallClockMs: [30_000, 7_200_000],
  budgetMaxCostUsd: [0.05, 50],
  // A one-second poll would hammer SQLite for a feature whose unit is minutes;
  // ten minutes would make a five-minute wakeup fire late by half its interval.
  wakePollMs: [2_000, 120_000],
};

class SettingsStore extends EventEmitter {
  private current: Settings = DEFAULT_SETTINGS;

  load(): Settings {
    const stored = kv.get<Partial<Settings>>(KEY, {});
    this.current = this.normalize({ ...DEFAULT_SETTINGS, ...stored });
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    const next = this.normalize({ ...this.current, ...patch });
    this.current = next;
    kv.set(KEY, next);
    log.info('settings', 'updated', { keys: Object.keys(patch) });
    this.emit('changed', next);
    return next;
  }

  /** Out-of-range values are clamped rather than rejected: a 100 ms capture
   *  interval typed into a number field should not be able to melt the disk,
   *  and failing the whole save over one field is worse UX than correcting it. */
  private normalize(s: Settings): Settings {
    const out = { ...s };
    for (const key of ['hotkey', 'abortHotkey'] as const) {
      const fixed = normalizeAccelerator(out[key]);
      if (fixed !== out[key]) {
        log.info('settings', 'accelerator rewritten to a spelling Electron accepts', {
          key,
          from: out[key],
          to: fixed,
        });
        out[key] = fixed;
      }
    }
    for (const [key, [lo, hi]] of Object.entries(CLAMPS) as [keyof Settings, [number, number]][]) {
      const v = out[key] as number;
      const clamped = Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (DEFAULT_SETTINGS[key] as number)));
      if (clamped !== v) log.warn('settings', 'value clamped', { key, from: v, to: clamped });
      (out[key] as number) = clamped;
    }
    out.exclusions = this.mergeExclusions(out.exclusions);
    // M4. Allowlists come from a text area, so blanks and duplicates are
    // normal input rather than corruption — trimmed here so every consumer
    // (the HUD, the executor, the checks) sees the same clean list.
    out.allowlistApps = cleanList(out.allowlistApps);
    // Lowercased *before* deduping, not after: hostnames are case-insensitive,
    // so `NOTION.so` and `notion.so` are one entry, and folding case after the
    // dedupe leaves two rows that render identically.
    out.allowlistDomains = cleanList((out.allowlistDomains ?? []).map((d) => d.toLowerCase()));
    if (out.defaultProfile !== 'attended' && out.defaultProfile !== 'unattended') {
      // §7.1: leashless is never a default. A stored blob that says otherwise —
      // an older version, a hand-edited database — is corrected rather than
      // honoured, because a default is a suggestion made once and then never
      // reconsidered, and that is the one shape this profile must not take.
      log.warn('settings', 'default profile reset; leashless is never a default', {
        from: out.defaultProfile,
      });
      out.defaultProfile = 'attended';
    }
    return out;
  }

  /** Built-in exclusions are re-merged on every load. A user can disable
   *  1Password, but a stored settings blob from an older version must not be
   *  able to make it silently absent. */
  private mergeExclusions(stored: ExclusionRule[] | undefined): ExclusionRule[] {
    const list = Array.isArray(stored) ? [...stored] : [];
    for (const builtin of DEFAULT_SETTINGS.exclusions) {
      const existing = list.find(
        (r) =>
          r.builtin &&
          ((builtin.bundleId && r.bundleId === builtin.bundleId) ||
            (builtin.titlePattern && r.titlePattern === builtin.titlePattern)),
      );
      if (!existing) list.push({ ...builtin });
    }
    return list;
  }
}

function cleanList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

export const settings = new SettingsStore();
