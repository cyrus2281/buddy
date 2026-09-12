import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Button, Card, spring, useMotionSafe } from '../components/primitives.js';
import type {
  AnyNote,
  NoteDetail,
  NoteFrameRef,
  NoteSearchHit,
  NoteType,
  RelationRow,
  TaskRow,
  TaskScope,
  TaskStatus,
} from '../../shared/types.js';

/// Notes (PRD §8.3). Three tabs, FTS5 search, and a detail view showing the
/// linked notes and the source frames a note came from, while they still exist.
///
/// The requirement that shapes this screen is the last clause of §8.3: *every
/// note is editable and deletable; buddy's memory must feel correctable.* An
/// assistant that silently remembers something wrong about your colleague, and
/// gives you no way to fix it, is worse than one that remembers nothing — so
/// editing is inline and immediate rather than behind a modal, and deleting is
/// one confirm away on every note.

const TABS: { id: NoteType; label: string; empty: string }[] = [
  {
    id: 'recap',
    label: 'Recap',
    empty: 'No recaps yet. buddy writes one every hour it watches you work, and one when a session ends.',
  },
  {
    id: 'relation',
    label: 'Relations',
    empty: 'Nobody yet. People, apps, and products appear here as buddy sees you work with them.',
  },
  {
    id: 'task',
    label: 'Tasks',
    empty: 'No tasks yet. These are what buddy offers to pick up when you hit the hotkey.',
  },
];

export function Notes({ version }: { version: number }) {
  const [tab, setTab] = useState<NoteType>('recap');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AnyNote[]>([]);
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const safe = useMotionSafe();
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setItems(await api.getNotes(tab, 200));
  }, [tab]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // Live search, debounced just enough that a fast typist does not run a query
  // per keystroke. FTS5 over a few thousand notes is sub-millisecond, so this
  // is about not thrashing the IPC channel rather than about query cost.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      void api.searchNotes(query, tab).then(setHits);
    }, 120);
    return () => clearTimeout(t);
  }, [query, tab, version]);

  const list = hits ? hits.map((h) => h.note) : items;
  const snippetFor = useMemo(() => {
    const m = new Map<number, string>();
    for (const h of hits ?? []) m.set(h.note.id, h.snippet);
    return m;
  }, [hits]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setSelected(null);
              }}
              className={`relative rounded-lg px-3 py-1.5 text-[12px] transition-colors ${
                tab === t.id ? 'text-fog-100' : 'text-fog-500 hover:text-fog-300'
              }`}
            >
              {tab === t.id && (
                <motion.span
                  layoutId={safe ? 'notes-tab' : undefined}
                  className="absolute inset-0 rounded-lg bg-ink-800"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                />
              )}
              <span className="relative">{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="Search everything buddy remembers…"
            className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-[12px]
                       text-fog-100 outline-none placeholder:text-fog-500/60 focus:border-ember-500/70"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-fog-500 hover:text-fog-100"
            >
              esc
            </button>
          )}
        </div>
      </div>

      {hits && (
        <p className="text-[11px] text-fog-500">
          {hits.length === 0
            ? `Nothing matching “${query}”.`
            : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for “${query}”.`}
        </p>
      )}

      {list.length === 0 && !hits ? (
        <Card className="p-8 text-center">
          <p className="text-[12px] leading-relaxed text-fog-500">{TABS.find((t) => t.id === tab)!.empty}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {list.map((n) => (
              <motion.div
                key={n.id}
                layout={safe}
                initial={safe ? { opacity: 0, y: 4 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={safe ? { opacity: 0, height: 0 } : { opacity: 0 }}
                transition={safe ? spring : { duration: 0 }}
              >
                {selected === n.id ? (
                  <Detail id={n.id} onClose={() => setSelected(null)} onChanged={() => void refresh()} />
                ) : (
                  <Row note={n} snippet={snippetFor.get(n.id)} onOpen={() => setSelected(n.id)} />
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function Row({ note, snippet, onOpen }: { note: AnyNote; snippet?: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full rounded-xl border border-ink-700/70 bg-ink-850/60 px-4 py-3 text-left
                 transition-colors hover:border-ink-600 hover:bg-ink-800/60"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px] text-fog-100">{note.title}</span>
        <Badges note={note} />
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fog-500">
        {snippet ? <Snippet text={snippet} /> : note.body || '—'}
      </p>
    </button>
  );
}

/** FTS5 marks matches with «» so the renderer does not have to re-find them —
 *  and so a match inside a word is still visible. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/g).map((part, i) =>
        part.startsWith('«') && part.endsWith('»') ? (
          <mark key={i} className="rounded bg-ember-500/25 px-0.5 text-ember-300">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  open: 'border-moss-400/40 bg-moss-400/10 text-moss-400',
  blocked: 'border-rust-400/40 bg-rust-400/10 text-rust-400',
  waiting: 'border-ember-500/40 bg-ember-500/10 text-ember-300',
  done: 'border-ink-600 bg-ink-800 text-fog-500',
};

function Badges({ note }: { note: AnyNote }) {
  if (note.type === 'task') {
    const t = note as TaskRow;
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[t.status]}`}>
          {t.status}
        </span>
        <span className="font-mono text-[10px] text-fog-500">{t.scope}</span>
      </span>
    );
  }
  if (note.type === 'relation') {
    const r = note as RelationRow;
    return (
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-fog-500">
        <span className="rounded-md bg-ink-800 px-1.5 py-0.5">{r.kind}</span>
        <span>seen {r.frequency}×</span>
      </span>
    );
  }
  return (
    <span className="shrink-0 font-mono text-[10px] text-fog-500">
      {new Date(note.updatedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </span>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function Detail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const load = useCallback(async () => {
    const d = await api.getNoteDetail(id);
    setDetail(d);
    if (d) {
      setTitle(d.note.title);
      setBody(d.note.body);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail) return <Card className="p-4 text-[12px] text-fog-500">Loading…</Card>;
  const { note } = detail;

  const save = async () => {
    await api.updateNote(id, { title, body });
    setEditing(false);
    await load();
    onChanged();
  };

  const remove = async () => {
    if (!confirm(`Delete “${note.title}”? buddy will stop remembering this.`)) return;
    await api.deleteNote(id);
    onClose();
    onChanged();
  };

  return (
    <Card className="border-ember-500/30 p-4">
      <div className="flex items-start justify-between gap-3">
        {editing ? (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5
                       text-[13px] text-fog-100 outline-none focus:border-ember-500/70"
          />
        ) : (
          <h3 className="min-w-0 flex-1 text-[14px] leading-snug text-fog-100">{note.title}</h3>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <Badges note={note} />
          <button onClick={onClose} className="text-[11px] text-fog-500 hover:text-fog-100">
            close
          </button>
        </div>
      </div>

      {editing ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          className="mt-3 w-full resize-none rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2
                     text-[12px] leading-relaxed text-fog-100 outline-none focus:border-ember-500/70"
        />
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fog-300">{note.body || '—'}</p>
      )}

      {note.type === 'task' && !editing && (
        <TaskControls task={note as TaskRow} onChanged={() => void load().then(onChanged)} />
      )}
      {note.type === 'relation' && !editing && <RelationFacts relation={note as RelationRow} />}

      {detail.linked.length > 0 && (
        <section className="mt-4 border-t border-ink-700/60 pt-3">
          <p className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Linked</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {detail.linked.map(({ note: l, kind }) => (
              <span
                key={l.id}
                className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 text-[11px] text-fog-300"
                title={kind}
              >
                {l.title}
              </span>
            ))}
          </div>
        </section>
      )}

      <SourceFrames frames={detail.frames} observations={detail.observations.length} />

      <div className="mt-4 flex items-center justify-between border-t border-ink-700/60 pt-3">
        <span className="font-mono text-[10px] text-fog-500">
          written {new Date(note.createdAt).toLocaleString()}
          {note.updatedAt !== note.createdAt && ` · edited ${new Date(note.updatedAt).toLocaleString()}`}
        </span>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button
                onClick={() => {
                  setEditing(false);
                  setTitle(note.title);
                  setBody(note.body);
                }}
              >
                Cancel
              </Button>
              <Button variant="accent" onClick={() => void save()}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function TaskControls({ task, onChanged }: { task: TaskRow; onChanged: () => void }) {
  const statuses: TaskStatus[] = ['open', 'blocked', 'waiting', 'done'];
  const scopes: TaskScope[] = ['session', 'day', 'week'];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Status</span>
        {statuses.map((st) => (
          <button
            key={st}
            onClick={() => void api.setTaskStatus(task.id, st).then(onChanged)}
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              task.status === st ? STATUS_STYLE[st] : 'border-ink-700 text-fog-500 hover:text-fog-300'
            }`}
          >
            {st}
          </button>
        ))}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Scope</span>
        {scopes.map((sc) => (
          <button
            key={sc}
            onClick={() => void api.setTaskScope(task.id, sc).then(onChanged)}
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              task.scope === sc
                ? 'border-ember-500/50 bg-ember-500/10 text-ember-300'
                : 'border-ink-700 text-fog-500 hover:text-fog-300'
            }`}
          >
            {sc}
          </button>
        ))}
      </span>
      {task.artifacts.length > 0 && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.09em] text-fog-500">Touches</span>
          <span className="truncate font-mono text-[10px] text-fog-300">{task.artifacts.join(' · ')}</span>
        </span>
      )}
    </div>
  );
}

/** What makes a relation one row rather than five (PRD §4.1). Showing the
 *  aliases is also the fastest way for a user to spot a bad merge — two people
 *  fused into one is visible here and nowhere else. */
function RelationFacts({ relation }: { relation: RelationRow }) {
  return (
    <div className="mt-3 flex flex-col gap-1 font-mono text-[10px] text-fog-500">
      <span>
        id <span className="text-fog-300">{relation.identifier}</span> · last seen{' '}
        {new Date(relation.lastSeenAt).toLocaleString()}
      </span>
      {relation.aliases.length > 0 && (
        <span className="flex flex-wrap items-baseline gap-1">
          also seen as
          {relation.aliases.map((a) => (
            <span key={a} className="rounded bg-ink-800 px-1 py-0.5 text-fog-300">
              {a}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The frames a note came from (§8.3), *while they still exist*.
 *
 * Expired frames are shown as labelled placeholders rather than dropped. That
 * is the visible half of §5.1's bargain — screenshots expire daily, notes do
 * not — and a note that quietly showed fewer sources than it had would misstate
 * what it was built from.
 */
function SourceFrames({ frames, observations }: { frames: NoteFrameRef[]; observations: number }) {
  const [urls, setUrls] = useState<Record<number, string | null>>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: Record<number, string | null> = {};
      for (const f of frames.filter((x) => !x.expired && x.path)) {
        out[f.id] = await api.readVaultFrame(f.path!);
      }
      if (alive) setUrls(out);
    })();
    return () => {
      alive = false;
    };
  }, [frames]);

  if (!frames.length) {
    return observations > 0 ? (
      <p className="mt-4 border-t border-ink-700/60 pt-3 text-[11px] text-fog-500">
        From {observations} observation{observations === 1 ? '' : 's'}. Their frames have expired.
      </p>
    ) : null;
  }

  const live = frames.filter((f) => !f.expired).length;
  const expired = frames.length - live;

  return (
    <section className="mt-4 border-t border-ink-700/60 pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.09em] text-fog-500">What buddy saw</p>
        <p className="text-[10px] text-fog-500">
          {live} on disk{expired > 0 && ` · ${expired} expired`}
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {frames.map((f) => (
          <figure key={f.id} className="overflow-hidden rounded-lg border border-ink-700/70 bg-ink-900">
            {f.expired || !urls[f.id] ? (
              <div className="flex aspect-[16/10] items-center justify-center bg-ink-950/60 px-2 text-center">
                <span className="text-[10px] leading-tight text-fog-500">
                  {f.expired ? 'expired' : 'loading…'}
                </span>
              </div>
            ) : (
              <img
                src={urls[f.id]!}
                alt={`${f.appName} at ${new Date(f.ts).toLocaleTimeString()}`}
                className="aspect-[16/10] w-full object-cover object-top"
                loading="lazy"
              />
            )}
            <figcaption className="flex items-baseline justify-between gap-1.5 px-2 py-1.5">
              <span className="truncate text-[10px] text-fog-300">{f.appName || '—'}</span>
              <span className="shrink-0 font-mono text-[9px] text-fog-500">
                {new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
