import { log } from '../log.js';
import { notes, relations, tasks } from '../store/notes.js';
import { RollupSchema, type RollupOutput } from './schemas.js';
import { ROLLUP_SYSTEM } from './prompts.js';
import { ROLLUP_MODEL, type ContentBlock, type StructuredClient } from './model.js';
import type { ObservationRow, RelationRow, TaskRow } from '../../shared/types.js';

/// T3 — the rollup tier (PRD §5).
///
/// Hourly, at session end, and at midnight: observations become one recap note,
/// and the entities and tasks inside them are merged into the permanent
/// relation and task notes.
///
/// The merge is the part that matters. An extractor that writes a fresh note
/// every hour produces a memory that is technically complete and practically
/// useless — forty cards saying the same thing about the same person. So the
/// prompt is given what already exists and asked to reuse it, and then the
/// store merges mechanically on top of whatever it returns (`relations.upsert`,
/// `tasks.upsert`). Prompt-level reuse keeps the notes readable; the
/// mechanical merge is what makes them correct.

export type RollupReason = 'hourly' | 'session-end' | 'midnight' | 'manual';

export interface RollupResult {
  recapNoteId: number;
  relationsTouched: number;
  tasksTouched: number;
  costUsd: number;
  ms: number;
  injectionNotice: string | null;
  observationsUsed: number;
}

function renderObservations(obs: ObservationRow[]): string {
  return obs
    .map((o) => {
      const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const ents = o.entities.length
        ? o.entities
            .map((e) => `${e.kind}:${e.name}${e.identifier ? ` (${e.identifier})` : ''}`)
            .join(', ')
        : '(none)';
      return (
        `[obs ${o.id}] ${t(o.tsStart)}–${t(o.tsEnd)} · confidence ${o.confidence}\n` +
        `  ${o.summary}\n` +
        `  apps: ${o.apps.join(', ') || '(none)'}\n` +
        `  entities: ${ents}`
      );
    })
    .join('\n\n');
}

function renderKnownRelations(rs: RelationRow[]): string {
  if (!rs.length) return '(buddy knows nobody yet)';
  return rs
    .map(
      (r) =>
        `${r.kind.padEnd(9)}${r.displayName} [${r.identifier}]` +
        (r.aliases.length ? ` · also seen as: ${r.aliases.join(', ')}` : '') +
        ` · seen ${r.frequency}x`,
    )
    .join('\n');
}

function renderKnownTasks(ts: TaskRow[]): string {
  if (!ts.length) return '(no open tasks)';
  return ts
    .map(
      (t) =>
        `id=${t.id} [${t.status}/${t.scope}] ${t.title}\n` +
        `        ${t.body.replace(/\n/g, ' ').slice(0, 240)}\n` +
        `        last seen ${new Date(t.lastSeenAt).toLocaleString()}`,
    )
    .join('\n\n');
}

/**
 * One rollup.
 *
 * Everything the model returns is written through the store's upserts, which
 * do the identity work whatever the model said. A relation the model invented a
 * new spelling for still lands on the existing row; a task it re-titled still
 * updates rather than duplicates, because it was given the id and, failing
 * that, the title matches.
 */
export async function rollup(
  client: StructuredClient,
  obs: ObservationRow[],
  reason: RollupReason,
  period: { from: number; to: number },
): Promise<RollupResult | null> {
  if (!obs.length) return null;

  const knownRelations = relations.all(120);
  const knownTasks = tasks.open();

  const content: ContentBlock[] = [
    {
      type: 'text',
      text: [
        `Period: ${new Date(period.from).toLocaleString()} – ${new Date(period.to).toLocaleString()}`,
        `This rollup was triggered by: ${reason}`,
        '',
        '<known_relations>',
        renderKnownRelations(knownRelations),
        '</known_relations>',
        '',
        '<open_tasks>',
        renderKnownTasks(knownTasks),
        '</open_tasks>',
        '',
        '<observations>',
        renderObservations(obs),
        '</observations>',
        '',
        'Write the recap, the relations, and the task states.',
      ].join('\n'),
    },
  ];

  const res = await client.parse<RollupOutput>({
    model: ROLLUP_MODEL,
    system: ROLLUP_SYSTEM,
    content,
    schema: RollupSchema,
    maxTokens: 8_000,
    thinking: true,
    // Sonnet 5 takes effort; `medium` is the right place for summarisation that
    // runs hourly. The judgement calls here are merge decisions, and the
    // mechanical merge catches those anyway.
    effort: 'medium',
  });

  const out = res.value;
  const obsIds = obs.map((o) => o.id);
  const now = period.to;

  const recapNoteId = notes.create({
    type: 'recap',
    title: out.recap.title,
    body: out.recap.body,
    salience: out.recap.salience,
    sourceObs: obsIds,
  });

  let relationsTouched = 0;
  for (const r of out.relations) {
    if (!r.display_name?.trim()) continue;
    try {
      const row = relations.upsert({
        kind: r.kind,
        displayName: r.display_name,
        identifier: r.identifier,
        aliases: r.aliases,
        note: r.note,
        seenAt: now,
        sourceObs: obsIds,
      });
      // The recap is what links a person to the afternoon they appeared in.
      notes.link(recapNoteId, row.id, 'mentions');
      relationsTouched++;
    } catch (e) {
      log.warn('rollup', 'relation upsert failed', {
        name: r.display_name,
        error: (e as Error).message,
      });
    }
  }

  let tasksTouched = 0;
  for (const t of out.tasks) {
    if (!t.title?.trim()) continue;
    try {
      const row = tasks.upsert({
        id: t.id,
        title: t.title,
        body: t.body,
        status: t.status,
        scope: t.scope,
        artifacts: t.artifacts,
        seenAt: now,
        sourceObs: obsIds,
      });
      notes.link(recapNoteId, row.id, 'covers');
      tasksTouched++;
    } catch (e) {
      log.warn('rollup', 'task upsert failed', { title: t.title, error: (e as Error).message });
    }
  }

  if (out.injection_notice) {
    log.warn('rollup', 'on-screen text tried to give instructions; it was not followed', {
      quote: out.injection_notice.slice(0, 200),
    });
  }

  log.info('rollup', 'recap written', {
    reason,
    recapNoteId,
    observations: obs.length,
    relations: relationsTouched,
    tasks: tasksTouched,
    cost: res.costUsd.toFixed(4),
    ms: res.ms,
  });

  return {
    recapNoteId,
    relationsTouched,
    tasksTouched,
    costUsd: res.costUsd,
    ms: res.ms,
    injectionNotice: out.injection_notice,
    observationsUsed: obs.length,
  };
}
