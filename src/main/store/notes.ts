import { getDb } from './db.js';
import { log } from '../log.js';
import {
  betterDisplayName,
  betterIdentifier,
  candidateKeys,
  mergeAliases,
  normalizeIdentifier,
  sameEntity,
} from '../notes/identity.js';
import type {
  AnyNote,
  NoteDetail,
  NoteFrameRef,
  NoteRow,
  NoteSearchHit,
  NoteType,
  NotesStats,
  ObservationRow,
  ObservedEntity,
  RelationKind,
  RelationRow,
  TaskRow,
  TaskScope,
  TaskStatus,
} from '../../shared/types.js';

/// `observations`, `notes`, `note_links`, `notes_fts`, `relations`, `tasks` —
/// created at M1, first written here (PRD §4).
///
/// Two shapes live in `notes`: the row itself, and a side table carrying the
/// per-type columns. Every write goes through one of the three `upsert`
/// functions so the two can never disagree, and every read joins them so the
/// renderer sees one object.

// ── Observations (T2) ────────────────────────────────────────────────────────

export const observations = {
  insert(o: {
    tsStart: number;
    tsEnd: number;
    summary: string;
    apps: string[];
    entities: ObservedEntity[];
    confidence: number;
    frameIds: number[];
  }): ObservationRow {
    const info = getDb()
      .prepare(
        `INSERT INTO observations (ts_start, ts_end, summary, apps_json, entities_json, confidence, frame_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.tsStart,
        o.tsEnd,
        o.summary,
        JSON.stringify(o.apps),
        JSON.stringify(o.entities),
        o.confidence,
        JSON.stringify(o.frameIds),
      );
    return { ...o, id: Number(info.lastInsertRowid) };
  },

  recent(limit = 20): ObservationRow[] {
    return (
      getDb().prepare('SELECT * FROM observations ORDER BY ts_start DESC LIMIT ?').all(limit) as RawObs[]
    ).map(toObs);
  },

  between(from: number, to: number): ObservationRow[] {
    return (
      getDb()
        .prepare('SELECT * FROM observations WHERE ts_start >= ? AND ts_start < ? ORDER BY ts_start')
        .all(from, to) as RawObs[]
    ).map(toObs);
  },

  byIds(ids: number[]): ObservationRow[] {
    if (!ids.length) return [];
    const q = ids.map(() => '?').join(',');
    return (
      getDb().prepare(`SELECT * FROM observations WHERE id IN (${q}) ORDER BY ts_start`).all(...ids) as RawObs[]
    ).map(toObs);
  },

  latest(): ObservationRow | null {
    const r = getDb().prepare('SELECT * FROM observations ORDER BY ts_start DESC LIMIT 1').get() as
      | RawObs
      | undefined;
    return r ? toObs(r) : null;
  },

  count(): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
  },
};

interface RawObs {
  id: number;
  ts_start: number;
  ts_end: number;
  summary: string;
  apps_json: string;
  entities_json: string;
  confidence: number;
  frame_ids_json: string;
}

const parse = <T>(s: string, fallback: T): T => {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const toObs = (r: RawObs): ObservationRow => ({
  id: r.id,
  tsStart: r.ts_start,
  tsEnd: r.ts_end,
  summary: r.summary,
  apps: parse<string[]>(r.apps_json, []),
  entities: parse<ObservedEntity[]>(r.entities_json, []),
  confidence: r.confidence,
  frameIds: parse<number[]>(r.frame_ids_json, []),
});

// ── Notes ────────────────────────────────────────────────────────────────────

interface RawNote {
  id: number;
  type: NoteType;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  salience: number;
  source_obs_json: string;
  // Joined, present only for the matching type.
  kind: RelationKind | null;
  identifier: string | null;
  display_name: string | null;
  aliases_json: string | null;
  frequency: number | null;
  rel_last_seen_at: number | null;
  status: TaskStatus | null;
  scope: TaskScope | null;
  task_last_seen_at: number | null;
  next_check_at: number | null;
  artifacts_json: string | null;
}

const SELECT_NOTE = `
  SELECT n.*,
         r.kind, r.identifier, r.display_name, r.aliases_json, r.frequency,
         r.last_seen_at AS rel_last_seen_at,
         t.status, t.scope, t.last_seen_at AS task_last_seen_at,
         t.next_check_at, t.artifacts_json
    FROM notes n
    LEFT JOIN relations r ON r.note_id = n.id
    LEFT JOIN tasks     t ON t.note_id = n.id
`;

function toNote(r: RawNote): AnyNote {
  const base: NoteRow = {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    salience: r.salience,
    sourceObs: parse<number[]>(r.source_obs_json, []),
  };
  if (r.type === 'relation' && r.kind) {
    return {
      ...base,
      type: 'relation',
      kind: r.kind,
      identifier: r.identifier ?? '',
      displayName: r.display_name ?? r.title,
      aliases: parse<string[]>(r.aliases_json ?? '[]', []),
      frequency: r.frequency ?? 1,
      lastSeenAt: r.rel_last_seen_at ?? r.updated_at,
    } satisfies RelationRow;
  }
  if (r.type === 'task' && r.status) {
    return {
      ...base,
      type: 'task',
      status: r.status,
      scope: r.scope ?? 'session',
      lastSeenAt: r.task_last_seen_at ?? r.updated_at,
      nextCheckAt: r.next_check_at,
      artifacts: parse<string[]>(r.artifacts_json ?? '[]', []),
    } satisfies TaskRow;
  }
  return base;
}

export const notes = {
  get(id: number): AnyNote | null {
    const r = getDb().prepare(`${SELECT_NOTE} WHERE n.id = ?`).get(id) as RawNote | undefined;
    return r ? toNote(r) : null;
  },

  list(type: NoteType, limit = 100): AnyNote[] {
    return (
      getDb()
        .prepare(`${SELECT_NOTE} WHERE n.type = ? ORDER BY n.updated_at DESC LIMIT ?`)
        .all(type, limit) as RawNote[]
    ).map(toNote);
  },

  /** A plain note row. Relations and tasks go through their own upserts, which
   *  call this and then write the side table in the same transaction. */
  create(n: { type: NoteType; title: string; body: string; salience?: number; sourceObs?: number[] }): number {
    const now = Date.now();
    const info = getDb()
      .prepare(
        `INSERT INTO notes (type, title, body, created_at, updated_at, salience, source_obs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(n.type, n.title, n.body, now, now, n.salience ?? 0, JSON.stringify(n.sourceObs ?? []));
    return Number(info.lastInsertRowid);
  },

  /** Editing is a product requirement, not a convenience: buddy's memory has to
   *  feel correctable (§8.3). A user edit bumps `updated_at`, which is what the
   *  FTS trigger keys off, so search follows the edit immediately. */
  update(
    id: number,
    patch: { title?: string; body?: string; salience?: number; sourceObs?: number[] },
  ): AnyNote | null {
    const existing = this.get(id);
    if (!existing) return null;
    getDb()
      .prepare('UPDATE notes SET title = ?, body = ?, salience = ?, source_obs_json = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? existing.title,
        patch.body ?? existing.body,
        patch.salience ?? existing.salience,
        JSON.stringify(patch.sourceObs ?? existing.sourceObs),
        Date.now(),
        id,
      );
    return this.get(id);
  },

  delete(id: number): void {
    // `relations`, `tasks`, and `note_links` cascade; the FTS trigger cleans the
    // index. `foreign_keys = ON` is set in db.ts, which is what makes that true.
    getDb().prepare('DELETE FROM notes WHERE id = ?').run(id);
  },

  /**
   * FTS5 search (PRD §9, the `NoteSearch` seam).
   *
   * The query is turned into a prefix match over quoted terms rather than
   * passed through: FTS5's query language treats `"`, `*`, `^`, `-`, `NEAR`,
   * and `:` as syntax, so a user typing `priya's "q3"` would otherwise get a
   * parse error instead of results. Quoting each term makes every character
   * literal; the trailing `*` keeps search live-as-you-type.
   */
  search(query: string, type?: NoteType, limit = 50): NoteSearchHit[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');

    try {
      const rows = getDb()
        .prepare(
          `${SELECT_NOTE.replace('FROM notes n', 'FROM notes_fts f JOIN notes n ON n.id = f.rowid')}
           WHERE notes_fts MATCH ? ${type ? 'AND n.type = ?' : ''}
           ORDER BY bm25(notes_fts, 4.0, 1.0)
           LIMIT ?`,
        )
        .all(...(type ? [match, type, limit] : [match, limit])) as (RawNote & { snippet?: string })[];

      const snippets = new Map<number, string>();
      for (const r of getDb()
        .prepare(
          `SELECT rowid AS id, snippet(notes_fts, 1, '«', '»', '…', 12) AS s
             FROM notes_fts WHERE notes_fts MATCH ? LIMIT ?`,
        )
        .all(match, limit) as { id: number; s: string }[]) {
        snippets.set(r.id, r.s);
      }
      return rows.map((r) => ({ note: toNote(r), snippet: snippets.get(r.id) ?? r.body.slice(0, 160) }));
    } catch (e) {
      log.warn('notes', 'FTS query failed', { query, error: (e as Error).message });
      return [];
    }
  },

  /** Links are undirected in meaning but stored one way; both directions are
   *  read so a task linked to a person shows up on the person too. */
  link(noteId: number, relatedNoteId: number, kind: string): void {
    if (noteId === relatedNoteId) return;
    getDb()
      .prepare('INSERT OR IGNORE INTO note_links (note_id, related_note_id, kind) VALUES (?, ?, ?)')
      .run(noteId, relatedNoteId, kind);
  },

  linksFor(noteId: number): { note: AnyNote; kind: string }[] {
    const rows = getDb()
      .prepare(
        `${SELECT_NOTE}
           JOIN note_links l
             ON (l.related_note_id = n.id AND l.note_id = ?)
             OR (l.note_id = n.id AND l.related_note_id = ?)
          WHERE n.id != ?`,
      )
      .all(noteId, noteId, noteId) as (RawNote & { kind_col?: string })[];
    const kinds = new Map<number, string>();
    for (const l of getDb()
      .prepare('SELECT note_id, related_note_id, kind FROM note_links WHERE note_id = ? OR related_note_id = ?')
      .all(noteId, noteId) as { note_id: number; related_note_id: number; kind: string }[]) {
      kinds.set(l.note_id === noteId ? l.related_note_id : l.note_id, l.kind);
    }
    const seen = new Set<number>();
    const out: { note: AnyNote; kind: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ note: toNote(r), kind: kinds.get(r.id) ?? 'related' });
    }
    return out;
  },

  /**
   * Everything the detail view needs, including the frames the note came from.
   *
   * Expired frames are returned as rows with `expired: true` rather than
   * omitted. That is the whole point of tombstoning instead of deleting (§5.1):
   * the note can still say *"this came from three frames, and they are gone"*,
   * which is a true and useful statement, where a silently shorter list is a
   * quiet lie about where the note came from.
   */
  detail(id: number): NoteDetail | null {
    const note = this.get(id);
    if (!note) return null;
    const obs = observations.byIds(note.sourceObs);
    const frameIds = [...new Set(obs.flatMap((o) => o.frameIds))];
    return {
      note,
      linked: this.linksFor(id),
      frames: framesFor(frameIds),
      observations: obs,
    };
  },

  stats(): NotesStats {
    const db = getDb();
    const one = (sql: string, ...args: unknown[]) =>
      (db.prepare(sql).get(...args) as { n: number | null }).n ?? 0;
    return {
      observations: one('SELECT COUNT(*) AS n FROM observations'),
      recaps: one("SELECT COUNT(*) AS n FROM notes WHERE type = 'recap'"),
      relations: one("SELECT COUNT(*) AS n FROM notes WHERE type = 'relation'"),
      tasks: one("SELECT COUNT(*) AS n FROM notes WHERE type = 'task'"),
      openTasks: one("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('open','blocked','waiting')"),
      lastObservationAt: (db.prepare('SELECT MAX(ts_end) AS n FROM observations').get() as { n: number | null })
        .n,
      lastRollupAt: (
        db.prepare("SELECT MAX(updated_at) AS n FROM notes WHERE type = 'recap'").get() as {
          n: number | null;
        }
      ).n,
      sessionStartedAt: null, // filled in by the engine, which owns the session
    };
  },
};

/** Frame rows for a note's citations, tombstones included. */
export function framesFor(ids: number[]): NoteFrameRef[] {
  if (!ids.length) return [];
  const q = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT id, ts, app_name, window_title, path, deleted_at FROM frames WHERE id IN (${q}) ORDER BY ts`)
    .all(...ids) as {
    id: number;
    ts: number;
    app_name: string;
    window_title: string;
    path: string;
    deleted_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    appName: r.app_name,
    windowTitle: r.window_title,
    path: r.deleted_at == null && r.path ? r.path : null,
    expired: r.deleted_at != null || !r.path,
  }));
}

// ── Relations ────────────────────────────────────────────────────────────────

export interface RelationInput {
  kind: RelationKind;
  displayName: string;
  identifier?: string;
  aliases?: string[];
  note?: string;
  seenAt?: number;
  sourceObs?: number[];
}

export const relations = {
  all(limit = 500): RelationRow[] {
    return notes.list('relation', limit) as RelationRow[];
  },

  byKind(kind: RelationKind): RelationRow[] {
    return this.all().filter((r) => r.kind === kind);
  },

  /** Every relation whose identifier or aliases mention one of these app
   *  bundle ids or names. The Context Bundle asks for exactly this: relations
   *  matching the apps on screen (§6.1). */
  matchingApps(appIdentifiers: string[]): RelationRow[] {
    if (!appIdentifiers.length) return [];
    const keys = new Set(appIdentifiers.flatMap((a) => candidateKeys('app', a)));
    return this.all().filter(
      (r) =>
        keys.has(r.identifier) ||
        r.aliases.some((a) => keys.has(a)) ||
        [...keys].some((k) => k.length >= 4 && r.identifier.includes(k)),
    );
  },

  /**
   * The merge (PRD §4.1). One row per entity, whatever it was called.
   *
   * Three lookups, in descending confidence: the exact canonical identifier,
   * then any alias, then `sameEntity` across every row of the same kind — which
   * is what catches "Priya" arriving after "Priya Raman" already exists.
   *
   * When a merge promotes the identifier (a first name becoming an email), the
   * old identifier becomes an alias in the same transaction, so the next
   * "Priya" still lands here rather than starting a sixth row.
   */
  upsert(input: RelationInput): RelationRow {
    const db = getDb();
    const seenAt = input.seenAt ?? Date.now();
    const incoming = normalizeIdentifier(input.kind, input.identifier || input.displayName);
    if (!incoming) throw new Error('a relation needs an identifier or a display name');

    const spellings = [input.identifier, input.displayName, ...(input.aliases ?? [])].filter(
      (s): s is string => !!s && !!s.trim(),
    );

    const tx = db.transaction((): number => {
      const existing = this.all().filter((r) => r.kind === input.kind);
      // Every row this spelling could be. More than one means two rows that
      // should always have been one — fold them together rather than picking.
      const hits = existing.filter((r) =>
        spellings.some(
          (s) =>
            sameEntity(input.kind, r.identifier, s) ||
            r.aliases.some((a) => sameEntity(input.kind, a, s)),
        ),
      );

      if (!hits.length) {
        const identifier = incoming;
        const noteId = notes.create({
          type: 'relation',
          title: input.displayName.trim() || identifier,
          body: input.note ?? '',
          salience: 0,
          sourceObs: input.sourceObs ?? [],
        });
        db.prepare(
          `INSERT INTO relations (note_id, kind, identifier, display_name, aliases_json, frequency, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        ).run(
          noteId,
          input.kind,
          identifier,
          input.displayName.trim() || identifier,
          JSON.stringify(mergeAliases(input.kind, identifier, spellings)),
          seenAt,
        );
        return noteId;
      }

      // Keep the oldest row: its id is the one links and source observations
      // already point at, and churning that would orphan them.
      const keep = hits.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      const fold = hits.filter((r) => r.id !== keep.id);

      let identifier = keep.identifier;
      let displayName = keep.displayName;
      let aliasPool: string[] = [...keep.aliases, keep.identifier, keep.displayName];
      let frequency = keep.frequency;
      let lastSeen = Math.max(keep.lastSeenAt, seenAt);
      let body = keep.body;
      const sourceObs = new Set(keep.sourceObs);

      for (const other of fold) {
        aliasPool.push(...other.aliases, other.identifier, other.displayName);
        frequency += other.frequency;
        lastSeen = Math.max(lastSeen, other.lastSeenAt);
        displayName = betterDisplayName(displayName, other.displayName);
        identifier = betterIdentifier(input.kind, identifier, other.identifier);
        for (const o of other.sourceObs) sourceObs.add(o);
        if (!body.trim() && other.body.trim()) body = other.body;
        // Repoint links before the row goes, or they cascade away with it.
        db.prepare('UPDATE OR IGNORE note_links SET note_id = ? WHERE note_id = ?').run(keep.id, other.id);
        db.prepare('UPDATE OR IGNORE note_links SET related_note_id = ? WHERE related_note_id = ?').run(
          keep.id,
          other.id,
        );
        db.prepare('DELETE FROM note_links WHERE note_id = related_note_id').run();
        // Delete before the kept row takes the identifier: the unique index on
        // (kind, identifier) would otherwise reject the promotion.
        db.prepare('DELETE FROM notes WHERE id = ?').run(other.id);
        log.info('notes', 'relations merged', {
          kept: keep.id,
          dropped: other.id,
          kind: input.kind,
          identifier,
        });
      }

      for (const s of spellings) aliasPool.push(s);
      displayName = betterDisplayName(displayName, input.displayName);
      identifier = betterIdentifier(input.kind, identifier, incoming);
      frequency += 1;
      for (const o of input.sourceObs ?? []) sourceObs.add(o);
      if (input.note?.trim()) body = input.note.trim();

      db.prepare(
        'UPDATE relations SET identifier = ?, display_name = ?, aliases_json = ?, frequency = ?, last_seen_at = ? WHERE note_id = ?',
      ).run(
        identifier,
        displayName,
        JSON.stringify(mergeAliases(input.kind, identifier, aliasPool)),
        frequency,
        lastSeen,
        keep.id,
      );
      db.prepare('UPDATE notes SET title = ?, body = ?, source_obs_json = ?, updated_at = ? WHERE id = ?').run(
        displayName,
        body,
        JSON.stringify([...sourceObs]),
        Date.now(),
        keep.id,
      );
      return keep.id;
    });

    const id = tx();
    return notes.get(id) as RelationRow;
  },
};

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * The task lifecycle (PRD §4.1).
 *
 * Every transition is legal except the ones that are not: `done` reopening is
 * allowed (a user marks something done, then finds it was not) and logged,
 * because refusing it would make the memory uncorrectable. What this table
 * exists for is to reject nonsense — a status that is not one of the four —
 * loudly at the write rather than at the read, when it is a `CHECK` constraint
 * failure three layers down with no context.
 */
export const TASK_STATUSES: TaskStatus[] = ['open', 'blocked', 'waiting', 'done'];
export const TASK_SCOPES: TaskScope[] = ['session', 'day', 'week'];

/** Scope widens as a task survives its window: a session task still open when
 *  the session ends is a day task, and a day task alive at midnight is a week
 *  task. Without this, `scope` would be a label nobody ever changed and every
 *  task would read as "session" forever. It only ever widens. */
const WIDER: Record<TaskScope, TaskScope | null> = { session: 'day', day: 'week', week: null };

export interface TaskInput {
  title: string;
  body?: string;
  status?: TaskStatus;
  scope?: TaskScope;
  artifacts?: string[];
  seenAt?: number;
  sourceObs?: number[];
  /** When the model is updating a task it was shown, this is its note id. */
  id?: number | null;
}

export const tasks = {
  all(limit = 200): TaskRow[] {
    return notes.list('task', limit) as TaskRow[];
  },

  open(): TaskRow[] {
    return (
      getDb()
        .prepare(
          `${SELECT_NOTE} WHERE n.type = 'task' AND t.status IN ('open','blocked','waiting')
           ORDER BY t.last_seen_at DESC`,
        )
        .all() as RawNote[]
    ).map(toNote) as TaskRow[];
  },

  /** The provisional goal's source (§6.1 step 2). Deliberately one indexed
   *  query: it runs on the hotkey, before anything else, and the 200 ms budget
   *  is the whole reason it exists. */
  newestOpen(): TaskRow | null {
    const r = getDb()
      .prepare(
        `${SELECT_NOTE} WHERE n.type = 'task' AND t.status IN ('open','blocked','waiting')
         ORDER BY t.last_seen_at DESC LIMIT 1`,
      )
      .get() as RawNote | undefined;
    return r ? (toNote(r) as TaskRow) : null;
  },

  /**
   * Create or update. A caller that knows the note id updates it; otherwise a
   * title match against open tasks does, so a rollup that re-describes the same
   * task in slightly different words does not create a second card.
   */
  upsert(input: TaskInput): TaskRow {
    const db = getDb();
    const seenAt = input.seenAt ?? Date.now();
    const status = input.status ?? 'open';
    if (!TASK_STATUSES.includes(status)) throw new Error(`not a task status: ${status}`);
    const scope = input.scope ?? 'session';
    if (!TASK_SCOPES.includes(scope)) throw new Error(`not a task scope: ${scope}`);

    const tx = db.transaction((): number => {
      const existing = asTask(input.id != null ? notes.get(input.id) : null) ?? matchByTitle(input.title);

      if (!existing) {
        const noteId = notes.create({
          type: 'task',
          title: input.title,
          body: input.body ?? '',
          salience: 0,
          sourceObs: input.sourceObs ?? [],
        });
        db.prepare(
          `INSERT INTO tasks (note_id, status, scope, last_seen_at, next_check_at, artifacts_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          noteId,
          status,
          scope,
          seenAt,
          status === 'waiting' ? seenAt + WAITING_CHECK_MS : null,
          JSON.stringify(input.artifacts ?? []),
        );
        return noteId;
      }

      return applyTransition(existing, { ...input, status, scope, seenAt });
    });

    return notes.get(tx()) as TaskRow;
  },

  /** An explicit status change, from the UI or from a run's outcome. */
  setStatus(id: number, status: TaskStatus, seenAt = Date.now()): TaskRow | null {
    const existing = asTask(notes.get(id));
    if (!existing) return null;
    if (!TASK_STATUSES.includes(status)) throw new Error(`not a task status: ${status}`);
    applyTransition(existing, { title: existing.title, status, seenAt });
    return notes.get(id) as TaskRow;
  },

  setScope(id: number, scope: TaskScope): TaskRow | null {
    const existing = asTask(notes.get(id));
    if (!existing) return null;
    if (!TASK_SCOPES.includes(scope)) throw new Error(`not a task scope: ${scope}`);
    getDb().prepare('UPDATE tasks SET scope = ? WHERE note_id = ?').run(scope, id);
    getDb().prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return notes.get(id) as TaskRow;
  },

  /**
   * Widen the scope of every still-open task whose window has closed.
   *
   * Called at session end (`session` → `day`) and at midnight (`day` → `week`).
   * Passing the boundary that just closed keeps the two callers from having to
   * agree on anything but their own clock.
   */
  widenScopes(from: TaskScope, now = Date.now()): number {
    const to = WIDER[from];
    if (!to) return 0;
    const info = getDb()
      .prepare(
        `UPDATE tasks SET scope = ?
          WHERE scope = ? AND status IN ('open','blocked','waiting')`,
      )
      .run(to, from);
    if (info.changes > 0) {
      getDb()
        .prepare(
          `UPDATE notes SET updated_at = ?
            WHERE type = 'task' AND id IN (SELECT note_id FROM tasks WHERE scope = ?)`,
        )
        .run(now, to);
      log.info('notes', 'task scopes widened', { from, to, count: info.changes });
    }
    return info.changes;
  },

  /** M4's standby reads this: everything parked on something changing. */
  dueForCheck(now = Date.now()): TaskRow[] {
    return (
      getDb()
        .prepare(
          `${SELECT_NOTE} WHERE n.type = 'task' AND t.status IN ('blocked','waiting')
             AND t.next_check_at IS NOT NULL AND t.next_check_at <= ?
           ORDER BY t.next_check_at`,
        )
        .all(now) as RawNote[]
    ).map(toNote) as TaskRow[];
  },
};

/** How long after going `waiting` a task first wants looking at. M4's wakeups
 *  own the real schedule; this is the default that makes `next_check_at`
 *  non-null the moment the status changes, so nothing is left with no clock. */
const WAITING_CHECK_MS = 5 * 60_000;

/** A note is a task only when its side row exists too. A `notes` row of type
 *  `task` with no `tasks` row is not something foreign keys allow, but reading
 *  it as one would produce a task with no status, and the narrowing is free. */
function asTask(n: AnyNote | null): TaskRow | null {
  return n && n.type === 'task' && 'status' in n ? n : null;
}

function matchByTitle(title: string): TaskRow | null {
  const key = title.trim().toLowerCase();
  if (!key) return null;
  return tasks.open().find((t) => t.title.trim().toLowerCase() === key) ?? null;
}

/** The one place a task's status actually changes, so the log has one line per
 *  transition and `next_check_at` cannot drift from `status`. */
function applyTransition(existing: TaskRow, input: TaskInput & { seenAt: number }): number {
  const db = getDb();
  const before = existing.status;
  const after = input.status ?? before;
  const scope = input.scope ?? existing.scope;
  const wasDone = before === 'done';

  if (before !== after) {
    log.info('notes', 'task status changed', { id: existing.id, from: before, to: after });
    if (wasDone && after !== 'done') {
      log.info('notes', 'a done task was reopened', { id: existing.id, to: after });
    }
  }

  db.prepare(
    `UPDATE tasks SET status = ?, scope = ?, last_seen_at = ?, next_check_at = ?, artifacts_json = ?
      WHERE note_id = ?`,
  ).run(
    after,
    scope,
    input.seenAt,
    after === 'waiting' || after === 'blocked' ? input.seenAt + WAITING_CHECK_MS : null,
    JSON.stringify(input.artifacts ?? existing.artifacts),
    existing.id,
  );

  const mergedObs = [...new Set([...existing.sourceObs, ...(input.sourceObs ?? [])])];
  db.prepare('UPDATE notes SET title = ?, body = ?, source_obs_json = ?, updated_at = ? WHERE id = ?').run(
    input.title.trim() || existing.title,
    input.body ?? existing.body,
    JSON.stringify(mergedObs),
    Date.now(),
    existing.id,
  );
  return existing.id;
}
