import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { paths } from '../paths.js';
import { log } from '../log.js';
import { sidecar } from '../sidecar/supervisor.js';
import type { KillSwitch } from '../../shared/types.js';

/// The four kill switches (PRD §7.3), behind one event.
///
/// Independence is the requirement: each one has to work when the others
/// cannot. So the sentinel is a `stat` on a path the UI never touches, the
/// hotkey is registered by the OS before the run exists, the takeover detector
/// lives in a separate process, and the Stop button is plain IPC. They converge
/// on exactly one place — `fire()` — so a run can only be stopped one way and
/// there is nothing to keep in sync.
///
/// Naming them honestly: `hotkey` and `stop-button` are pushes from the UI
/// layer, `sentinel` is polled every turn, and `human-takeover` is a push from
/// `buddyd`'s event tap.

export class KillSwitches extends EventEmitter {
  private armed = false;
  private firedWith: KillSwitch | null = null;
  private sawSidecarTakeover = false;

  constructor() {
    super();
    // Registered once. The sidecar can restart mid-run; the handler survives it
    // because it is attached to the supervisor, not to a process.
    sidecar.onHumanInput(() => {
      this.sawSidecarTakeover = true;
      this.fire('human-takeover');
    });
  }

  /** Called as `ACTING` begins. Clears any stale sentinel so a file left behind
   *  by a previous abort cannot kill the next run before its first step. */
  async arm(): Promise<{ takeoverWatch: boolean; takeoverError: string | null }> {
    this.armed = true;
    this.firedWith = null;
    this.sawSidecarTakeover = false;
    this.clearSentinel();

    try {
      await sidecar.watchInput();
      return { takeoverWatch: true, takeoverError: null };
    } catch (e) {
      // Accessibility ungranted, or buddyd down. The run can still proceed with
      // three kill switches, but the user is told which one is missing rather
      // than being left to assume all four are live.
      const msg = (e as Error).message;
      log.warn('killswitch', 'human-takeover watch unavailable', { error: msg });
      return { takeoverWatch: false, takeoverError: msg };
    }
  }

  async disarm(): Promise<void> {
    this.armed = false;
    try {
      await sidecar.unwatchInput();
    } catch {
      /* buddyd may already be gone; the tap dies with it */
    }
  }

  /** Switch 2: the sentinel file, stat'd every turn. Deliberately outside
   *  Application Support so it can be created from a shell in one obvious
   *  command, and deliberately checked by `stat` so it works when the UI, the
   *  IPC channel, or the renderer is wedged. */
  sentinelPresent(): boolean {
    try {
      fs.statSync(paths.abortFile());
      return true;
    } catch {
      return false;
    }
  }

  clearSentinel() {
    try {
      fs.unlinkSync(paths.abortFile());
      log.info('killswitch', 'cleared a stale ABORT sentinel');
    } catch {
      /* the normal case: no sentinel */
    }
  }

  /** Every switch lands here. First one wins; the rest are no-ops, so a user
   *  who hits the hotkey and then the Stop button does not stop two runs. */
  fire(which: KillSwitch): boolean {
    if (!this.armed || this.firedWith) return false;
    this.firedWith = which;
    this.armed = false;
    log.warn('killswitch', 'run aborted', { switch: which });
    this.emit('fired', which);
    return true;
  }

  /** Polled from the loop each turn, alongside the budget checks. */
  check(): KillSwitch | null {
    if (this.firedWith) return this.firedWith;
    if (this.armed && this.sentinelPresent()) {
      this.fire('sentinel');
      return this.firedWith;
    }
    return null;
  }

  get fired(): KillSwitch | null {
    return this.firedWith;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** For the checks: did the takeover actually come from buddyd's tap, or was
   *  it synthesized locally? A switch that was never really fired is not
   *  tested, and this is what lets the report say which. */
  get takeoverCameFromSidecar(): boolean {
    return this.sawSidecarTakeover;
  }
}

export const killSwitches = new KillSwitches();

/** Human-readable, for the run log and the NEEDS_HUMAN screen. */
export const KILL_SWITCH_LABEL: Record<KillSwitch, string> = {
  hotkey: 'the abort hotkey',
  sentinel: '~/.buddy/ABORT',
  'human-takeover': 'you took over the keyboard',
  'stop-button': 'the Stop button',
};
