import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TrustPanel } from '../components/trust.js';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Button, Card, Stat, spring, useMotionSafe } from '../components/primitives.js';
import { FACT_KINDS } from '../../shared/types.js';
import type {
  EpisodeView,
  FactKind,
  FactSource,
  FactView,
  MemoryHit,
  MemoryOverview,
  RhythmView,
} from '../../shared/types.js';

/// "You" — what buddy has learned about the person (M5).
///
/// Notes are what happened; this is who it happened to. The screen has one job
/// above all the others, and it is the same job §8.3 gave the Notes screen:
/// **the memory has to feel correctable.** A belief buddy holds about someone
/// shapes every goal it proposes, so every one of them is on this screen with
/// where it came from, how sure buddy is, and four buttons — right, wrong,
/// edit, forget. "Wrong" is not "delete": a rejected belief is kept, greyed,
/// so buddy does not learn it again an hour later.
///
/// The week heatmap is here for a different reason. It is the fastest proof
/// that buddy has learned something true — people recognise the shape of their
/// own week at a glance — and the fastest way to notice when it has not.

const KIND_LABEL: Record<FactKind, string> = {
  preference: 'Preferences',
  habit: 'Habits',
  workflow: 'How you work',
  skill: 'Skills',
  project: 'Projects',
  relationship: 'People',
  goal: 'Goals',
  context: 'Context',
};

const SOURCE_LABEL: Record<FactSource, string> = {
  observed: 'watched',
  told: 'you said',
  run: 'from a run',
  corrected: 'from a correction',
};

const ago = (ts: number) => {
  const d = Math.max(0, Date.now() - ts);
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  const days = Math.round(d / 86_400_000);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

export function You({ version }: { version: number }) {
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const safe = useMotionSafe();

  const refresh = useCallback(async () => setData(await api.getMemory()), []);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const groups = useMemo(() => {
    const believed = (data?.facts ?? []).filter((f) => f.status === 'active' || f.status === 'pinned');
    return FACT_KINDS.map((k) => ({
      kind: k,
      facts: believed
        .filter((f) => f.kind === k)
        .sort((a, b) => Number(a.dormant) - Number(b.dormant) || b.effective - a.effective),
    })).filter((g) => g.facts.length);
  }, [data]);
  const rejected = (data?.facts ?? []).filter((f) => f.status === 'rejected');

  if (!data) return <Card className="p-6 text-[12px] text-fog-500">Loading…</Card>;
  const l = data.learning;

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-light tracking-tight text-fog-100">What buddy has learned about you</h2>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-fog-500">
            Learned from watching you work, from the runs it does for you, and from every time you
            corrected it. buddy uses these when it reads your screen, answers a question, or takes
            over — so if one is wrong, say so.
          </p>
        </div>
        {!l.enabled && (
          <Card className="border-ember-400/40 bg-ember-500/5 p-3.5">
            <p className="text-[12px] leading-relaxed text-ember-300">
              <span className="font-medium">Learning is off.</span> buddy is not adding to this, and is not
              using it. Nothing here was deleted. Turn it back on in Settings › Memory.
            </p>
          </Card>
        )}
        <Card className="p-5">
          <div className="grid grid-cols-2 gap-y-5 sm:grid-cols-4">
            <Stat label="Beliefs" value={l.facts} sub={`${l.pinned} confirmed by you`} />
            <Stat label="Runs learned from" value={l.runs} sub={`${l.corrections} corrections`} />
            <Stat label="Rejected" value={l.rejected} sub="never learned again" />
            <Stat
              label="Last learned"
              value={l.lastLearnedAt ? ago(l.lastLearnedAt) : '—'}
              sub="from the hourly summary"
            />
          </div>
        </Card>
        <TeachBox onTaught={() => void refresh()} />
      </section>

      <SearchMemory version={version} />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium text-fog-100">Beliefs</h3>
          {rejected.length > 0 && (
            <button
              onClick={() => setShowRejected((v) => !v)}
              className="text-[11px] text-fog-500 transition-colors hover:text-fog-100"
            >
              {showRejected ? 'Hide rejected' : `Show ${rejected.length} rejected`}
            </button>
          )}
        </div>
        {groups.length === 0 ? (
          <Card className="p-6 text-center">
            <p className="text-[12px] leading-relaxed text-fog-500">
              Nothing yet. buddy learns a little with every hourly summary — most hours teach it nothing
              new, and that is how it should be. You can also tell it something directly above.
            </p>
          </Card>
        ) : (
          groups.map((g) => (
            <div key={g.kind} className="flex flex-col gap-1.5">
              <p className="text-[10px] uppercase tracking-[0.09em] text-fog-500">{KIND_LABEL[g.kind]}</p>
              <AnimatePresence initial={false}>
                {g.facts.map((f) => (
                  <motion.div
                    key={f.id}
                    layout={safe}
                    initial={safe ? { opacity: 0, y: 4 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    exit={safe ? { opacity: 0, height: 0 } : { opacity: 0 }}
                    transition={safe ? spring : { duration: 0 }}
                  >
                    <FactRow fact={f} onChanged={() => void refresh()} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ))
        )}
        {showRejected && rejected.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] uppercase tracking-[0.09em] text-fog-500">You said these are wrong</p>
            {rejected.map((f) => (
              <FactRow key={f.id} fact={f} onChanged={() => void refresh()} />
            ))}
          </div>
        )}
      </section>

      <Week rhythm={data.rhythm} />

      <Corrections corrections={data.corrections} runs={data.runs} />

      <TrustPanel version={version} />

      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-medium text-fog-100">The index</h3>
        <Card className="p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] tabular-nums text-fog-500">
            <span>
              model <span className="text-fog-300">{data.index.model ?? 'not installed'}</span>
            </span>
            <span>
              {data.index.items.toLocaleString()} memories · {data.index.dim}-d
            </span>
            <span className={data.index.accelerated ? '' : 'text-ember-300'}>
              sqlite-vec {data.index.accelerated ? 'on' : 'off — scanning'}
            </span>
            {data.index.pending > 0 && <span>{data.index.pending} catching up</span>}
          </div>
          <p className="mt-2 font-mono text-[10px] text-fog-500">
            {data.index.bySource.note} notes · {data.index.bySource.observation} observations ·{' '}
            {data.index.bySource.fact} facts · {data.index.bySource.episode} runs
          </p>
          {data.index.error && <p className="mt-2 text-[11px] text-ember-300">{data.index.error}</p>}
          <p className="mt-3 border-t border-ink-700/60 pt-3 text-[11px] leading-relaxed text-fog-500">
            Search by meaning runs entirely on this Mac: a 30 MB embedding model and a vector index inside
            buddy’s own database. Nothing here is sent anywhere to be indexed.
          </p>
          <div className="mt-3 flex flex-wrap gap-2.5">
            <Button onClick={() => void api.rebuildMemoryIndex().then(refresh)}>Rebuild index</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (
                  confirm(
                    'Forget everything buddy has learned about you — every belief, every run it learned from, and your week? Notes and the run log are kept.',
                  )
                ) {
                  void api.forgetLearned().then(refresh);
                }
              }}
            >
              Forget everything learned
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

// ── Teach ────────────────────────────────────────────────────────────────────

function TeachBox({ onTaught }: { onTaught: () => void }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      // The Ask box routes "remember that …" here too; this box takes the
      // sentence as-is, with or without the lead-in.
      const r = await api.teach(/^(remember|note|keep in mind)\b/i.test(t) ? t : `remember that ${t}`);
      setNote(r.fact ? `${r.note} “${r.fact.statement}”` : r.note);
      if (r.fact) setText('');
      onTaught();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 focus-within:border-ink-600">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="Tell buddy something about you — “I reply in threads, never by DM”"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fog-100 outline-none placeholder:text-fog-500/70"
        />
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          className="shrink-0 rounded-lg bg-moss-400/90 px-2.5 py-1 text-[11px] font-medium text-ink-950
                     transition-colors hover:bg-moss-400 disabled:opacity-30"
        >
          Remember
        </button>
      </div>
      {note && <p className="text-[11px] text-fog-300">{note}</p>}
    </div>
  );
}

// ── Facts ────────────────────────────────────────────────────────────────────

function Confidence({ fact }: { fact: FactView }) {
  const pct = Math.round(fact.effective * 100);
  return (
    <span className="inline-flex items-center gap-1.5" title={`buddy is ${pct}% sure of this now`}>
      <span className="relative h-1 w-12 overflow-hidden rounded-full bg-ink-700">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${fact.status === 'pinned' ? 'bg-moss-400' : 'bg-ember-400'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="tabular-nums">{pct}%</span>
    </span>
  );
}

function FactRow({ fact, onChanged }: { fact: FactView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.statement);
  const rejected = fact.status === 'rejected';

  const act = (p: Promise<unknown>) => void p.then(onChanged);

  return (
    <div
      className={`group rounded-xl border border-ink-700/70 bg-ink-850/60 px-4 py-2.5 transition-colors
                  hover:border-ink-600 ${fact.dormant || rejected ? 'opacity-55' : ''}`}
    >
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && draft.trim()) {
                setEditing(false);
                act(api.editFact(fact.id, { statement: draft }));
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px]
                       text-fog-100 outline-none focus:border-ember-500/70"
          />
          <Button
            variant="accent"
            onClick={() => {
              setEditing(false);
              act(api.editFact(fact.id, { statement: draft }));
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <p className={`text-[13px] leading-snug ${rejected ? 'text-fog-500 line-through' : 'text-fog-100'}`}>
          {fact.statement}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-fog-500">
          {!rejected && <Confidence fact={fact} />}
          <span className="rounded bg-ink-800 px-1 py-0.5">{SOURCE_LABEL[fact.source]}</span>
          {fact.status === 'pinned' && <span className="text-moss-400">confirmed</span>}
          {fact.dormant && <span className="text-ember-300">fading</span>}
          <span>seen {fact.evidence}×</span>
          <span>{ago(fact.lastSeenAt)}</span>
        </span>
        <span className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          {rejected ? (
            <>
              <SmallButton onClick={() => act(api.restoreFact(fact.id))}>Restore</SmallButton>
              <SmallButton danger onClick={() => act(api.forgetFact(fact.id))}>
                Forget
              </SmallButton>
            </>
          ) : (
            <>
              {fact.status !== 'pinned' && (
                <SmallButton title="buddy has this right" onClick={() => act(api.confirmFact(fact.id))}>
                  Right
                </SmallButton>
              )}
              <SmallButton
                title="buddy has this wrong — it will not learn it again"
                onClick={() => act(api.rejectFact(fact.id))}
              >
                Wrong
              </SmallButton>
              <SmallButton
                onClick={() => {
                  setDraft(fact.statement);
                  setEditing(true);
                }}
              >
                Edit
              </SmallButton>
              <SmallButton
                danger
                title="Remove it entirely, including from the list of things not to re-learn"
                onClick={() => act(api.forgetFact(fact.id))}
              >
                Forget
              </SmallButton>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function SmallButton({
  children,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
        danger
          ? 'border-transparent text-rust-400 hover:border-rust-400/40'
          : 'border-ink-700 text-fog-300 hover:border-ink-600 hover:text-fog-100'
      }`}
    >
      {children}
    </button>
  );
}

// ── Search ───────────────────────────────────────────────────────────────────

const SOURCE_BADGE: Record<MemoryHit['source'], string> = {
  note: 'note',
  observation: 'saw',
  fact: 'belief',
  episode: 'run',
};

function SearchMemory({ version }: { version: number }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[] | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => void api.searchMemory(query).then(setHits), 160);
    return () => clearTimeout(t);
  }, [query, version]);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-fog-100">Search everything buddy remembers</h3>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQuery('');
        }}
        placeholder="By meaning, not just words — “when do I usually stop for lunch”"
        className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] text-fog-100 outline-none
                   placeholder:text-fog-500/60 focus:border-ember-500/70"
      />
      {hits && hits.length === 0 && <p className="text-[11px] text-fog-500">Nothing that matches “{query}”.</p>}
      {hits && hits.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {hits.map((h) => (
            <div key={h.ref} className="rounded-xl border border-ink-700/70 bg-ink-850/60 px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-[12px] text-fog-100">{h.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-fog-500">
                  <span className="rounded bg-ink-800 px-1 py-0.5">{SOURCE_BADGE[h.source]}</span>
                  <span
                    title={
                      h.matched === 'both'
                        ? 'found by its words and its meaning'
                        : h.matched === 'words'
                          ? 'found by its words'
                          : 'found by meaning — it shares no word with your search'
                    }
                    className={h.matched === 'meaning' ? 'text-ember-300' : ''}
                  >
                    {h.matched === 'both' ? 'words + meaning' : h.matched}
                  </span>
                  {h.similarity != null && <span>{Math.round(h.similarity * 100)}%</span>}
                  <span>{ago(h.ts)}</span>
                </span>
              </div>
              {h.text && h.text !== h.title && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fog-500">{h.text}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── The week ─────────────────────────────────────────────────────────────────

const ROWS = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Week({ rhythm }: { rhythm: RhythmView }) {
  const max = Math.max(30, ...rhythm.grid.flat());
  const empty = !rhythm.trackedSince;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium text-fog-100">Your week</h3>
        {rhythm.trackedSince && (
          <span className="font-mono text-[10px] text-fog-500">
            since {new Date(rhythm.trackedSince).toLocaleDateString([], { month: 'short', day: 'numeric' })} · last{' '}
            {rhythm.weeks} week{rhythm.weeks === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <Card className="p-4">
        {empty ? (
          <p className="text-[12px] leading-relaxed text-fog-500">
            buddy learns the shape of your week from which app is in front, hour by hour. Nothing yet —
            give it a few days.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] gap-[2px]">
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="text-center font-mono text-[8px] text-fog-500">
                  {h % 3 === 0 ? h : ''}
                </span>
              ))}
              {ROWS.map((w) => (
                <React.Fragment key={w}>
                  <span className="font-mono text-[9px] leading-[14px] text-fog-500">{DAY[w]}</span>
                  {rhythm.grid[w]!.map((m, h) => (
                    <span
                      key={h}
                      title={
                        m
                          ? `${DAY[w]} ${h}:00 — ${m} min${rhythm.topApp[w]![h] ? `, mostly ${rhythm.topApp[w]![h]}` : ''}`
                          : `${DAY[w]} ${h}:00`
                      }
                      className="h-[14px] rounded-[3px]"
                      style={{
                        background: m
                          ? `color-mix(in srgb, var(--color-ember-500) ${Math.round(15 + (m / max) * 85)}%, var(--color-ink-800))`
                          : 'var(--color-ink-800)',
                      }}
                    />
                  ))}
                </React.Fragment>
              ))}
            </div>
            {rhythm.summary.length > 0 && (
              <ul className="mt-4 flex flex-col gap-1 border-t border-ink-700/60 pt-3 text-[12px] leading-relaxed text-fog-300">
                {rhythm.summary.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
            {rhythm.topApps.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {rhythm.topApps.map((a) => (
                  <span
                    key={a.bundleId}
                    className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 text-[10px] text-fog-300"
                  >
                    {a.appName} <span className="font-mono text-fog-500">{Math.round(a.minutes / 60)}h/wk</span>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

// ── Corrections ──────────────────────────────────────────────────────────────

function Corrections({ corrections, runs }: { corrections: EpisodeView[]; runs: EpisodeView[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-fog-100">When buddy guessed wrong</h3>
      {corrections.length === 0 ? (
        <Card className="p-5">
          <p className="text-[12px] leading-relaxed text-fog-500">
            {runs.length
              ? `Every goal you have run so far was buddy’s own suggestion or one you typed from scratch. When you change the goal buddy proposed, it remembers the difference — that is the most useful thing it learns.`
              : 'No runs yet. When you change the goal buddy proposes before running it, buddy remembers the difference here and gets it right next time.'}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-1.5">
          {corrections.map((c) => (
            <div key={c.id} className="rounded-xl border border-ink-700/70 bg-ink-850/60 px-4 py-2.5">
              <p className="text-[12px] leading-snug text-fog-500 line-through decoration-rust-400/60">
                {c.inferredGoal}
              </p>
              <p className="mt-1 text-[13px] leading-snug text-fog-100">{c.goal}</p>
              <p className="mt-1.5 font-mono text-[10px] text-fog-500">
                {c.goalSource === 'alternative' ? 'you picked buddy’s second guess' : 'you wrote your own'} ·{' '}
                {ago(c.ts)}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
