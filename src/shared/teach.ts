import type { FactKind } from './types.js';

/// "Remember that I review PRs before standup."
///
/// The Ask box already routes between a question and an instruction (see
/// `components/ask.tsx`); this is its third destination. Shared between the
/// renderer — which has to show, before Enter, that the text is about to be
/// *remembered* rather than run — and main, which does the remembering, so the
/// two cannot disagree about what counts.
///
/// Deliberately local and literal. The person's own words are what get
/// stored: rewriting "I prefer threads" into "Prefers threads" with a model
/// would be a model putting words in their mouth in the one place buddy
/// promised to take them as given.

const LEAD =
  /^\s*(?:hey\s+)?(?:buddy[,:]?\s+)?(?:please\s+)?(?:remember|note|keep in mind|fyi|for the record|don'?t forget|do not forget)\b(?:\s*[:,—–-])?(?:\s+that\b)?[\s,:—–-]*/i;

/** True for "remember that …", "note: …", "buddy, keep in mind …" — and false
 *  for "remember what I did yesterday?", which is a question about memory, not
 *  something to put in it. */
export function isTeaching(text: string): boolean {
  const t = text.trim();
  if (t.endsWith('?')) return false;
  const m = LEAD.exec(t);
  return !!m && t.slice(m[0].length).trim().length >= 3;
}

const KIND_RULES: [RegExp, FactKind][] = [
  [/\b(prefer|prefers|like|likes|love|loves|hate|hates|dislike|rather|favou?rite|don'?t want|do not want|never want|always want)\b/i, 'preference'],
  [/\b(is my|are my|my (manager|boss|lead|tech lead|colleague|teammate|report|pm|designer|partner|cto|ceo|director)|reports to|works (with|for) me)\b/i, 'relationship'],
  [/\b(every|each|usually|always|never|on (mon|tues|wednes|thurs|fri|satur|sun)days?|in the (morning|afternoon|evening)s?|mornings|evenings|weekly|daily|at night)\b/i, 'habit'],
  [/\b(to (deploy|ship|file|release|send|review|publish|merge)|when i|the way i|i use \S+ (for|to)|use \S+ for)\b/i, 'workflow'],
  [/\b(working on|my project|project|launch|migration|deadline|sprint|this quarter|q[1-4])\b/i, 'project'],
  [/\b(i('| a)m (good|expert|fluent|learning|new to)|i know|i speak|i'm learning)\b/i, 'skill'],
  [/\b(my goal|i('| a)m trying to|i want to|aiming to)\b/i, 'goal'],
];

export function parseTeaching(text: string): { statement: string; kind: FactKind } | null {
  if (!isTeaching(text)) return null;
  const t = text.trim();
  const m = LEAD.exec(t)!;
  let statement = t.slice(m[0].length).trim();
  statement = statement.charAt(0).toUpperCase() + statement.slice(1);
  if (!/[.!]$/.test(statement)) statement += '.';
  const kind = KIND_RULES.find(([re]) => re.test(statement))?.[1] ?? 'context';
  return { statement, kind };
}
