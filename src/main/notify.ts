import { Notification } from 'electron';
import { log } from './log.js';
import { createHome, showHud } from './windows.js';

/// Notifications (PRD §10, M4).
///
/// Three things get one, and the list is short on purpose. buddy is a menu bar
/// app with no Dock icon — it is invisible by design — so the moments it has to
/// interrupt are exactly the moments where **something is waiting on the user
/// and they do not know it**:
///
///   1. A run parked in `needs_human`. §7.1 calls that a terminal state with a
///      notification, and it is the one the guardrails are for.
///   2. A run that came back from standby and is driving the machine again.
///      This one is not about needing the user — it is about not having the
///      mouse start moving on its own with no explanation.
///   3. A wakeup that ran out of attempts. The thing buddy promised to watch
///      for did not happen, and silence would read as it still watching.
///
/// Nothing else notifies. An observation, a rollup, a completed run — those are
/// buddy working, and a notification per hour of working is a notification
/// people turn off, which costs the three above.

export type NotifyKind = 'needs-human' | 'resumed' | 'wake-exhausted';

function fire(kind: NotifyKind, title: string, body: string, onClick: () => void) {
  if (!Notification.isSupported()) {
    log.warn('notify', 'notifications are unavailable on this system', { kind, title });
    return;
  }
  const n = new Notification({ title, body, silent: kind === 'resumed' });
  n.on('click', () => {
    try {
      onClick();
    } catch (e) {
      log.warn('notify', 'notification click handler failed', { error: (e as Error).message });
    }
  });
  n.show();
  log.info('notify', kind, { title });
}

export const notify = {
  /** A run stopped and wants a person. Clicking opens the Run Log, which is
   *  where "what did it do and why did it stop" is answerable (§8.5). */
  needsHuman(runId: number, goal: string, reason: string) {
    fire(
      'needs-human',
      'buddy needs you',
      `${reason}\n\n${goal}`.slice(0, 300),
      () => {
        createHome();
      },
    );
  },

  /** Standby fired, the condition was met, and buddy is driving again.
   *  Clicking brings the HUD up — which is where the Stop button is. */
  resumed(runId: number, goal: string, condition: string) {
    fire(
      'resumed',
      'buddy is picking it back up',
      `${condition} — carrying on with: ${goal}`.slice(0, 300),
      () => showHud(),
    );
  },

  /** The condition never became true. Says how many times it looked, because
   *  "it checked twelve times over an hour" and "it gave up" are different
   *  facts and only one of them is in the word "gave up". */
  wakeExhausted(runId: number, condition: string, attempts: number) {
    fire(
      'wake-exhausted',
      'buddy stopped waiting',
      `Checked ${attempts} time${attempts === 1 ? '' : 's'} and "${condition}" never became true.`.slice(
        0,
        300,
      ),
      () => {
        createHome();
      },
    );
  },
};
