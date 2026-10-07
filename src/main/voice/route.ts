import type { AppState, VoiceIntent } from '../../shared/types.js';

/// What a heard command does, given what buddy is doing. Pure, so the checks
/// can walk the table; `index.ts` carries out the answer.
///
/// The two commands are not symmetrical, and that is the point:
///
///   **Starting is narrow.** A go-ahead reaches the HUD only when the HUD is
///   up and ARMED, nothing is running, and it was armed recently. The last one
///   matters most: a HUD a false "hey buddy" opened in an empty room would
///   otherwise sit there accepting the next "start" the television says. Past
///   the window, "hey buddy" re-arms it — and "hey buddy, go ahead" in one
///   breath always works. A go-ahead never answers a confirm gate: gates are
///   for a person looking at the exact action, and voice is not that.
///
///   **Stopping is easy, but addressed.** During a run, "buddy, stop" stops it
///   — a fourth kill switch beside §7.3's three. A bare "stop" does not: §7.3
///   made stopping an explicit act precisely because a run killed by something
///   the user did not mean throws away real work, and "stop" in a room is
///   often said to someone else. With no run, any "cancel" or "never mind"
///   closes an open HUD — unless a goal is being typed into it, which the HUD
///   decides, since only it knows.

/** How long after arming a go-ahead is still honoured without a fresh "hey
 *  buddy". Long enough to cover the slowest measured reading (22 s, §6.7)
 *  plus a beat to read it. */
export const VOICE_CONFIRM_WINDOW_MS = 30_000;

export type VoiceAction = 'stop-run' | 'dismiss' | 'confirm' | 'ignore';

export function routeIntent(
  intent: VoiceIntent,
  at: { running: boolean; hudVisible: boolean; state: AppState; armedAt: number; now: number },
): { action: VoiceAction; why: string } {
  if (intent.kind === 'cancel') {
    if (at.running) {
      return intent.addressed
        ? { action: 'stop-run', why: 'stopped by voice' }
        : { action: 'ignore', why: 'a bare "stop" during a run is not addressed to buddy; say "buddy, stop"' };
    }
    if (at.hudVisible) return { action: 'dismiss', why: 'closed by voice' };
    return { action: 'ignore', why: 'nothing to cancel' };
  }

  if (at.running) return { action: 'ignore', why: 'a run is in progress; voice never answers a gate' };
  if (!at.hudVisible || at.state !== 'ARMED') return { action: 'ignore', why: 'the HUD is not showing a suggestion' };
  if (at.now - at.armedAt > VOICE_CONFIRM_WINDOW_MS) {
    return { action: 'ignore', why: 'the HUD has been up too long; say "hey buddy" first' };
  }
  return { action: 'confirm', why: 'go-ahead heard' };
}
