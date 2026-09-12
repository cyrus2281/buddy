import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { paths } from '../paths.js';
import { log } from '../log.js';
import { sidecar } from '../sidecar/supervisor.js';
import type { KillSwitch } from '../../shared/types.js';

/// The three kill switches (PRD §7.3), behind one event.
///
/// Independence is the requirement: each one has to work when the others
/// cannot. So the sentinel is a `stat` on a path the UI never touches, the
/// hotkey is registered by the OS before the run exists, and the Stop button is
/// plain IPC. They converge on exactly one place — `fire()` — so a run can only
/// be stopped one way and there is nothing to keep in sync.
///
/// Naming them honestly: `hotkey` and `stop-button` are pushes from the UI
/// layer, and `sentinel` is polled every turn.
///
/// **Touching the keyboard is deliberately NOT one of them.** buddy runs by
/// driving the mouse and keyboard, and a person who reaches for either while it
/// works — to scroll, to glance at another window, to correct a typo — is not
/// asking it to stop. Making incidental input a kill switch meant the run died
/// for reasons the user never intended and could not always reconstruct, and it
/// made the product feel like something you had to sit on your hands through.
/// Stopping is now always an explicit act: the abort hotkey, the Stop button,
/// or the ABORT file.
///
/// The event tap survives that change and keeps its `BUDDY_MAGIC` filter,
/// because *recording* that a human touched the machine mid-run is worth real
/// money in the Run Log — "the user typed at step 12" is often the whole
/// explanation for a click that landed somewhere strange. It emits
/// `human-input`, which is an observation, not a halt.

export class KillSwitches extends EventEmitter {
  private armed = false;
  private firedWith: KillSwitch | null = null;
  private sawSidecarInput = false;

  constructor() {
    super();
    // Registered once. The sidecar can restart mid-run; the handler survives it
    // because it is attached to the supervisor, not to a process.
    sidecar.onHumanInput((p) => {
      this.sawSidecarInput = true;
      // Emitted, never fired. See the note above.
      if (this.armed) this.emit('human-input', p);
    });
  }

  /** Called as `ACTING` begins. Clears any stale sentinel so a file left behind
   *  by a previous abort cannot kill the next run before its first step. */
  async arm(): Promise<{ inputWatch: boolean; inputWatchError: string | null }> {
    this.armed = true;
    this.firedWith = null;
    this.sawSidecarInput = false;
    this.clearSentinel();

    try {
      await sidecar.watchInput();
      return { inputWatch: true, inputWatchError: null };
    } catch (e) {
      // Accessibility ungranted, or buddyd down. Nothing about the run changes:
      // this watch only annotates the log. It is logged at debug and not raised
      // to the user, because telling someone a kill switch is missing when no
      // kill switch is missing is worse than saying nothing.
      const msg = (e as Error).message;
      log.debug('killswitch', 'human-input watch unavailable; the run log will not note takeovers', {
        error: msg,
      });
      return { inputWatch: false, inputWatchError: msg };
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

  /** For the checks: did a `human_input` notification actually arrive from
   *  buddyd's tap? The tap's `BUDDY_MAGIC` filter is what makes that signal
   *  mean anything, and this is what lets the report say it was exercised. */
  get sawInputFromSidecar(): boolean {
    return this.sawSidecarInput;
  }
}

export const killSwitches = new KillSwitches();

/** Human-readable, for the run log and the NEEDS_HUMAN screen. */
export const KILL_SWITCH_LABEL: Record<KillSwitch, string> = {
  hotkey: 'the abort hotkey',
  sentinel: '~/.buddy/ABORT',
  'stop-button': 'the Stop button',
};
