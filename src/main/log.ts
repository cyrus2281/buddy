import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../shared/types.js';

/// Structured logging. One JSON object per line to a rotating file, plus a
/// ring buffer the Settings pane reads so a sidecar crash is visible in the UI
/// rather than only in a terminal nobody has open.

const RING_SIZE = 500;
const MAX_BYTES = 5 * 1024 * 1024;

/** Anything shaped like an API key never reaches disk (PRD §7.5). */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
];

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce((s, re) => s.replace(re, '[redacted]'), value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

class Logger {
  private ring: LogEntry[] = [];
  private stream: fs.WriteStream | null = null;
  private file = '';
  private listeners = new Set<(e: LogEntry) => void>();

  init(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'buddy.log');
    this.rotateIfNeeded();
    this.stream = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
  }

  private rotateIfNeeded() {
    try {
      if (fs.statSync(this.file).size > MAX_BYTES) {
        fs.renameSync(this.file, this.file + '.1');
      }
    } catch {
      /* no log yet */
    }
  }

  private emit(level: LogEntry['level'], scope: string, msg: string, fields?: Record<string, unknown>) {
    const entry: LogEntry = {
      t: Date.now(),
      level,
      scope,
      msg: redact(msg) as string,
      ...(fields ? { fields: redact(fields) as Record<string, unknown> } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.stream?.write(JSON.stringify(entry) + '\n');
    if (!app.isPackaged) {
      const f = entry.fields ? ' ' + JSON.stringify(entry.fields) : '';
      // eslint-disable-next-line no-console
      console.log(`[${level}] ${scope}: ${entry.msg}${f}`);
    }
    for (const l of this.listeners) l(entry);
  }

  debug = (s: string, m: string, f?: Record<string, unknown>) => this.emit('debug', s, m, f);
  info = (s: string, m: string, f?: Record<string, unknown>) => this.emit('info', s, m, f);
  warn = (s: string, m: string, f?: Record<string, unknown>) => this.emit('warn', s, m, f);
  error = (s: string, m: string, f?: Record<string, unknown>) => this.emit('error', s, m, f);

  recent(n = 200): LogEntry[] {
    return this.ring.slice(-n);
  }

  onEntry(fn: (e: LogEntry) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const log = new Logger();
