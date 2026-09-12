import { EventEmitter } from 'node:events';
import { kv } from './store/db.js';
import { log } from './log.js';
import { DEFAULT_SETTINGS, type ExclusionRule, type Settings } from '../shared/types.js';

/// Settings live in SQLite as one JSON blob per key. Never secrets — those go
/// through safeStorage (PRD §7.5), and the type system helps by not having a
/// field for them here.

const KEY = 'settings.v1';

const CLAMPS: Partial<Record<keyof Settings, [number, number]>> = {
  captureIntervalMs: [3_000, 300_000],
  signalIntervalMs: [1_000, 30_000],
  retentionDays: [1, 7],
  phashThreshold: [0, 32],
  idleSkipSeconds: [10, 3_600],
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
    for (const [key, [lo, hi]] of Object.entries(CLAMPS) as [keyof Settings, [number, number]][]) {
      const v = out[key] as number;
      const clamped = Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (DEFAULT_SETTINGS[key] as number)));
      if (clamped !== v) log.warn('settings', 'value clamped', { key, from: v, to: clamped });
      (out[key] as number) = clamped;
    }
    out.exclusions = this.mergeExclusions(out.exclusions);
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

export const settings = new SettingsStore();
