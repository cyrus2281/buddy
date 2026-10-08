import type { DayAnswer, GoalReading, RunView } from './types.js';

/// What buddy says out loud, and how it is written to be heard rather than
/// read (PRD §9's `VoiceIO` seam, output side).
///
/// Pure, because the interesting half of speaking is not the synthesizer — it
/// is deciding what is worth saying and turning screen-shaped text into
/// sentence-shaped text. `SAM-4412` read literally is "sam dash four four one
/// two"; `#sam-eng` is "hash sam dash eng"; a URL is forty seconds of
/// punctuation. Those are the difference between a feature people leave on and
/// one they turn off after a day.
///
/// The rule throughout: **say less than the screen shows.** The HUD can afford
/// evidence, confidence and an allowlist; a sentence cannot, and a person
/// listening wants the one thing they would have read first.

export interface SpeakEvent {
  id: number;
  state: 'started' | 'finished' | 'cancelled';
}

export interface SpeakVoices {
  voices: { id: string; name: string; language: string; quality: 'premium' | 'enhanced' | 'default' }[];
  /** What buddy uses with nothing configured: the best installed voice, and
   *  within a tier the one the person chose in System Settings. */
  preferred: string | null;
  systemDefault: string | null;
}

export interface SpeakStatus {
  speaking: boolean;
  id: number;
  voices: number;
  /** The default output device's name. */
  output: string | null;
  /** Headphones or a headset: what buddy says reaches one person. */
  outputIsPrivate: boolean;
  /** Something has the microphone open — which may be buddy's own listener. */
  micInUse: boolean;
}

/** What a spoken moment is, so each can be turned off on its own. */
export type SpeechKind = 'goal' | 'answer' | 'run';

/** Long enough for a goal or a short answer; past this nobody is listening,
 *  and the screen is right there. */
export const MAX_SPOKEN_CHARS = 420;

const ABBREVIATIONS: [RegExp, string][] = [
  // A ticket key is letters then digits: "SAM-4412" is said "SAM 4412", not
  // "sam dash four thousand four hundred and twelve".
  [/\b([A-Z]{2,6})-(\d{1,6})\b/g, '$1 $2'],
  // A channel is a channel, and the hash is not part of its name.
  [/(^|\s)#([a-z0-9][a-z0-9-]{1,40})\b/gi, '$1the $2 channel'],
  // An @mention is a person.
  [/(^|\s)@([a-z0-9][a-z0-9._-]{1,30})\b/gi, '$1$2'],
];

/** Turn text written to be read into text written to be heard. */
export function speakable(text: string): string {
  let s = (text ?? '').trim();
  if (!s) return '';
  // Links are never worth saying. Said first, so a URL containing a `#` is not
  // turned into "the … channel" on the way past.
  s = s.replace(/\bhttps?:\/\/\S+/gi, 'a link');
  s = s.replace(/\bfile:\/\/\S*\/([^/\s]+)/gi, '$1');
  // Markdown is for eyes.
  s = s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2');
  // Citation chips the Ask box renders — "[n12]" is not a word.
  s = s.replace(/\[(?:[a-z]\d+)(?:\s*,\s*[a-z]\d+)*\]/gi, '');
  for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);
  // A path is said as its last part.
  s = s.replace(/(^|\s)(?:~|\.{0,2})\/\S*\/([^/\s]+)/g, '$1$2');
  s = s.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_SPOKEN_CHARS) {
    // Cut at a sentence end if there is one nearby, so it stops rather than
    // trailing off mid-clause.
    const cut = s.slice(0, MAX_SPOKEN_CHARS);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    s = stop > MAX_SPOKEN_CHARS * 0.6 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
  }
  return s;
}

/**
 * The goal, out loud.
 *
 * Below the confidence line the HUD is asking a question rather than making a
 * proposal (§6.1 step 6), so the sentence is a question too — reading a guess
 * aloud as a statement is how someone ends up pressing Enter on something buddy
 * said it was not sure about.
 */
export function goalUtterance(goal: string, reading: GoalReading | null, mustAsk: boolean): string {
  const said = speakable(goal);
  if (!said) return '';
  if (mustAsk) {
    const alt = reading?.alternatives[0]?.goal;
    return alt ? `${said}? Or ${speakable(alt)}?` : `${said}? I am not sure.`;
  }
  // The already-done line is the one piece of context worth a clause: it is
  // the difference between "it will redo my work" and "it knows where I got to".
  const done = reading?.already_done?.[0];
  return done ? `${said}. ${speakable(done)} already.` : said;
}

/** An answer from the Ask box. The citations are chips on screen; spoken, they
 *  are noise, and `speakable` has already taken them out. */
export function answerUtterance(a: Pick<DayAnswer, 'answer'>): string {
  return speakable(a.answer);
}

/**
 * A run that has ended, or stopped to ask.
 *
 * The one moment where speaking earns its place without argument: the person
 * is somewhere else — that is what unattended and hands-off are *for* — and a
 * run that needs them is a run that is otherwise silent until they look.
 */
export function runUtterance(v: Pick<RunView, 'status' | 'outcome' | 'haltReason' | 'gate' | 'goal'>): string {
  if (v.gate) return `buddy is asking first. ${speakable(v.gate.verdict.reason)}`;
  const summary = speakable(v.outcome?.summary ?? v.haltReason ?? '');
  switch (v.status) {
    case 'done':
      return summary ? `Done. ${summary}` : `Done — ${speakable(v.goal)}.`;
    case 'needs_human':
      return summary ? `buddy needs you. ${summary}` : 'buddy needs you.';
    case 'waiting':
      return summary ? `Waiting. ${summary}` : 'buddy is waiting for something to change.';
    default:
      return '';
  }
}

/** Why buddy did not say something, in words Settings can show. The reasons
 *  come back from buddyd, which is where the rule is enforced. */
export const SKIP_REASON: Record<string, string> = {
  no_headphones: 'Not said out loud — the sound would have gone to the speakers, and you asked for headphones only.',
  microphone_in_use: 'Not said out loud — something is using the microphone, so you are probably on a call.',
};
