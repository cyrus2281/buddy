import type { RelationKind } from '../../shared/types.js';

/// Relation identity: the deterministic half of dedupe (PRD §4.1).
///
/// `relations` has a unique index on `(kind, identifier)`, and people arrive
/// spelled five different ways in one afternoon — "Priya" in a window title,
/// "@priya" in a Slack mention, "Priya Raman" in a PR reviewer list, and
/// `priya@…` in an email header. Those must converge on one row carrying four
/// aliases, not five rows carrying one each.
///
/// The merge is **code, not prompt**. The extractor is told what already exists
/// and usually reuses it, but "usually" is not a data model. Everything below
/// runs on every upsert regardless of what the model returned, so a rollup that
/// hallucinates a fresh spelling still lands on the existing row.

/** How specific an identifier is. A merge keeps the highest-ranked one and
 *  demotes the rest to aliases, so a row started from a first name gets
 *  promoted to an email the first time one is seen — and the first name still
 *  finds it, because it is now an alias. */
export const IDENTIFIER_RANK = { name: 1, handle: 2, email: 3 } as const;
export type IdentifierShape = keyof typeof IDENTIFIER_RANK;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function shapeOf(raw: string): IdentifierShape {
  const t = raw.trim();
  if (EMAIL.test(t)) return 'email';
  if (t.startsWith('@') || (!t.includes(' ') && /[._-]/.test(t))) return 'handle';
  return 'name';
}

/**
 * The canonical form of one spelling.
 *
 * Case and punctuation are noise; word order and content are not. An email is
 * kept whole (the local part alone is ambiguous across domains), a handle loses
 * its sigil, and a name is lowercased with punctuation stripped and whitespace
 * collapsed.
 *
 * Apps and tools are a separate case: a bundle id is already canonical and must
 * survive intact, dots and all, or `com.apple.Safari` and `com.apple.safari`
 * become two rows.
 */
export function normalizeIdentifier(kind: RelationKind, raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (kind === 'app' || kind === 'tool') {
    // A bundle id keeps its structure; anything else falls through to the
    // general rule so "VS Code" and "vs code" agree.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+){1,}$/i.test(t)) return t.toLowerCase();
  }
  if (EMAIL.test(t)) return t.toLowerCase();
  return t
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._@-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every form a spelling could be looked up by, so a bare first name finds a
 *  row created from an email and vice versa. Order is not significant. */
export function candidateKeys(kind: RelationKind, raw: string): string[] {
  const canonical = normalizeIdentifier(kind, raw);
  if (!canonical) return [];
  const keys = new Set<string>([canonical]);

  if (EMAIL.test(canonical)) {
    // `priya.raman@solace.com` → `priya.raman`, `priya raman`, `priya`
    const local = canonical.split('@')[0]!;
    keys.add(local);
    const spaced = local.replace(/[._-]+/g, ' ').trim();
    if (spaced) {
      keys.add(spaced);
      const first = spaced.split(' ')[0]!;
      if (first.length >= 3) keys.add(first);
    }
  } else {
    const dotted = canonical.replace(/[._-]+/g, ' ').trim();
    if (dotted && dotted !== canonical) keys.add(dotted);
    // A person's given name is the spelling that shows up in prose, and it is
    // the one that most often arrives alone.
    if (kind === 'person') {
      const parts = canonical.split(' ').filter(Boolean);
      if (parts.length > 1 && parts[0]!.length >= 3) keys.add(parts[0]!);
    }
  }
  return [...keys];
}

/**
 * Would these two spellings be the same entity?
 *
 * Deliberately asymmetric in one direction only: a single given name matches a
 * fuller name that starts with it ("priya" ↔ "priya raman"), because that is
 * how people actually get referred to. It does **not** match on a shared
 * surname or on any interior token — "priya raman" and "arjun raman" are two
 * people, and a rule loose enough to merge them would quietly fuse colleagues.
 */
export function sameEntity(kind: RelationKind, a: string, b: string): boolean {
  const x = normalizeIdentifier(kind, a);
  const y = normalizeIdentifier(kind, b);
  if (!x || !y) return false;
  if (x === y) return true;

  const keysA = new Set(candidateKeys(kind, a));
  const keysB = new Set(candidateKeys(kind, b));
  for (const k of keysA) if (keysB.has(k)) return true;

  if (kind !== 'person') return false;

  // "priya" vs "priya raman": one is a strict single-token prefix of the other.
  const pa = x.split(' ').filter(Boolean);
  const pb = y.split(' ').filter(Boolean);
  if (pa.length === 1 && pb.length > 1 && pb[0] === pa[0] && pa[0]!.length >= 3) return true;
  if (pb.length === 1 && pa.length > 1 && pa[0] === pb[0] && pb[0]!.length >= 3) return true;
  return false;
}

/** The fuller of two display names. More tokens wins; a tie goes to the longer
 *  string, then to the incumbent — so a merge never churns the name for free. */
export function betterDisplayName(incumbent: string, candidate: string): string {
  const a = incumbent.trim();
  const b = candidate.trim();
  if (!b) return a;
  if (!a) return b;
  const ta = a.split(/\s+/).length;
  const tb = b.split(/\s+/).length;
  if (tb > ta) return b;
  if (ta > tb) return a;
  return b.length > a.length ? b : a;
}

/** The more canonical of two identifiers, by shape rank then by length. */
export function betterIdentifier(kind: RelationKind, incumbent: string, candidate: string): string {
  const a = normalizeIdentifier(kind, incumbent);
  const b = normalizeIdentifier(kind, candidate);
  if (!b) return a;
  if (!a) return b;
  const ra = IDENTIFIER_RANK[shapeOf(a)];
  const rb = IDENTIFIER_RANK[shapeOf(b)];
  if (rb > ra) return b;
  if (ra > rb) return a;
  // Same shape: prefer the fuller spelling, so "priya raman" beats "priya".
  return b.split(' ').length > a.split(' ').length ? b : a;
}

/** Alias sets are stored normalized and never contain the identifier itself —
 *  the row already has that, and a duplicate makes every lookup ambiguous. */
export function mergeAliases(kind: RelationKind, identifier: string, ...sets: (string[] | undefined)[]): string[] {
  const out = new Set<string>();
  for (const set of sets) {
    for (const raw of set ?? []) {
      const n = normalizeIdentifier(kind, raw);
      if (n && n !== identifier) out.add(n);
    }
  }
  return [...out].sort();
}
