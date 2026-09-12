import { globalShortcut } from 'electron';
import { log } from './log.js';

/// The activation hotkey (⌥⌘Space) and the abort hotkey (⌥⌘.), both rebindable.
///
/// Registration is reported honestly: `globalShortcut.register` returns false
/// when another app already owns the combination, and a hotkey that silently
/// does nothing is the kind of bug users blame on the whole product.

export interface HotkeyBinding {
  accelerator: string;
  handler: () => void;
  label: string;
}

export class HotkeyManager {
  private registered = new Map<string, string>(); // accelerator -> label

  register(bindings: HotkeyBinding[]): { label: string; accelerator: string; ok: boolean }[] {
    this.unregisterAll();
    const results: { label: string; accelerator: string; ok: boolean }[] = [];
    for (const b of bindings) {
      let ok = false;
      try {
        ok = globalShortcut.register(b.accelerator, b.handler);
      } catch (e) {
        log.warn('hotkey', 'registration threw', {
          label: b.label,
          accelerator: b.accelerator,
          error: (e as Error).message,
        });
      }
      if (ok) {
        this.registered.set(b.accelerator, b.label);
        log.info('hotkey', 'registered', { label: b.label, accelerator: b.accelerator });
      } else {
        log.warn('hotkey', 'could not register — likely taken by another app', {
          label: b.label,
          accelerator: b.accelerator,
        });
      }
      results.push({ label: b.label, accelerator: b.accelerator, ok });
    }
    return results;
  }

  unregisterAll() {
    globalShortcut.unregisterAll();
    this.registered.clear();
  }

  isRegistered(accelerator: string): boolean {
    return globalShortcut.isRegistered(accelerator);
  }

  list(): { accelerator: string; label: string }[] {
    return [...this.registered].map(([accelerator, label]) => ({ accelerator, label }));
  }
}

export const hotkeys = new HotkeyManager();
