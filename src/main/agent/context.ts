import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { log } from '../log.js';
import { runPaths } from '../store/runs.js';
import type { Allowlist, RunBudgets, RunProfile } from '../../shared/types.js';

/// The saved conversation of a run that went to standby (PRD §6.6).
///
/// "Resumes the original run **with its full prior context**" is the clause that
/// separates buddy from every computer-use tool that forgets you the moment it
/// stops — and it is also the clause that cannot be satisfied by anything held
/// in memory, because §6.6 says in the same breath that a wakeup survives an
/// app restart. So the transcript goes to disk, beside the run's screenshots,
/// under `runs/<id>/context.json`.
///
/// **Images are replaced by a placeholder on the way out, and this is the one
/// decision here worth arguing about.** A run of forty turns carries three live
/// screenshots at roughly 1.5 MB of base64 each, plus whatever has not been
/// pruned yet; writing those to disk and reading them back would make the file
/// tens of megabytes for a conversation whose text is a few dozen kilobytes,
/// and every one of them would be a picture of a screen that has since changed.
/// The resume takes a fresh screenshot as its first act, so what the old images
/// would contribute is a stale view the model has to be told to disregard.
///
/// What is *not* dropped is the `tool_result` block itself. Dropping one would
/// orphan its `tool_use` and make the whole conversation invalid on the next
/// request — the same reason `AgentRunner.pruneScreenshots` swaps content
/// rather than removing blocks. The placeholder text is deliberately the same
/// string, so a resumed conversation reads to the model exactly like a pruned
/// one, which it has already been trained on by forty turns of this run.

/**
 * The text a synthetic `tool_result` carries when the run stopped before the
 * block it answers ever ran. See `sealTranscript`.
 */
export const UNEXECUTED_TEXT =
  'Not executed: buddy stopped before this ran, and went to standby instead.';

export const STANDBY_IMAGE_PLACEHOLDER =
  '[screenshot from before buddy went to standby — the screen has changed since; take a new one]';

export interface SavedContext {
  runId: number;
  goal: string;
  profile: RunProfile;
  allowlist: Allowlist;
  budgets: RunBudgets;
  messages: Anthropic.Messages.MessageParam[];
  /** Steps and dollars already spent on this run, so the run row stays
   *  cumulative across resumes even though the budgets restart. */
  priorSteps: number;
  priorCostUsd: number;
  /** How many times this run has been resumed. Shown in the Run Log, and the
   *  model is told, because "you have tried this twice already" changes what a
   *  sensible third attempt looks like. */
  resumes: number;
  savedAt: number;
}

const file = (runId: number) => path.join(runPaths.dir(runId), 'context.json');

/** Strip every image block to a placeholder, leaving the block structure —
 *  and therefore the `tool_use`/`tool_result` pairing — exactly as it was. */
export function stripImages(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  let stripped = 0;
  const walk = (blocks: unknown[]): unknown[] =>
    blocks.map((b) => {
      const block = b as Record<string, unknown>;
      if (block.type === 'image') {
        stripped++;
        return { type: 'text', text: STANDBY_IMAGE_PLACEHOLDER };
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return { ...block, content: walk(block.content as unknown[]) };
      }
      return block;
    });

  const out = messages.map((m) =>
    Array.isArray(m.content) ? { ...m, content: walk(m.content as unknown[]) } : m,
  ) as Anthropic.Messages.MessageParam[];
  if (stripped) log.debug('standby', 'images replaced for the saved transcript', { stripped });
  return out;
}

/**
 * Answer every `tool_use` that never got a `tool_result`.
 *
 * **Found by `live-run.ts`, against the real API, and it is a 400 rather than a
 * degradation:**
 *
 * > `messages.14: tool_use ids were found without tool_result blocks
 * > immediately after: toolu_013GBF… Each tool_use block must have a
 * > corresponding tool_result block in the next message.`
 *
 * A run that halts *inside* a batch — a denied gate, a kill switch, a blown
 * budget — returns from the loop without pushing that batch's results, because
 * the run is over and buddy deliberately never gives the model another turn
 * after a block (§7.1). That leaves the last assistant message carrying
 * `tool_use` blocks nothing ever answered, which is harmless for exactly as long
 * as nothing sends the conversation again.
 *
 * M4 is the first thing that sends it again. The narrow path that reaches here
 * is a `finish(waiting)` in the same batch as a block that then gates and is
 * denied: the run's status is `waiting`, so the transcript is saved, and it is
 * saved invalid. The resume would 400 forty minutes later, in a wakeup nobody
 * is watching, and read as the API being flaky.
 *
 * Sealing is cheap and it is also honest: the synthetic result says the block
 * did not run, which is true and is something the model should know before it
 * carries on from here.
 */
export function sealTranscript(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as unknown as Record<string, unknown>[]) {
      if (b.type === 'tool_result') answered.add(String(b.tool_use_id));
    }
  }

  const out: Anthropic.Messages.MessageParam[] = messages.map((m) =>
    Array.isArray(m.content) ? { ...m, content: [...m.content] } : m,
  ) as Anthropic.Messages.MessageParam[];

  let sealed = 0;
  // Walked backwards so an insertion never shifts an index still to be visited.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const orphans = (m.content as unknown as Record<string, unknown>[]).filter(
      (b) => b.type === 'tool_use' && !answered.has(String(b.id)),
    );
    if (!orphans.length) continue;

    const results = orphans.map((b) => ({
      type: 'tool_result' as const,
      tool_use_id: String(b.id),
      is_error: true,
      content: [{ type: 'text' as const, text: UNEXECUTED_TEXT }],
      ...(b.toolset_name ? { toolset_name: String(b.toolset_name) } : {}),
    }));

    // Merged into the existing next message when there is one, rather than
    // inserted before it. The API's rule is that a turn's results are in *the
    // next message* — so splitting a partly-answered batch across two user
    // messages trades one 400 for a different one, which is what the first
    // version of this function did and what `check:m4` caught.
    const next = out[i + 1];
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      // Prepended, so the results stay in the order their `tool_use` blocks
      // were issued when the unanswered ones come first in the batch.
      (next.content as unknown as unknown[]).unshift(...(results as unknown[]));
    } else {
      out.splice(i + 1, 0, { role: 'user', content: results as never });
    }
    for (const b of orphans) answered.add(String(b.id));
    sealed += orphans.length;
  }

  if (sealed) {
    log.info('standby', 'sealed unanswered tool_use blocks in the saved transcript', { sealed });
  }
  return out;
}

export const runContext = {
  save(ctx: Omit<SavedContext, 'savedAt'>): void {
    const payload: SavedContext = {
      ...ctx,
      // Sealed first, then stripped: sealing reads `tool_use` ids, which
      // stripping never touches, but doing it in this order means the synthetic
      // results are also checked for images they cannot contain. Cheap, and it
      // keeps "what is written" a single pipeline rather than two orderings
      // that happen to agree today.
      messages: stripImages(sealTranscript(ctx.messages)),
      savedAt: Date.now(),
    };
    try {
      fs.mkdirSync(runPaths.dir(ctx.runId), { recursive: true, mode: 0o700 });
      // Written whole, then renamed: a half-written context.json read after a
      // crash would resume a run into a conversation the API rejects.
      const tmp = `${file(ctx.runId)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, file(ctx.runId));
      log.info('standby', 'run context saved', {
        runId: ctx.runId,
        messages: payload.messages.length,
        bytes: fs.statSync(file(ctx.runId)).size,
      });
    } catch (e) {
      // A wakeup with no context can still fire; it just cannot resume. Saying
      // so here is better than discovering it forty minutes later.
      log.error('standby', 'could not save the run context; this run cannot resume', {
        runId: ctx.runId,
        error: (e as Error).message,
      });
    }
  },

  load(runId: number): SavedContext | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(runId), 'utf8')) as SavedContext;
      if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
      return parsed;
    } catch {
      return null;
    }
  },

  exists(runId: number): boolean {
    return fs.existsSync(file(runId));
  },

  clear(runId: number): void {
    try {
      fs.unlinkSync(file(runId));
    } catch {
      /* never existed, or the run was deleted with its directory */
    }
  },
};
