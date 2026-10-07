import path from 'node:path';
import type Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { getDb, kv } from '../store/db.js';
import { log } from '../log.js';
import { dot, type Embedder } from './embed.js';
import type { MemorySource } from '../../shared/types.js';

/// The memory index: one row per memory item with the text it is searched by
/// and its unit vector, and both kinds of search over it — nearest neighbours
/// by meaning, BM25 by words.
///
/// **Two layers, one truth.** `memory_vectors` is a plain table and the source
/// of truth. `memory_vec` is a sqlite-vec `vec0` virtual table — the "small
/// local vector database bundled with the app", 160 KB of C loaded into the
/// same SQLite file — and it is an *accelerator* rebuilt from the plain table
/// whenever the two disagree. That split is the same argument the wakeups
/// table makes: a row is the thing that survives. If the extension will not
/// load (an unsigned dylib, an architecture nobody built for), search by
/// meaning still works as a scan, and the next launch where it does load
/// rebuilds the index from rows that never stopped being written.
///
/// With no embedding model installed the rows still carry their text, so the
/// keyword half works on its own; the vectors fill in when a model appears.
///
/// Nothing here knows what a note or a fact is. It stores `(source, id) →
/// text, vector` and answers "what is nearest" and "what matches". What the
/// text *is*, and when it is stale, is `index.ts`'s business.

export interface VectorHit {
  source: MemorySource;
  sourceId: number;
  /** Cosine similarity, -1…1. Vectors are unit length, so it is a dot product. */
  similarity: number;
}

export interface WordHit {
  source: MemorySource;
  sourceId: number;
  /** FTS5 bm25(): negative, and lower is a better match. */
  bm25: number;
}

/** The model id rows are written under when no embedding model is loaded. */
const NO_MODEL = 'none';

/** sqlite-vec's ceiling on `k`. Asking for more is an error, not a clamp. */
const VEC0_MAX_K = 4096;

const STATE_KEY = 'memory.index';

/** Connections the extension is already loaded into. Loading it twice would
 *  re-register the `vec0` module under a table that is using it. */
const loadedInto = new WeakSet<Database.Database>();

class VectorStore {
  private accelerated = false;
  /** Null until `open`; `NO_MODEL` when open without an embedder. */
  private model: string | null = null;
  private dim = 0;
  private extensionError: string | null = null;
  private db: Database.Database | null = null;

  /**
   * Attach to the open database for this embedder.
   *
   * A different model than the one that wrote the index means every stored
   * vector is in a different space from every new one — comparing them is not
   * wrong loudly, it is wrong quietly, as search that slowly stops finding
   * things. So a model change empties the index and `index.ts` re-embeds
   * everything, which for a static model is seconds even for a year of notes.
   */
  open(embedder: Embedder | null, opts: { accelerate?: boolean } = {}): void {
    const db = getDb();
    this.db = db;
    // `accelerate: false` is the checks proving the fallback, on a machine
    // where the extension would otherwise load.
    this.accelerated = opts.accelerate === false ? false : this.loadExtension(db);
    const model = embedder?.id ?? NO_MODEL;
    const dim = embedder?.dim ?? 0;

    const prior = kv.get<{ model: string; dim: number } | null>(STATE_KEY, null);
    if (prior && (prior.model !== model || prior.dim !== dim)) {
      log.info('memory', 'embedding model changed; the index will be rebuilt', { from: prior.model, to: model });
      db.exec('DELETE FROM memory_vectors');
      if (this.tableExists(db)) {
        if (this.accelerated) db.exec('DROP TABLE memory_vec');
        else log.warn('memory', 'a stale vec0 table remains until sqlite-vec loads again');
      }
    }
    // Rows from an older embedder that slipped past (a crash between the
    // delete and the kv write) are worse than none.
    db.prepare('DELETE FROM memory_vectors WHERE model != ?').run(model);
    kv.set(STATE_KEY, { model, dim });
    this.model = model;
    this.dim = dim;
    if (!embedder) this.accelerated = false;

    if (this.accelerated) this.ensureAccelerator(db);
  }

  /** Dropped by the checks between scenarios; the app never closes it. */
  close() {
    this.db = null;
    this.accelerated = false;
    this.model = null;
  }

  isAccelerated() {
    return this.accelerated;
  }

  extensionProblem() {
    return this.extensionError;
  }

  modelId() {
    return this.model === NO_MODEL ? null : this.model;
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Write one item's text and vector. `vec` is null when there is nothing to
   * embed — text with no letters, or no model installed — and the row is then
   * found by its words only.
   */
  upsert(source: MemorySource, sourceId: number, srcVersion: number, text: string, vec: Float32Array | null): void {
    const db = this.handle();
    if (!this.model) throw new Error('vector store not open');
    if (vec && vec.length !== this.dim) throw new Error(`a ${vec.length}-d vector for a ${this.dim}-d index`);
    const blob = vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : Buffer.alloc(0);
    const row = db
      .prepare(
        `INSERT INTO memory_vectors (source, source_id, src_version, model, text, vector)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_id) DO UPDATE SET
           src_version = excluded.src_version, model = excluded.model,
           text = excluded.text, vector = excluded.vector
         RETURNING id`,
      )
      .get(source, sourceId, srcVersion, this.model, text, blob) as { id: number };
    if (this.accelerated) {
      // vec0 rowids must be bound as integers; a JS number binds as REAL.
      db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(BigInt(row.id));
      if (vec) {
        db.prepare('INSERT INTO memory_vec (rowid, embedding, source) VALUES (?, ?, ?)').run(BigInt(row.id), blob, source);
      }
    }
  }

  remove(source: MemorySource, sourceIds: number[]): number {
    if (!sourceIds.length) return 0;
    const db = this.handle();
    let n = 0;
    const find = db.prepare('SELECT id FROM memory_vectors WHERE source = ? AND source_id = ?');
    const del = db.prepare('DELETE FROM memory_vectors WHERE id = ?');
    const delVec = this.accelerated ? db.prepare('DELETE FROM memory_vec WHERE rowid = ?') : null;
    db.transaction(() => {
      for (const sid of sourceIds) {
        const r = find.get(source, sid) as { id: number } | undefined;
        if (!r) continue;
        del.run(r.id);
        delVec?.run(BigInt(r.id));
        n++;
      }
    })();
    return n;
  }

  /** Everything from one source, or everything. "Forget what you learned". */
  clear(sources?: MemorySource[]): void {
    const db = this.handle();
    if (!sources) {
      db.exec('DELETE FROM memory_vectors');
      if (this.accelerated) db.exec('DELETE FROM memory_vec');
      return;
    }
    const ids = (
      db
        .prepare(`SELECT id FROM memory_vectors WHERE source IN (${sources.map(() => '?').join(',')})`)
        .all(...sources) as { id: number }[]
    ).map((r) => r.id);
    db.transaction(() => {
      const del = db.prepare('DELETE FROM memory_vectors WHERE id = ?');
      const delVec = this.accelerated ? db.prepare('DELETE FROM memory_vec WHERE rowid = ?') : null;
      for (const id of ids) {
        del.run(id);
        delVec?.run(BigInt(id));
      }
    })();
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  get(source: MemorySource, sourceId: number): Float32Array | null {
    if (!this.db) return null;
    const r = this.db
      .prepare('SELECT vector FROM memory_vectors WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as { vector: Buffer } | undefined;
    return r && r.vector.byteLength ? toVec(r.vector) : null;
  }

  /**
   * The `k` nearest items to a unit query vector, nearest first.
   *
   * sqlite-vec when it is loaded; a scan of the plain table when it is not.
   * The two are asserted to agree by the memory checks, because a fallback
   * that ranks differently is a second search engine nobody tests.
   */
  knn(query: Float32Array, k: number, sources?: MemorySource[]): VectorHit[] {
    if (!this.db || !this.model || !this.dim || query.length !== this.dim || k <= 0) return [];
    return this.accelerated ? this.knnVec0(query, k, sources) : this.knnScan(query, k, sources);
  }

  /** Forced scan, for the checks' agreement test and nothing else. */
  knnScan(query: Float32Array, k: number, sources?: MemorySource[]): VectorHit[] {
    const db = this.handle();
    const where =
      'WHERE length(vector) > 0' +
      (sources?.length ? ` AND source IN (${sources.map(() => '?').join(',')})` : '');
    const top: VectorHit[] = [];
    for (const r of db
      .prepare(`SELECT source, source_id, vector FROM memory_vectors ${where}`)
      .iterate(...(sources ?? [])) as Iterable<{ source: MemorySource; source_id: number; vector: Buffer }>) {
      const similarity = dot(query, toVec(r.vector));
      if (top.length < k) {
        top.push({ source: r.source, sourceId: r.source_id, similarity });
        if (top.length === k) top.sort((a, b) => b.similarity - a.similarity);
      } else if (similarity > top[k - 1]!.similarity) {
        top[k - 1] = { source: r.source, sourceId: r.source_id, similarity };
        top.sort((a, b) => b.similarity - a.similarity);
      }
    }
    return top.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Keyword search over the same rows, by BM25. `match` is an FTS5 query —
   * `recall.ts` builds it so that every operator character is literal.
   */
  words(match: string, k: number, sources?: MemorySource[]): WordHit[] {
    if (!this.db || k <= 0) return [];
    const filter = sources?.length ? `AND m.source IN (${sources.map(() => '?').join(',')})` : '';
    try {
      return (
        this.db
          .prepare(
            `SELECT m.source, m.source_id, bm25(memory_fts) AS s
               FROM memory_fts JOIN memory_vectors m ON m.id = memory_fts.rowid
              WHERE memory_fts MATCH ? ${filter}
              ORDER BY s LIMIT ?`,
          )
          .all(match, ...(sources ?? []), k) as { source: MemorySource; source_id: number; s: number }[]
      ).map((r) => ({ source: r.source, sourceId: r.source_id, bm25: r.s }));
    } catch (e) {
      log.debug('memory', 'keyword search failed', { error: (e as Error).message });
      return [];
    }
  }

  counts(): { total: number; bySource: Record<MemorySource, number> } {
    const bySource: Record<MemorySource, number> = { note: 0, observation: 0, fact: 0, episode: 0 };
    if (!this.db) return { total: 0, bySource };
    for (const r of this.db
      .prepare('SELECT source, COUNT(*) AS n FROM memory_vectors WHERE length(vector) > 0 GROUP BY source')
      .all() as {
      source: MemorySource;
      n: number;
    }[]) {
      bySource[r.source] = r.n;
    }
    return { total: Object.values(bySource).reduce((a, b) => a + b, 0), bySource };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private knnVec0(query: Float32Array, k: number, sources?: MemorySource[]): VectorHit[] {
    const db = this.handle();
    const filter = sources?.length ? `AND source IN (${sources.map(() => '?').join(',')})` : '';
    const rows = db
      .prepare(
        `SELECT rowid AS id, distance FROM memory_vec
          WHERE embedding MATCH ? AND k = ? ${filter}
          ORDER BY distance`,
      )
      .all(
        Buffer.from(query.buffer, query.byteOffset, query.byteLength),
        Math.min(k, VEC0_MAX_K),
        ...(sources ?? []),
      ) as { id: number; distance: number }[];
    if (!rows.length) return [];
    const meta = new Map(
      (
        db
          .prepare(`SELECT id, source, source_id FROM memory_vectors WHERE id IN (${rows.map(() => '?').join(',')})`)
          .all(...rows.map((r) => r.id)) as { id: number; source: MemorySource; source_id: number }[]
      ).map((m) => [m.id, m]),
    );
    const out: VectorHit[] = [];
    for (const r of rows) {
      const m = meta.get(r.id);
      // A vec0 row with no plain row is an accelerator that drifted; the next
      // `open` rebuilds it. Skipping it here is the honest answer meanwhile.
      if (m) out.push({ source: m.source, sourceId: m.source_id, similarity: 1 - r.distance });
    }
    return out;
  }

  private loadExtension(db: Database.Database): boolean {
    if (loadedInto.has(db)) return true;
    try {
      // Inside a packaged app the module resolves into app.asar, which dlopen
      // cannot read. electron-builder unpacks it beside the archive.
      const p = getLoadablePath().replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      db.loadExtension(p);
      const v = (db.prepare('SELECT vec_version() AS v').get() as { v: string }).v;
      log.info('memory', 'sqlite-vec loaded', { version: v });
      this.extensionError = null;
      loadedInto.add(db);
      return true;
    } catch (e) {
      this.extensionError = (e as Error).message;
      log.warn('memory', 'sqlite-vec did not load; nearest-neighbour search will scan instead', {
        error: this.extensionError,
      });
      return false;
    }
  }

  private tableExists(db: Database.Database): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_vec'").get();
  }

  /** Create the vec0 table, or rebuild it when it has drifted from the rows. */
  private ensureAccelerator(db: Database.Database) {
    try {
      if (this.tableExists(db)) {
        const declared = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vec'").get() as {
          sql: string;
        }).sql;
        if (!declared.includes(`float[${this.dim}]`)) db.exec('DROP TABLE memory_vec');
      }
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
           embedding float[${this.dim}] distance_metric=cosine,
           source text
         )`,
      );
      const plain = (db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE length(vector) > 0').get() as {
        n: number;
      }).n;
      const fast = (db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get() as { n: number }).n;
      if (plain !== fast) {
        const t0 = Date.now();
        db.transaction(() => {
          db.exec('DELETE FROM memory_vec');
          const ins = db.prepare('INSERT INTO memory_vec (rowid, embedding, source) VALUES (?, ?, ?)');
          // Paged rather than iterated: better-sqlite3 refuses a write on a
          // connection that is still stepping through a read, so a cursor
          // over the rows cannot feed inserts into the index directly.
          const page = db.prepare(
            'SELECT id, source, vector FROM memory_vectors WHERE id > ? AND length(vector) > 0 ORDER BY id LIMIT 1000',
          );
          for (let after = 0; ; ) {
            const rows = page.all(after) as { id: number; source: string; vector: Buffer }[];
            if (!rows.length) break;
            for (const r of rows) ins.run(BigInt(r.id), r.vector, r.source);
            after = rows[rows.length - 1]!.id;
          }
        })();
        log.info('memory', 'vector index rebuilt from rows', { rows: plain, was: fast, ms: Date.now() - t0 });
      }
    } catch (e) {
      // The accelerator is optional by construction. Losing it costs speed.
      log.warn('memory', 'the vec0 index is unusable; falling back to a scan', { error: (e as Error).message });
      this.accelerated = false;
    }
  }

  private handle(): Database.Database {
    if (!this.db) throw new Error('vector store not open');
    return this.db;
  }
}

/** A BLOB from SQLite as a Float32Array. Copied, because a Buffer from
 *  better-sqlite3 can sit at an offset a Float32Array view will not accept. */
function toVec(b: Buffer): Float32Array {
  const out = new Float32Array(b.byteLength / 4);
  new Uint8Array(out.buffer).set(b);
  return out;
}

export const vectors = new VectorStore();
