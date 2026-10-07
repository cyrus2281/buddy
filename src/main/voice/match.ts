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
  /**
   * Something to *do*, in the person's words: "hey buddy, send a Slack message
   * to Hugo asking him if he's done recording". `addressed` when it came after
   * the wake phrase; an unaddressed one only counts while main is listening
   * for dictation (right after a bare "hey buddy", or mid-instruction).
   */
  instruction: { text: string; addressed: boolean; plausible: boolean } | null;
}

/** What people say to a dog, a child or a friend after "hey buddy". Matched
 *  on the start of what follows the wake phrase; an instruction never starts
 *  like this, and a misfire here would start a run on a pleasantry. */
const CHITCHAT =
  /^(how (are|is|s|re|have|was|do)|hows|whats up|what s up|sup|good (boy|girl|job|morning|night|afternoon|evening)|come (here|on)|sit|stay|thank|thanks|i love|love you|hello|hi|hey|yo|nice|well done|you re|youre|are you|long time|see you|bye|goodnight|happy)\b/;

/** A question is for the Ask box, not a run — unless it is a request wearing a
 *  question's clothes ("can you send…"), which `POLITE` takes off first. */
const QUESTION = /^(what|whats|who|whos|when|where|why|how|which|is|are|was|were|do|does|did|have|has|should|shall)\b/;
const POLITE = /^(can you|could you|would you|will you|would you mind|i need you to|i want you to|id like you to|please)\b\s*/;

/** Normalised words that read as an instruction: long enough to say what to
 *  do, not small talk, not a question. */
export function looksLikeInstruction(norm: string, addressed: boolean): boolean {
  const words = stripLeading(norm.split(' ').filter(Boolean));
  const s = words.join(' ').replace(POLITE, '');
  const n = s.split(' ').filter(Boolean).length;
  // Addressed, two words is enough ("open Slack"). Unaddressed, it takes three:
  // a room says plenty of two-word things.
  if (n < (addressed ? 2 : 3)) return false;
  if (CHITCHAT.test(s)) return false;
  if (QUESTION.test(s)) return false;
  return true;
}

/**
 * The instruction as the person said it — their casing, their names, their
 * punctuation — with the wake phrase, leading fillers and a polite wrapper
 * taken off. "Hugo" stays "Hugo"; normalising for matching would have made it
 * "hugo", and the goal is shown back to them and handed to the Operator.
 */
export function instructionText(original: string): string {
  let t = original.trim();
  const lead =
    /^(?:(?:okay|ok|so|um|uh|oh|well|yeah|yes|alright|all right|and|then|now|just)[\s,.!?:;-]+)*(?:(?:hey|hi|hay|okay|ok)[\s,]+(?:buddy|buddie|budy|body)\b[\s,.!?:;-]*)+/i;
  t = t.replace(lead, '');
  t = t.replace(/^(?:(?:okay|ok|so|um|uh|oh|well|yeah|alright|now|just|and|then)[\s,]+)+/i, '');
  t = t.replace(/^(?:can you|could you|would you mind|would you|will you|i need you to|i want you to|i['’]d like you to|please)[\s,]+/i, '');
  t = t.replace(/[\s,]+(?:please|thanks|thank you|buddy)[.!?]*$/i, '');
  t = t.replace(/\?$/, '').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
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

  if (woke && rest && !intent) {
    // Not a command: an instruction, or something said to someone else. The
    // HUD is not woken for an instruction — main opens it with the
    // instruction already in it, and skips the screen reading the wake would
    // have started, since the person has just said what they want.
    return looksLikeInstruction(rest, true)
      ? { wake: false, intent: null, instruction: { text: instructionText(text), addressed: true, plausible: true } }
      : { wake: false, intent: null, instruction: null };
  }
  // Every other unaddressed utterance is passed up, marked with whether it
  // reads like an instruction on its own. Whether anyone was asking is main's
  // call (`routeInstruction`): straight after a bare "hey buddy" it has to be
  // plausible; as the rest of a sentence buddyd cut at a pause, it need not
  // be — "…ask Hugo / how the recording is going" is a continuation that
  // starts with a question word. Outside both, it is just the room talking.
  const loose =
    !woke && !intent && words.length > 0
      ? { text: instructionText(text), addressed: false, plausible: looksLikeInstruction(norm, false) }
      : null;
  // "Hey buddy, stop" is addressed, not a request to open the HUD and then
  // close it again.
  return { wake: woke && intent?.kind !== 'cancel', intent, instruction: loose };
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
