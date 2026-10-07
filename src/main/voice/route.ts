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

/** After a bare "hey buddy", how long the next utterance is taken as the
 *  instruction without saying the wake phrase again. Short, because what
 *  makes it safe is that the person has just addressed buddy. */
export const VOICE_DICTATION_WINDOW_MS = 8_000;
/** After an instruction, how long a follow-on utterance is taken as the rest
 *  of it — people pause mid-sentence, and buddyd cuts utterances at 0.9 s. */
export const VOICE_CONTINUE_WINDOW_MS = 4_000;

/**
 * What a spoken instruction does.
 *
 * Addressed — "hey buddy, send a Slack message to Hugo…" — it opens the HUD
 * with that as the goal. Unaddressed, only while buddy is listening for one:
 * right after a bare "hey buddy", or straight after an instruction, as the
 * rest of it. Never during a run: a new goal mid-run is a second agent on one
 * keyboard, and "buddy, stop" is the way in.
 */
export function routeInstruction(
  i: { addressed: boolean; plausible: boolean },
  at: { running: boolean; dictationUntil: number; continueUntil: number; now: number },
): { action: 'instruct' | 'continue' | 'ignore'; why: string } {
  if (at.running) return { action: 'ignore', why: 'a run is in progress; say "buddy, stop" first' };
  if (i.addressed) return { action: 'instruct', why: 'instruction heard' };
  if (at.now < at.continueUntil) return { action: 'continue', why: 'the rest of the instruction' };
  if (at.now < at.dictationUntil && i.plausible) return { action: 'instruct', why: 'dictated after "hey buddy"' };
  return { action: 'ignore', why: 'not addressed to buddy' };
}

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
