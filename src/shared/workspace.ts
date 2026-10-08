/// "Where was I?" — the shape of a workspace, and what putting one back means.
///
/// PRD §2 costs the problem at twenty minutes a day: you come back from a
/// meeting to a machine that has forgotten the six windows you had arranged,
/// and you spend the first part of the afternoon finding them again. buddy was
/// already watching when you had them open, so it is the one thing on the
/// machine that can say what they were.
///
/// This file is the part with no system calls in it: what a snapshot holds, and
/// what has to be opened to get back to it. Pure, so the diff is pinned by the
/// checks rather than demonstrated by hand on a Mac with the right apps open.

export interface WorkspaceWindow {
  title: string;
  /** The file the window is showing, when it has one (`AXDocument`). */
  document?: string;
  /** The page the focused browser window was on. */
  url?: string;
  minimized?: boolean;
}

export interface WorkspaceApp {
  bundleId: string;
  appName: string;
  windows: WorkspaceWindow[];
}

export interface WorkspaceSnapshot {
  t: number;
  /** The session it belonged to, so "the last time you were working" is a
   *  question with an answer rather than "a while ago". */
  sessionStartedAt: number | null;
  apps: WorkspaceApp[];
  /** Apps and windows the exclusion list kept out — a password manager, a
   *  private browsing window. Counted so the UI can say it rather than quietly
   *  presenting a partial picture as a whole one. */
  excluded: number;
}

export type RestoreKind = 'app' | 'document' | 'page';

export interface RestoreItem {
  kind: RestoreKind;
  bundleId: string;
  appName: string;
  /** `document`: a path. `page`: a URL. `app`: nothing — just launch it. */
  target?: string;
  /** What the person will recognise: the window's title, or the file's name. */
  label: string;
  /** It is already open, so restoring is a no-op for this one. Kept in the
   *  plan rather than filtered out, because "6 of 9 are already back" is the
   *  useful thing to show someone deciding whether to press the button. */
  present: boolean;
}

export interface RestorePlan {
  from: WorkspaceSnapshot | null;
  items: RestoreItem[];
  /** How old the snapshot is, for "you were working on this an hour ago". */
  ageMs: number;
  /** Excluded apps and windows, carried up from the snapshot. */
  excluded: number;
}

/** A restore opens windows on someone's machine. A snapshot of a long day
 *  could hold forty; twelve is a plan a person can read before agreeing to it. */
export const MAX_RESTORE_ITEMS = 12;

export const EMPTY_PLAN: RestorePlan = { from: null, items: [], ageMs: 0, excluded: 0 };

/** The last path component, unescaped — "Q3 Migration.md" rather than the
 *  whole file URL, which is unreadable in a list. */
export function fileLabel(target: string): string {
  const withoutQuery = target.split('?')[0]!;
  const last = withoutQuery.replace(/\/+$/, '').split('/').pop() ?? target;
  try {
    return decodeURIComponent(last) || target;
  } catch {
    return last || target;
  }
}

/** A URL as a person reads it: the host and the first path segment, which is
 *  usually the only part that identifies the page in a list. */
export function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname.replace(/^www\./, '')}${path}`.slice(0, 70);
  } catch {
    return url.slice(0, 70);
  }
}

const sameDoc = (a: string, b: string) => normalizeTarget(a) === normalizeTarget(b);

/** `file:///Users/x/a%20b.md` and `/Users/x/a b.md` are the same document. */
export function normalizeTarget(t: string): string {
  let s = t.trim();
  if (s.startsWith('file://')) s = s.slice('file://'.length);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* a target with a stray % is still a target */
  }
  return s.replace(/\/+$/, '');
}

/** URLs match when they are the same page, ignoring a trailing slash and the
 *  fragment — coming back to `#section-3` of the page you had open is back. */
export function samePage(a: string, b: string): boolean {
  const strip = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  return strip(a) === strip(b);
}

/**
 * What to open to get back to `snapshot`, given what is open `now`.
 *
 * The rules, in the order they matter:
 *
 *   - **A document or a page is the thing worth restoring**, not the app. Six
 *     Chrome windows are six pages; "open Chrome" would get none of them back.
 *   - **An app with nothing identifiable in it** — a terminal, a chat app — is
 *     restored as itself, and only when it is not already running.
 *   - **Opening a document launches its app**, so an app that has documents to
 *     restore never also appears as a bare `app` item.
 *   - **Minimised is still open.** It is in the snapshot because it was part of
 *     the arrangement, and it is `present` now because it still is.
 */
export function planRestore(
  snapshot: WorkspaceSnapshot | null,
  now: WorkspaceSnapshot | null,
  at = Date.now(),
): RestorePlan {
  if (!snapshot) return EMPTY_PLAN;
  const running = new Map<string, WorkspaceApp>();
  for (const a of now?.apps ?? []) running.set(a.bundleId, a);

  const items: RestoreItem[] = [];
  for (const app of snapshot.apps) {
    const live = running.get(app.bundleId);
    const docs = new Set<string>();
    const pages = new Set<string>();

    for (const w of app.windows) {
      if (w.document && !docs.has(normalizeTarget(w.document))) {
        docs.add(normalizeTarget(w.document));
        items.push({
          kind: 'document',
          bundleId: app.bundleId,
          appName: app.appName,
          target: w.document,
          label: fileLabel(w.document),
          present: !!live?.windows.some((x) => x.document && sameDoc(x.document, w.document!)),
        });
      } else if (w.url && !pages.has(w.url)) {
        pages.add(w.url);
        items.push({
          kind: 'page',
          bundleId: app.bundleId,
          appName: app.appName,
          target: w.url,
          label: pageLabel(w.url),
          present: !!live?.windows.some((x) => x.url && samePage(x.url, w.url!)),
        });
      }
    }

    // Nothing in this app was identifiable: the app itself is the thing that
    // was open. Also covers an app whose windows are all untitled.
    if (!docs.size && !pages.size) {
      items.push({
        kind: 'app',
        bundleId: app.bundleId,
        appName: app.appName,
        label: app.windows.find((w) => w.title)?.title || app.appName,
        present: !!live,
      });
    }
  }

  // What is missing comes first: it is what the button is for, and a list that
  // opens with six already-back rows reads as a list of nothing to do.
  items.sort((a, b) => Number(a.present) - Number(b.present));
  return {
    from: snapshot,
    items: items.slice(0, MAX_RESTORE_ITEMS),
    ageMs: Math.max(0, at - snapshot.t),
    excluded: snapshot.excluded,
  };
}

/** One line for the island and the menu bar: "6 windows from this morning". */
export function describePlan(plan: RestorePlan, at = Date.now()): string {
  const missing = plan.items.filter((i) => !i.present);
  if (!plan.from || !missing.length) return 'Everything you had open is already back.';
  const when = timeOfDay(plan.from.t, at);
  const apps = [...new Set(missing.map((i) => i.appName))];
  const what = `${missing.length} thing${missing.length === 1 ? '' : 's'}`;
  return `${what} from ${when} — ${apps.slice(0, 3).join(', ')}${apps.length > 3 ? ` and ${apps.length - 3} more` : ''}`;
}

/** "this morning", "yesterday afternoon", "Monday evening" — how someone
 *  refers to when they were last working, rather than a timestamp. */
export function timeOfDay(t: number, at = Date.now()): string {
  const then = new Date(t);
  const now = new Date(at);
  const part = then.getHours() < 12 ? 'morning' : then.getHours() < 18 ? 'afternoon' : 'evening';
  const days = Math.floor((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return at - t < 2 * 3_600_000 ? `earlier this ${part}` : `this ${part}`;
  if (days === 1) return `yesterday ${part}`;
  if (days < 7) return `${then.toLocaleDateString(undefined, { weekday: 'long' })} ${part}`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
