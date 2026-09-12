import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../log.js';

/// JSON-RPC 2.0 client over the sidecar's stdio. Line-delimited, one pending
/// promise per id. A malformed line is logged and dropped rather than rejecting
/// every outstanding call — the framing is per-line, so one bad line cannot
/// desynchronise the rest.

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private notifyHandlers = new Map<string, (params: any) => void>();

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.onStderr(chunk));
  }

  onNotification(method: string, fn: (params: any) => void) {
    this.notifyHandlers.set(method, fn);
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.proc.stdin.writable) {
      return Promise.reject(new Error(`sidecar stdin closed; cannot call ${method}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar call timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Called when the process dies: everything outstanding must fail, or the
   *  capture loop waits forever on a promise nobody will ever settle. */
  rejectAll(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${reason} (pending ${p.method})`));
      this.pending.delete(id);
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn('sidecar', 'unparseable line from sidecar', { line: line.slice(0, 200) });
        continue;
      }
      if (msg.id == null) {
        this.notifyHandlers.get(msg.method)?.(msg.params ?? {});
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result);
    }
  }

  /** The sidecar logs structured JSON to stderr; fold it into our own log so
   *  there is one timeline rather than two. */
  private onStderr(chunk: string) {
    for (const line of chunk.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as { level?: string; msg?: string; [k: string]: unknown };
        const { level, msg, t: _t, ...fields } = o;
        const fn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.debug;
        fn('buddyd', msg ?? t, fields);
      } catch {
        log.debug('buddyd', t.slice(0, 400));
      }
    }
  }
}
