import { EventEmitter } from 'node:events';
import { getDb } from '../store/db.js';
import { log } from '../log.js';
import { embedder, type Embedder } from './embed.js';
import { vectors } from './vectors.js';
import { episodeText } from './episodes.js';
import type { EpisodeView, MemoryIndexStatus, MemorySource } from '../../shared/types.js';

/// Keeps one index row per memory item — its text, and its vector when a model
/// is installed — and no stale ones.
///
/// **What is owed is computed from the rows, not tracked.** There are no
/// hooks in the note store, the rollup, or the fact store saying "embed this
/// now" — every one of those would be a place to forget. Instead `sync()` asks
/// SQLite which rows have no vector, or a vector older than their
/// `updated_at`, or a vector for a row that no longer exists, and fixes
/// exactly those. It is the same rule `unrolledObservationIds` follows for
/// recaps: a restart, a crash, or a write from some code path nobody thought
/// of loses nothing, because the next sync finds it.
///
/// Static embeddings make this cheap enough to run eagerly. A year of
/// observations is ~50,000 rows and embeds in a few seconds; a normal sync
/// after a rollup is a handful of rows and well under a millisecond each.

/** Rows per slice of a background sync. Small enough that a first-launch
 *  backfill of a big database never holds the main process for long. */
const SLICE = 256;

interface Pending {
  source: MemorySource;
  id: number;
  version: number;
  text: string;
}

/** The text a note is embedded as. Relations carry their kind and aliases,
 *  because "who is the PM on Acme" should find the person whose note only
 *  says "Acme's product lead". */
function noteText(r: {
  type: string;
  title: string;
  body: string;
  kind: string | null;
  aliases_json: string | null;
  artifacts_json: string | null;
}): string {
  const body = r.body.trim();
  if (r.type === 'relation') {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(r.aliases_json ?? '[]');
    } catch {
      /* none */
    }
    const aka = aliases.slice(0, 4).join(', ');
    return `${r.title} (${r.kind ?? 'relation'}${aka ? `, also ${aka}` : ''}). ${body}`;
  }
  if (r.type === 'task') {
    let artifacts: string[] = [];
    try {
      artifacts = JSON.parse(r.artifacts_json ?? '[]');
    } catch {
      /* none */
    }
    return `${r.title}. ${body}${artifacts.length ? ` Touches: ${artifacts.slice(0, 6).join(', ')}.` : ''}`;
  }
  return `${r.title}. ${body}`;
}

function obsText(r: { summary: string; apps_json: string }): string {
  let apps: string[] = [];
  try {
    apps = JSON.parse(r.apps_json);
  } catch {
    /* none */
  }
  return apps.length ? `${r.summary} (${apps.slice(0, 5).join(', ')})` : r.summary;
}

export class MemoryIndex extends EventEmitter {
  private model: Embedder | null = null;
  private opened = false;
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private lastError: string | null = null;

  /** Load the embedder and attach the vector store. Safe to call again — the
   *  checks do, after swapping the model. */
  open(opts: { accelerate?: boolean } = {}): void {
    this.model = embedder();
    vectors.open(this.model, opts);
    this.opened = true;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    vectors.close();
    this.opened = false;
    this.model = null;
  }

  embedderReady(): boolean {
    return this.opened && !!this.model;
  }

  isOpen(): boolean {
    return this.opened;
  }

  embed(text: string): Float32Array | null {
    return this.model?.embed(text) ?? null;
  }

  /**
   * Embed everything owed, up to `maxItems`. Synchronous.
   *
   * `full` also looks for vectors of deleted observations, which is a scan of
   * every observation vector and so only worth doing at launch: observations
   * are never deleted except by "forget everything", which clears its own.
   */
  sync(opts: { maxItems?: number; full?: boolean } = {}): { embedded: number; removed: number; remaining: boolean } {
    if (!this.opened) return { embedded: 0, removed: 0, remaining: false };
    const max = opts.maxItems ?? Number.POSITIVE_INFINITY;
    let removed = 0;
    let embedded = 0;
    try {
      removed = this.removeOrphans(opts.full ?? false);
      for (;;) {
        const batch = this.owed(Math.min(SLICE, max - embedded));
        if (!batch.length) return { embedded, removed, remaining: false };
        getDb().transaction(() => {
          for (const p of batch) {
            vectors.upsert(p.source, p.id, p.version, p.text, this.vectorFor(p.text));
            embedded++;
          }
        })();
        if (embedded >= max) return { embedded, removed, remaining: this.owed(1).length > 0 };
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      log.warn('memory', 'index sync failed; it will retry', { error: this.lastError });
      return { embedded, removed, remaining: true };
    }
  }

  /** Null for text with no letter or digit in it — "—", "…" — which would
   *  embed as the vector of a punctuation mark: similar to every other
   *  punctuation mark and to nothing anyone searches for. And null without a
   *  model, when the row is indexed for its words alone. */
  private vectorFor(text: string): Float32Array | null {
    if (!this.model || !/[\p{L}\p{N}]/u.test(text)) return null;
    return this.model.embed(text);
  }

  /** Index one fact right now. The fact merge needs a fact it just wrote to
   *  be findable by the next sentence in the same rollup, which a debounced
   *  background sync would not guarantee. */
  embedFact(id: number): void {
    if (!this.opened) return;
    const r = getDb().prepare('SELECT updated_at AS v, statement FROM facts WHERE id = ?').get(id) as
      | { v: number; statement: string }
      | undefined;
    if (r) vectors.upsert('fact', id, r.v, r.statement, this.vectorFor(r.statement));
  }

  /**
   * Sync in the background, a slice at a time, yielding between slices.
   *
   * Debounced: a rollup touches a dozen rows in a burst and they should be one
   * sync, not twelve.
   */
  schedule(delayMs = 250): void {
    if (!this.opened || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain() {
    if (this.syncing) return;
    this.syncing = true;
    const t0 = Date.now();
    let total = 0;
    try {
      for (;;) {
        const r = this.sync({ maxItems: SLICE });
        total += r.embedded;
        if (!r.remaining) break;
        await new Promise((res) => setImmediate(res));
      }
      if (total > 0) {
        log.debug('memory', 'index synced', { embedded: total, ms: Date.now() - t0 });
        this.emit('synced', this.status());
      }
    } finally {
      this.syncing = false;
    }
  }

  status(): MemoryIndexStatus {
    const counts = vectors.counts();
    return {
      model: this.model?.id ?? null,
      dim: this.model?.dim ?? 0,
      items: counts.total,
      bySource: counts.bySource,
      pending: this.opened ? this.owed(10_000).length : 0,
      accelerated: vectors.isAccelerated(),
      error: this.model ? this.lastError : this.opened ? 'The embedding model is not installed. Run `npm run fetch:model`.' : null,
    };
  }

  // ── What is owed ─────────────────────────────────────────────────────────

  private owed(limit: number): Pending[] {
    if (limit <= 0) return [];
    const db = getDb();
    const out: Pending[] = [];

    for (const r of db
      .prepare(
        `SELECT n.id, n.updated_at AS v, n.type, n.title, n.body, r.kind, r.aliases_json, t.artifacts_json
           FROM notes n
           LEFT JOIN relations r ON r.note_id = n.id
           LEFT JOIN tasks t ON t.note_id = n.id
           LEFT JOIN memory_vectors m ON m.source = 'note' AND m.source_id = n.id
          WHERE m.id IS NULL OR m.src_version != n.updated_at
          LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      v: number;
      type: string;
      title: string;
      body: string;
      kind: string | null;
      aliases_json: string | null;
      artifacts_json: string | null;
    }[]) {
      out.push({ source: 'note', id: r.id, version: r.v, text: noteText(r) });
    }
    if (out.length >= limit) return out;

    for (const r of db
      .prepare(
        `SELECT f.id, f.updated_at AS v, f.statement FROM facts f
           LEFT JOIN memory_vectors m ON m.source = 'fact' AND m.source_id = f.id
          WHERE m.id IS NULL OR m.src_version != f.updated_at
          LIMIT ?`,
      )
      .all(limit - out.length) as { id: number; v: number; statement: string }[]) {
      out.push({ source: 'fact', id: r.id, version: r.v, text: r.statement });
    }
    if (out.length >= limit) return out;

    for (const r of db
      .prepare(
        `SELECT e.* FROM episodes e
           LEFT JOIN memory_vectors m ON m.source = 'episode' AND m.source_id = e.id
          WHERE m.id IS NULL OR m.src_version != e.updated_at
          LIMIT ?`,
      )
      .all(limit - out.length) as {
      id: number;
      updated_at: number;
      kind: EpisodeView['kind'];
      goal: string;
      inferred_goal: string | null;
      goal_source: EpisodeView['goalSource'];
      status: string;
      summary: string;
    }[]) {
      out.push({
        source: 'episode',
        id: r.id,
        version: r.updated_at,
        text: episodeText({
          kind: r.kind,
          goal: r.goal,
          inferredGoal: r.inferred_goal,
          goalSource: r.goal_source,
          status: r.status,
          summary: r.summary,
        }),
      });
    }
    if (out.length >= limit) return out;

    // Observations are append-only, so a high-water mark is exact and avoids
    // an anti-join against what is, after a year, the biggest table here.
    const hwm =
      (db.prepare("SELECT MAX(source_id) AS n FROM memory_vectors WHERE source = 'observation'").get() as {
        n: number | null;
      }).n ?? 0;
    for (const r of db
      .prepare('SELECT id, ts_end, summary, apps_json FROM observations WHERE id > ? ORDER BY id LIMIT ?')
      .all(hwm, limit - out.length) as { id: number; ts_end: number; summary: string; apps_json: string }[]) {
      out.push({ source: 'observation', id: r.id, version: r.ts_end, text: obsText(r) });
    }
    return out;
  }

  /** Vectors whose row is gone: a deleted note, a forgotten fact, an episode
   *  whose run was deleted. */
  private removeOrphans(includeObservations: boolean): number {
    const db = getDb();
    const sources: [MemorySource, string][] = [
      ['note', 'notes'],
      ['fact', 'facts'],
      ['episode', 'episodes'],
    ];
    if (includeObservations) sources.push(['observation', 'observations']);
    let n = 0;
    for (const [source, table] of sources) {
      const gone = (
        db
          .prepare(
            `SELECT m.source_id AS id FROM memory_vectors m
              WHERE m.source = ? AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = m.source_id)`,
          )
          .all(source) as { id: number }[]
      ).map((r) => r.id);
      n += vectors.remove(source, gone);
    }
    return n;
  }
}

export const memoryIndex = new MemoryIndex();
