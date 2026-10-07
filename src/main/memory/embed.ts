import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../log.js';

/// The `EmbeddingProvider` seam (PRD §9), with the implementation buddy ships.
///
/// **What it is.** potion-base-8M, a Model2Vec *static* embedding model: a
/// 29,528 × 256 table with one vector per WordPiece token, distilled from
/// bge-base-en-v1.5. A sentence's embedding is the mean of its tokens' rows,
/// normalised. There is no neural network to run — no ONNX runtime, no
/// Metal, no worker thread — so it is a tokenizer pass and a few thousand
/// multiply-adds, measured in microseconds, and it runs on the main process
/// without anyone noticing.
///
/// **Why this one, and not the obvious alternatives.** Measured on a
/// buddy-shaped retrieval set (26 questions over 30 memories, in
/// `evals/memory-retrieval`): top-3 hit rate 96% for this model, 65% for BM25,
/// and 46% for Apple's on-device `NLEmbedding` — which costs nothing to ship
/// and was the first thing tried. A transformer through onnxruntime-node would
/// be somewhat better again and is a 300 MB dependency with a native runtime;
/// the memory corpus is short prose in the user's own vocabulary, which is
/// exactly where a static model holds up.
///
/// **What it cannot do**, said once here so nobody rediscovers it in a merge
/// bug: a mean of token vectors does not understand negation or opposites.
/// "Prefers dark mode" and "Prefers light mode" are near-identical vectors.
/// Anything that decides two memories are *the same* — the fact merge — must
/// therefore confirm with words as well as with meaning (see `learn.ts`).
///
/// The tokenizer below is a port of the Hugging Face `BertNormalizer`,
/// `BertPreTokenizer` and `WordPiece` the model was trained with. It has to be
/// exact: a token split differently is a different row of the table, and the
/// vector silently drifts from the one the model meant. The memory checks pin
/// it against ids produced by the reference implementation.

export interface Embedder {
  /** Changes when the vectors would change. Stored beside every vector, so a
   *  different model re-embeds the index rather than mixing two spaces. */
  readonly id: string;
  readonly dim: number;
  /** Null for text with no known tokens — an empty string, or only
   *  punctuation. A zero vector would rank as "similar to nothing" and then
   *  still take a slot in every result list. */
  embed(text: string): Float32Array | null;
}

export const MODEL_NAME = 'potion-base-8M';

interface TokenizerJson {
  normalizer?: { type?: string; lowercase?: boolean; strip_accents?: boolean | null; clean_text?: boolean; handle_chinese_chars?: boolean };
  model: { type: string; vocab: Record<string, number>; unk_token: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number };
}

/** Model2Vec truncates at 512 tokens, after cutting the string at 512 × the
 *  vocabulary's median token length. Both are reproduced so a long note embeds
 *  to the same vector the reference library would give it. */
const MAX_TOKENS = 512;

export class StaticEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  private table: Float32Array;
  private vocab: Map<string, number>;
  private unkId: number;
  private prefix: string;
  private maxWordChars: number;
  private lowercase: boolean;
  private stripAccents: boolean;
  private normalize: boolean;
  private charCap: number;

  constructor(dir: string) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      normalize?: boolean;
      hidden_dim?: number;
    };
    const tok = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')) as TokenizerJson;
    if (tok.model.type !== 'WordPiece') throw new Error(`unsupported tokenizer model: ${tok.model.type}`);

    this.vocab = new Map(Object.entries(tok.model.vocab));
    const unk = this.vocab.get(tok.model.unk_token);
    if (unk == null) throw new Error('the tokenizer has no unknown token');
    this.unkId = unk;
    this.prefix = tok.model.continuing_subword_prefix ?? '##';
    this.maxWordChars = tok.model.max_input_chars_per_word ?? 100;
    this.lowercase = tok.normalizer?.lowercase ?? true;
    // HF: `strip_accents: null` means "follow lowercase".
    this.stripAccents = tok.normalizer?.strip_accents ?? this.lowercase;
    this.normalize = config.normalize ?? true;

    const { data, rows, cols } = readSafetensors(path.join(dir, 'model.safetensors'));
    if (rows !== this.vocab.size) {
      throw new Error(`the embedding table has ${rows} rows for a vocabulary of ${this.vocab.size}`);
    }
    this.table = data;
    this.dim = cols;

    const lengths = [...this.vocab.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => [...t].length);
    lengths.sort((a, b) => a - b);
    const mid = lengths.length >> 1;
    const median = lengths.length % 2 ? lengths[mid]! : (lengths[mid - 1]! + lengths[mid]!) / 2;
    this.charCap = MAX_TOKENS * Math.floor(median);

    let revision = 'local';
    try {
      revision = fs.readFileSync(path.join(dir, 'REVISION'), 'utf8').trim().slice(0, 7) || revision;
    } catch {
      /* a model dropped in by hand has no pinned revision; the name still identifies it */
    }
    this.id = `${MODEL_NAME}@${revision}`;
  }

  /** Token ids exactly as Model2Vec would use them: no special tokens, the
   *  unknown token dropped, truncated. Exposed for the parity check. */
  tokenize(text: string): number[] {
    const ids: number[] = [];
    const clipped = [...text].slice(0, this.charCap).join('');
    for (const word of this.preTokenize(this.normalizeText(clipped))) {
      for (const id of this.wordPiece(word)) {
        if (id !== this.unkId) ids.push(id);
      }
      if (ids.length >= MAX_TOKENS) break;
    }
    return ids.slice(0, MAX_TOKENS);
  }

  embed(text: string): Float32Array | null {
    const ids = this.tokenize(text);
    if (!ids.length) return null;
    const out = new Float32Array(this.dim);
    for (const id of ids) {
      const row = id * this.dim;
      for (let j = 0; j < this.dim; j++) out[j]! += this.table[row + j]!;
    }
    let norm = 0;
    for (let j = 0; j < this.dim; j++) {
      out[j]! /= ids.length;
      norm += out[j]! * out[j]!;
    }
    if (this.normalize) {
      const inv = 1 / (Math.sqrt(norm) + 1e-32);
      for (let j = 0; j < this.dim; j++) out[j]! *= inv;
    }
    return out;
  }

  // ── BertNormalizer ────────────────────────────────────────────────────────

  private normalizeText(s: string): string {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      // clean_text: drop NUL, U+FFFD and control characters; any whitespace
      // becomes a plain space.
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      if (isWhitespace(ch)) {
        out += ' ';
        continue;
      }
      // handle_chinese_chars: each CJK ideograph is its own word.
      out += isCjk(cp) ? ` ${ch} ` : ch;
    }
    if (this.stripAccents) out = out.normalize('NFD').replace(/\p{Mn}/gu, '');
    if (this.lowercase) out = out.toLowerCase();
    return out;
  }

  // ── BertPreTokenizer ──────────────────────────────────────────────────────

  private preTokenize(s: string): string[] {
    const words: string[] = [];
    let cur = '';
    for (const ch of s) {
      if (isWhitespace(ch)) {
        if (cur) words.push(cur);
        cur = '';
      } else if (isPunctuation(ch)) {
        if (cur) words.push(cur);
        words.push(ch);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur) words.push(cur);
    return words;
  }

  // ── WordPiece ─────────────────────────────────────────────────────────────

  /** Greedy longest-match-first. A word with any piece that matches nothing is
   *  one unknown token — not its matched prefix — which is what the reference
   *  does, and which Model2Vec then drops. */
  private wordPiece(word: string): number[] {
    const chars = [...word];
    if (chars.length > this.maxWordChars) return [this.unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? this.prefix : '') + chars.slice(start, end).join('');
        found = this.vocab.get(sub);
        if (found != null) break;
        end--;
      }
      if (found == null) return [this.unkId];
      ids.push(found);
      start = end;
    }
    return ids;
  }
}

/** Unicode general category C*, minus the three whitespace controls BERT keeps. */
function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  return /\p{C}/u.test(ch);
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\p{White_Space}/u.test(ch);
}

/** BERT's punctuation is ASCII punctuation *and* Unicode P*: `$`, `+`, `<`,
 *  `=`, `>`, `^`, `` ` ``, `|` and `~` are symbols to Unicode and punctuation
 *  to BERT, and they split words. */
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b920 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/** The safetensors container: an 8-byte little-endian header length, a JSON
 *  header, then raw tensors. One F32 matrix is all this model has. */
function readSafetensors(file: string): { data: Float32Array; rows: number; cols: number } {
  const buf = fs.readFileSync(file);
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8')) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const t = header.embeddings ?? Object.entries(header).find(([k]) => k !== '__metadata__')?.[1];
  if (!t || t.dtype !== 'F32' || t.shape.length !== 2) throw new Error('expected one F32 embedding matrix');
  const [rows, cols] = t.shape as [number, number];
  const begin = 8 + headerLen + t.data_offsets[0];
  const bytes = t.data_offsets[1] - t.data_offsets[0];
  if (bytes !== rows * cols * 4) throw new Error('the embedding matrix is truncated');
  // Copied out rather than viewed in place: a view needs a 4-aligned offset,
  // and a 30 MB copy once per launch is not worth a special case.
  const data = new Float32Array(rows * cols);
  Buffer.from(data.buffer).set(buf.subarray(begin, begin + bytes));
  return { data, rows, cols };
}

/** Where the model is, in the three places buddy runs from: a packaged app
 *  (copied in by electron-builder), `npm run dev`, and `electron out/main/…`
 *  from the project root. */
export function modelDir(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'models', MODEL_NAME),
    path.join(app.getAppPath(), 'resources', 'models', MODEL_NAME),
    path.join(process.cwd(), 'resources', 'models', MODEL_NAME),
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'model.safetensors'))) ?? null;
}

let loaded: Embedder | null | undefined;

/**
 * The shared embedder, loaded on first use (~60 ms, ~30 MB resident).
 *
 * Null when the model is missing or will not load, and that is a degradation
 * rather than a failure: retrieval falls back to keywords alone, learning
 * still writes facts, and the merge falls back to exact wording. It is logged
 * once, with the command that fixes it.
 */
export function embedder(): Embedder | null {
  if (loaded !== undefined) return loaded;
  const dir = modelDir();
  if (!dir) {
    log.warn('memory', 'the embedding model is missing; search falls back to keywords', {
      fix: 'npm run fetch:model',
    });
    loaded = null;
    return loaded;
  }
  try {
    const t0 = Date.now();
    loaded = new StaticEmbedder(dir);
    log.info('memory', 'embedding model loaded', { model: loaded.id, dim: loaded.dim, ms: Date.now() - t0 });
  } catch (e) {
    log.error('memory', 'the embedding model would not load; search falls back to keywords', {
      dir,
      error: (e as Error).message,
    });
    loaded = null;
  }
  return loaded;
}

/** For the checks, which swap the model out to prove the index notices. */
export function setEmbedderForTesting(e: Embedder | null | undefined) {
  loaded = e;
}

/** Cosine similarity of two unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
