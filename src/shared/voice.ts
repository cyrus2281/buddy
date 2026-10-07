import type { InferenceState, RunProfile } from './types.js';

/// The HUD's half of "go ahead".
///
/// Main decides whether a heard go-ahead reaches the HUD at all (the HUD is up,
/// nothing is running, it was armed recently). This decides what the HUD does
/// with one — and it is deliberately stricter than the Enter key, because Enter
/// is pressed by someone looking at the panel and a voice can come from across
/// the room:
///
///   - **It waits for the reading.** Enter on the ~200 ms provisional guess is
///     fine; the user can see it. "Hey buddy, take over" said in one breath
///     would otherwise run that guess before the model has looked at the
///     screen, so a go-ahead heard early is held until the reading lands.
///   - **It runs only what the model read with confidence.** Below 0.5 the HUD
///     is asking a question (§6.1 step 6), and "go ahead" is not an answer to
///     "which of these?". If the reading failed, there is nothing it read.
///   - **Never leashless.** §7.1 makes that profile a deliberate act; a
///     misheard "start" is the opposite of one.
///
/// Every refusal says what would work instead, because a voice command that
/// silently does nothing reads as voice being broken.

export type VoiceGo = { act: 'start' } | { act: 'wait' } | { act: 'drop' } | { act: 'refuse'; why: string };

export function voiceGo(s: {
  /** The ARMED panel is up: no run, no gate, not mid-typing. */
  armed: boolean;
  /** Non-null once the user picked an alternative or typed a goal. */
  typed: string | null;
  inference: InferenceState['phase'] | null;
  mustAsk: boolean;
  goal: string;
  profile: RunProfile;
}): VoiceGo {
  if (!s.armed) return { act: 'drop' };
  if (s.profile === 'leashless') {
    return { act: 'refuse', why: 'Leashless never starts by voice. Press Enter if you mean it.' };
  }
  // A picked alternative is the user's answer, not buddy's guess.
  if (s.typed !== null) {
    return s.goal ? { act: 'start' } : { act: 'refuse', why: 'Nothing to start yet. Type what you want finished.' };
  }
  if (s.inference === 'provisional') return { act: 'wait' };
  if (s.inference !== 'ready') {
    return {
      act: 'refuse',
      why: s.goal
        ? 'buddy could not read the screen, so it will not start its guess by voice. Press Enter to run it anyway.'
        : 'Nothing to start yet. Type what you want finished.',
    };
  }
  if (s.mustAsk) {
    return { act: 'refuse', why: 'buddy is not sure enough to start on its own. Pick one with 1–3, then say it again.' };
  }
  if (!s.goal) return { act: 'refuse', why: 'Nothing to start yet. Type what you want finished.' };
  return { act: 'start' };
}
