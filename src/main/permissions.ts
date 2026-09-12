import { EventEmitter } from 'node:events';
import { shell, systemPreferences } from 'electron';
import { sidecar } from './sidecar/supervisor.js';
import { log } from './log.js';
import type { Permissions } from '../shared/types.js';

/// Live permission state. The UI shows what is true right now and never assumes
/// (PRD §8.6) — which matters more than it sounds, because R2's failure mode is
/// System Settings showing a grant that no longer applies.
///
/// Polling is the only option: macOS has no notification for a TCC change, and
/// a user who grants in System Settings expects the app to notice without a
/// relaunch.

const POLL_MS = 2_000;

const PANES: Record<keyof Permissions, string> = {
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

export class PermissionWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private last: Permissions = { screenRecording: false, accessibility: false };

  start() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): Permissions {
    return this.last;
  }

  async poll(): Promise<Permissions> {
    let next: Permissions;
    try {
      next = await sidecar.permissions();
    } catch {
      // Sidecar down. Electron's own view is a usable second opinion for screen
      // recording, and reporting stale state would be worse than reporting
      // Electron's.
      next = {
        screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
        accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      };
    }

    if (next.screenRecording !== this.last.screenRecording || next.accessibility !== this.last.accessibility) {
      log.info('permissions', 'changed', { from: this.last, to: next });
      this.last = next;
      this.emit('changed', next);
    }
    return next;
  }

  /** The Grant button. Triggers the system prompt where one exists, then polls —
   *  the return value of a TCC request is not trustworthy on its own. */
  async request(kind: keyof Permissions): Promise<Permissions> {
    try {
      await sidecar.requestPermission(kind);
    } catch (e) {
      log.warn('permissions', 'request failed, falling back to opening System Settings', {
        kind,
        error: (e as Error).message,
      });
      await this.openSettings(kind);
    }
    return this.poll();
  }

  async openSettings(kind: keyof Permissions) {
    log.info('permissions', 'opening System Settings pane', { kind });
    await shell.openExternal(PANES[kind]);
  }
}

export const permissions = new PermissionWatcher();
