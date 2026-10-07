import type { VoiceIntent } from '../../shared/types.js';

/// Turning one finished utterance into the wake phrase, a go-ahead, or a stop.
/// Pure, so the whole policy can be checked without a microphone.
///
/// **Whole utterances, never substrings.** "We should go ahead with it" is
/// not a go-ahead, "start the meeting" is not "start", and "do not stop" is
/// certainly not "stop". An utterance matches only when, once the wake phrase
/// and a few fillers ("okay", "please", "buddy") are taken off, what is left is
/// exactly a phrase on the list. That is what makes it safe to listen in a
/// room where people are talking about something else.
///
/// **"Hey buddy" has to open the utterance and be followed by nothing or by a
/// command.** It is also what people say to dogs, children and friends — "hey
/// buddy, how's it going?" is not addressed to a Mac — so a wake phrase
/// followed by anything else is not one. The price is that buddy waits for the
/// pause at the end of an utterance (~1 s) before it wakes; buddyd only sends
/// finished utterances for that reason.

/** Lowercase, apostrophes folded ("let's" → "lets"), everything else that is
 *  not a letter or a digit turned into a space. The recognizer's output and
 *  the user's typed phrases both go through here, so they meet in the middle. */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The wake phrase and the spellings the recognizer actually produces for it.
 *  Narrow on purpose: "a buddy" and "hey bud" are ordinary English. */
const WAKE = /^(?:hey|hi|hay|okay|ok) (?:buddy|buddie|budy|body)\b/;

const LEADING = new Set([
  'okay', 'ok', 'yeah', 'yes', 'yep', 'so', 'um', 'uh', 'oh', 'well', 'alright', 'now', 'just', 'please', 'buddy', 'and', 'then',
]);
const TRAILING = new Set(['please', 'buddy', 'now', 'then', 'thanks']);

/** Stop words, fixed rather than configurable: the way out should not be
 *  something a settings edit can lose. */
const CANCEL = new Set(
  ['stop', 'stop it', 'stop that', 'cancel', 'cancel it', 'cancel that', 'abort', 'halt', 'never mind', 'nevermind', 'forget it'].map(
    normalizeSpeech,
  ),
);

/** Phrases worth biasing the recognizer toward. Passed to buddyd as
 *  `contextualStrings`; it hears "buddy" as "body" less often for it. */
export function recognizerHints(confirmPhrases: string[]): string[] {
  return [...new Set(['hey buddy', 'buddy', ...confirmPhrases, 'stop', 'cancel', 'never mind'])];
}

export interface Heard {
  /** The utterance was the wake phrase, alone or followed by a command. */
  wake: boolean;
  intent: VoiceIntent | null;
}

export function interpret(text: string, confirmPhrases: string[]): Heard {
  const norm = normalizeSpeech(text);
  const words = norm.split(' ').filter(Boolean);
  const confirm = new Set(confirmPhrases.map(normalizeSpeech).filter(Boolean));

  // Fillers may come before the wake phrase ("so, hey buddy"); nothing else
  // may. Stripped one at a time and tried at each step, because "okay buddy"
  // is itself a wake phrase that starts with a filler.
  let i = 0;
  while (i < words.length && !WAKE.test(words.slice(i).join(' '))) {
    const n = fillerAt(words, i);
    if (!n) break;
    i += n;
  }
  let rest = words.slice(i).join(' ');
  let woke = false;
  for (let m = WAKE.exec(rest); m; m = WAKE.exec(rest)) {
    // Repeated — "hey buddy, hey buddy" — is someone making sure, not a sentence.
    woke = true;
    rest = rest.slice(m[0].length).trim();
  }
  if (!woke) rest = norm;

  // Addressed by name: the wake phrase, or "buddy" anywhere ("buddy, stop",
  // "stop it, buddy"). A bare "stop" in a room is often meant for someone else.
  const addressed = woke || words.includes('buddy');
  const intent = intentOf(rest, confirm, addressed);

  if (woke && rest && !intent) return { wake: false, intent: null };
  // "Hey buddy, stop" is addressed, not a request to open the HUD and then
  // close it again.
  return { wake: woke && intent?.kind !== 'cancel', intent };
}

function intentOf(rest: string, confirm: Set<string>, addressed: boolean): VoiceIntent | null {
  const candidates = forms(rest);
  // Stop is read first, so a user who puts "stop" on the go-ahead list gets
  // the safe reading of it rather than the dangerous one.
  if (candidates.some((f) => CANCEL.has(f))) return { kind: 'cancel', addressed };
  if (candidates.some((f) => isConfirm(f, confirm))) return { kind: 'confirm' };
  return null;
}

/** "Go ahead and start it" is two go-aheads joined by "and", and still one. */
function isConfirm(form: string, confirm: Set<string>): boolean {
  if (confirm.has(form)) return true;
  const parts = form.split(' and ').map((p) => trimFillers(p.split(' ')).join(' '));
  return parts.length > 1 && parts.every((p) => p && confirm.has(p));
}

/** The readings an utterance could be matching: as said, without leading
 *  fillers, without trailing ones, and without either. Several rather than one,
 *  so a phrase that is itself a filler — a user who adds "yes" — still matches
 *  when said alone, and "yes please" still matches it too. */
function forms(rest: string): string[] {
  const w = rest.split(' ').filter(Boolean);
  const lead = stripLeading(w);
  return [...new Set([w, lead, stripTrailing(w), stripTrailing(lead)].map((x) => x.join(' ')))].filter(Boolean);
}

function trimFillers(words: string[]): string[] {
  return stripTrailing(stripLeading(words.filter(Boolean)));
}

/** How many words at `i` are a leading filler: 0, 1, or 2 for "all right". */
function fillerAt(words: string[], i: number): number {
  if (words[i] === 'all' && words[i + 1] === 'right') return 2;
  return LEADING.has(words[i]!) ? 1 : 0;
}

function stripLeading(words: string[]): string[] {
  let i = 0;
  for (let n = fillerAt(words, i); n; n = fillerAt(words, i)) i += n;
  return words.slice(i);
}

function stripTrailing(words: string[]): string[] {
  let j = words.length;
  while (j > 0) {
    if (j >= 2 && words[j - 2] === 'thank' && words[j - 1] === 'you') j -= 2;
    else if (TRAILING.has(words[j - 1]!)) j--;
    else break;
  }
  return words.slice(0, j);
}
