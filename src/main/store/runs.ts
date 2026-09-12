import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { paths } from '../paths.js';
import { log } from '../log.js';
import type {
  GuardVerdict,
  RunOutcome,
  RunProfile,
  RunRow,
  RunStatus,
  RunStep,
} from '../../shared/types.js';

/// `runs`, `run_steps`, and `wakeups` — created at M1, first written here.
///
/// A run's step screenshots do **not** live in the frame vault. The vault
/// expires daily (§5.1) and the Run Log is the trust surface (§8.5): a log whose
/// pictures vanish overnight cannot answer "what did buddy click". Runs are kept
/// indefinitely per §5.1, so their frames are kept with them, under
/// `runs/<id>/`, where the retention sweep never looks. Deleting a run deletes
/// its frames with it.

export const runPaths = {
  dir: (runId: number) => path.join(paths.root(), 'runs', String(runId)),
  frame: (runId: number, idx: number) => path.join(runPaths.dir(runId), `${String(idx).padStart(3, '0')}.png`),
};

export interface StepInsert {
  runId: number;
  idx: number;
  tool: string;
  input: unknown;
  result: unknown;
  framePath?: string | null;
  isError: boolean;
  verdict?: GuardVerdict | null;
  scale?: number | null;
}

/** The JSON we hang off `run_steps.result_json` so a step round-trips without
 *  needing extra columns. The schema was fixed at M1 and is not worth a
 *  migration for two nullable fields. */
interface StepEnvelope {
  result: unknown;
  verdict: GuardVerdict | null;
  scale: number | null;
}

export const runs = {
  create(goal: string, profile: RunProfile): number {
    const info = getDb()
      .prepare(
        `INSERT INTO runs (started_at, profile, goal, status, steps, cost_usd)
         VALUES (?, ?, ?, 'running', 0, 0)`,
      )
      .run(Date.now(), profile, goal);
    const id = Number(info.lastInsertRowid);
    fs.mkdirSync(runPaths.dir(id), { recursive: true, mode: 0o700 });
    return id;
  },

  addStep(s: StepInsert): void {
    const envelope: StepEnvelope = {
      result: s.result,
      verdict: s.verdict ?? null,
      scale: s.scale ?? null,
    };
    getDb()
      .prepare(
        `INSERT INTO run_steps (run_id, idx, tool, input_json, result_json, frame_path, is_error, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, idx) DO UPDATE SET
           tool = excluded.tool, input_json = excluded.input_json,
           result_json = excluded.result_json, frame_path = excluded.frame_path,
           is_error = excluded.is_error, ts = excluded.ts`,
      )
      .run(
        s.runId,
        s.idx,
        s.tool,
        JSON.stringify(s.input ?? {}),
        JSON.stringify(envelope),
        s.framePath ?? null,
        s.isError ? 1 : 0,
        Date.now(),
      );
  },

  finish(runId: number, status: RunStatus, steps: number, costUsd: number, outcome: RunOutcome | null): void {
    getDb()
      .prepare(
        `UPDATE runs SET ended_at = ?, status = ?, steps = ?, cost_usd = ?, outcome_json = ? WHERE id = ?`,
      )
      .run(Date.now(), status, steps, costUsd, outcome ? JSON.stringify(outcome) : null, runId);
  },

  /** Live progress, so a crashed app leaves a run log that is accurate up to
   *  the last completed step rather than showing zero. */
  progress(runId: number, steps: number, costUsd: number): void {
    getDb().prepare('UPDATE runs SET steps = ?, cost_usd = ? WHERE id = ?').run(steps, costUsd, runId);
  },

  get(runId: number): RunRow | undefined {
    return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  },

  list(limit = 50): RunRow[] {
    return getDb()
      .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as RunRow[];
  },

  steps(runId: number): RunStep[] {
    const rows = getDb()
      .prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx')
      .all(runId) as {
      run_id: number;
      idx: number;
      tool: string;
      input_json: string;
      result_json: string;
      frame_path: string | null;
      is_error: number;
      ts: number;
    }[];
    return rows.map((r) => {
      let envelope: StepEnvelope = { result: null, verdict: null, scale: null };
      try {
        const parsed = JSON.parse(r.result_json);
        // Tolerate a bare result from an older row rather than losing the step.
        envelope =
          parsed && typeof parsed === 'object' && 'result' in parsed
            ? (parsed as StepEnvelope)
            : { result: parsed, verdict: null, scale: null };
      } catch {
        /* keep the empty envelope; the row is still worth showing */
      }
      return {
        runId: r.run_id,
        idx: r.idx,
        tool: r.tool,
        input: safeParse(r.input_json),
        result: envelope.result,
        framePath: r.frame_path,
        isError: r.is_error === 1,
        ts: r.ts,
        verdict: envelope.verdict,
        scale: envelope.scale,
      };
    });
  },

  /** PRD §6.6. M4 consumes this; M2 writes it so standby is parseable rather
   *  than regex-scraped out of prose when it lands. */
  scheduleWakeup(runId: number, wake: { after_s: number; condition: string; max_attempts: number }): number {
    const fireAt = Date.now() + Math.max(1, wake.after_s) * 1000;
    const info = getDb()
      .prepare(
        `INSERT INTO wakeups (run_id, fire_at, condition, interval_s, attempts, max_attempts)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(runId, fireAt, wake.condition, Math.max(1, wake.after_s), Math.max(1, wake.max_attempts));
    log.info('runs', 'wakeup scheduled', {
      runId,
      fireAt: new Date(fireAt).toISOString(),
      condition: wake.condition,
    });
    return Number(info.lastInsertRowid);
  },

  wakeups(runId?: number) {
    return runId == null
      ? (getDb().prepare('SELECT * FROM wakeups ORDER BY fire_at').all() as Record<string, unknown>[])
      : (getDb().prepare('SELECT * FROM wakeups WHERE run_id = ? ORDER BY fire_at').all(runId) as Record<
          string,
          unknown
        >[]);
  },

  /** Frames go with the run; the `run_steps` rows cascade from `runs`. */
  delete(runId: number): void {
    getDb().prepare('DELETE FROM runs WHERE id = ?').run(runId);
    fs.rmSync(runPaths.dir(runId), { recursive: true, force: true });
  },

  /** Any run still marked `running` at launch was interrupted by a crash or a
   *  quit. Leaving it running would show a live run that nothing is driving. */
  reconcileOnLaunch(): number {
    const info = getDb()
      .prepare(
        `UPDATE runs SET status = 'needs_human', ended_at = COALESCE(ended_at, ?)
         WHERE status IN ('running', 'gated', 'confirming')`,
      )
      .run(Date.now());
    if (info.changes > 0) log.warn('runs', 'interrupted runs parked at launch', { count: info.changes });
    return info.changes;
  },
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
