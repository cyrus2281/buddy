import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, formatBytes } from '../useBuddy.js';
import { Button, Card, spring, useMotionSafe } from '../components/primitives.js';
import type { FrameRow, TimelineDay } from '../../shared/types.js';

/// The Timeline (PRD §8.4): a day scrubber over a filmstrip of kept frames.
///
/// This is the screen where the retention promise stops being a sentence in
/// Settings and becomes something a person can see. §5.1 says frames expire
/// daily and notes do not; §5.2 says the UI must state the privacy position
/// without euphemism. So every day carries a **countdown on its face** — not a
/// setting, but when *these* frames actually go, read from the rows, because a
/// user who changed retention yesterday has frames from both regimes — and a
/// button to delete the day now without waiting for the sweep.
///
/// The filmstrip loads thumbnails lazily and one at a time. A day at a 15 s
/// capture interval is a few hundred frames, each a full-resolution PNG behind
/// an IPC call that base64s it; asking for all of them on mount would freeze
/// the window for several seconds and allocate a few hundred megabytes to show
/// a strip of 96 px images. An `IntersectionObserver` means only what is on
/// screen is ever read.

export function Timeline({ purgeVersion }: { purgeVersion: number }) {
  const [days, setDays] = useState<TimelineDay[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [appFilter, setAppFilter] = useState<string | null>(null);
  const [frames, setFrames] = useState<FrameRow[]>([]);
  const [open, setOpen] = useState<FrameRow | null>(null);
  const [hover, setHover] = useState<FrameRow | null>(null);
  const safe = useMotionSafe();

  const refreshDays = useCallback(async () => {
    const d = await api.getTimelineDays();
    setDays(d);
    setDay((prev) => (prev && d.some((x) => x.day === prev) ? prev : (d[0]?.day ?? null)));
  }, []);

  useEffect(() => {
    void refreshDays();
  }, [refreshDays, purgeVersion]);

  useEffect(() => {
    if (!day) {
      setFrames([]);
      return;
    }
    void api.getFramesForDay(day, appFilter).then(setFrames);
  }, [day, appFilter, purgeVersion]);

  // A filter that no longer matches anything on the newly-selected day would
  // show an empty strip and look like a bug.
  useEffect(() => setAppFilter(null), [day]);

  const current = days.find((d) => d.day === day) ?? null;

  if (days.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-[12px] leading-relaxed text-fog-500">
          No frames on disk. buddy keeps the ones that show something new and deletes them after the
          retention window — so an empty timeline means either it has not started watching, or
          everything it saw has already expired.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <DayScrubber days={days} selected={day} onSelect={setDay} />

      {current && (
        <DayHeader
          day={current}
          appFilter={appFilter}
          onFilter={setAppFilter}
          onDeleted={() => void refreshDays()}
        />
      )}

      <div className="relative">
        <div className="flex flex-wrap gap-1.5">
          <AnimatePresence initial={false}>
            {frames.map((f) => (
              <motion.button
                key={f.id}
                layout={safe}
                initial={safe ? { opacity: 0, scale: 0.94 } : false}
                animate={{ opacity: 1, scale: 1 }}
                exit={safe ? { opacity: 0, scale: 0.94 } : { opacity: 0 }}
                transition={safe ? spring : { duration: 0 }}
                onMouseEnter={() => setHover(f)}
                onMouseLeave={() => setHover((h) => (h?.id === f.id ? null : h))}
                onClick={() => setOpen(f)}
                className="group relative h-[62px] w-[100px] overflow-hidden rounded-md border
                           border-ink-700/70 bg-ink-900 transition-colors hover:border-ember-500/70"
                title={`${new Date(f.ts).toLocaleTimeString()} — ${f.app_name}`}
              >
                <Thumb path={f.path} />
                <span
                  className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-ink-950/90
                             to-transparent px-1 pb-0.5 pt-2 text-left font-mono text-[9px] text-fog-300"
                >
                  {new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>

        {frames.length === 0 && current && (
          <p className="py-6 text-center text-[12px] text-fog-500">
            {appFilter ? 'No frames from that app on this day.' : 'Nothing kept on this day.'}
          </p>
        )}

        {/* Hover enlarges (§8.4). Fixed to the viewport rather than positioned
            against the thumbnail, so a frame at the right edge does not push a
            preview off screen. */}
        <AnimatePresence>{hover && <HoverPreview frame={hover} />}</AnimatePresence>
      </div>

      <AnimatePresence>
        {open && <FullSize frame={open} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </div>
  );
}

// ── The scrubber ─────────────────────────────────────────────────────────────

function DayScrubber({
  days,
  selected,
  onSelect,
}: {
  days: TimelineDay[];
  selected: string | null;
  onSelect: (d: string) => void;
}) {
  const safe = useMotionSafe();
  const peak = Math.max(1, ...days.map((d) => d.frames));
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
      {[...days].reverse().map((d) => {
        const active = d.day === selected;
        return (
          <button
            key={d.day}
            onClick={() => onSelect(d.day)}
            className="group relative flex shrink-0 flex-col items-center gap-1.5"
            title={`${d.frames} frames · ${formatBytes(d.bytes)}`}
          >
            {/* Height is the day's frame count: a scrubber that also says how
                much of each day buddy actually saw. */}
            <span
              className={`w-9 rounded-sm transition-colors ${
                active ? 'bg-ember-500' : 'bg-ink-700 group-hover:bg-ink-600'
              }`}
              style={{ height: `${8 + (d.frames / peak) * 38}px` }}
            />
            <span
              className={`font-mono text-[10px] transition-colors ${
                active ? 'text-fog-100' : 'text-fog-500'
              }`}
            >
              {shortDay(d.day)}
            </span>
            {active && safe && (
              <motion.span
                layoutId="timeline-day"
                className="absolute -bottom-1 h-[2px] w-9 rounded-full bg-ember-500"
                transition={spring}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function DayHeader({
  day,
  appFilter,
  onFilter,
  onDeleted,
}: {
  day: TimelineDay;
  appFilter: string | null;
  onFilter: (b: string | null) => void;
  onDeleted: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  // The countdown is the point of this header, so it has to actually count.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const left = day.expiresAt - now;
  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-fog-100">{longDay(day.day)}</h3>
          <p className="mt-1 font-mono text-[11px] tabular-nums text-fog-500">
            {day.frames} frames · {formatBytes(day.bytes)} · {day.apps.length} app
            {day.apps.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="text-right">
          <p
            className={`font-mono text-[12px] tabular-nums ${
              left < 3_600_000 ? 'text-ember-300' : 'text-fog-300'
            }`}
          >
            {left <= 0 ? 'expiring on the next sweep' : `deletes in ${countdown(left)}`}
          </p>
          <p className="mt-0.5 text-[10px] text-fog-500">the notes made from them are kept</p>
        </div>
      </div>

      {day.apps.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-t border-ink-700/60 pt-3">
          <FilterChip active={appFilter === null} onClick={() => onFilter(null)}>
            all
          </FilterChip>
          {day.apps.map((a) => (
            <FilterChip
              key={a.bundleId + a.appName}
              active={appFilter === a.bundleId}
              onClick={() => onFilter(appFilter === a.bundleId ? null : a.bundleId)}
            >
              {a.appName || a.bundleId || 'unknown'}
              <span className="ml-1 font-mono text-[9px] opacity-60">{a.count}</span>
            </FilterChip>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-ink-700/60 pt-3">
        <p className="text-[11px] leading-relaxed text-fog-500">
          Screenshots stay on this machine. They leave only as model input when buddy observes or
          acts — that is the product, and it is worth knowing.
        </p>
        <Button
          variant="danger"
          onClick={() => {
            if (
              confirm(
                `Delete all ${day.frames} frames from ${longDay(day.day)} right now?\n\n` +
                  'The notes buddy made from them are kept, and they will still say which frames ' +
                  'they came from.',
              )
            ) {
              void api.deleteDay(day.day).then(onDeleted);
            }
          }}
        >
          Delete this day now
        </Button>
      </div>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? 'border-ember-500/60 bg-ember-500/10 text-ember-300'
          : 'border-ink-700 bg-ink-900 text-fog-500 hover:border-ink-600 hover:text-fog-300'
      }`}
    >
      {children}
    </button>
  );
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** One thumbnail, read only once it is on screen. See the note at the top. */
function Thumb({ path }: { path: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void api.readVaultFrame(path).then((d) => {
          if (alive) setSrc(d);
        });
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [path]);

  return (
    <span ref={ref} className="block h-full w-full">
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover object-top" draggable={false} />
      ) : (
        <span className="block h-full w-full bg-ink-850" />
      )}
    </span>
  );
}

function HoverPreview({ frame }: { frame: FrameRow }) {
  const [src, setSrc] = useState<string | null>(null);
  const safe = useMotionSafe();
  useEffect(() => {
    let alive = true;
    void api.readVaultFrame(frame.path).then((d) => alive && setSrc(d));
    return () => {
      alive = false;
    };
  }, [frame.path]);

  return (
    <motion.div
      initial={safe ? { opacity: 0, y: 8, scale: 0.98 } : { opacity: 1 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={safe ? { opacity: 0, scale: 0.99 } : { opacity: 0 }}
      transition={safe ? { type: 'spring', stiffness: 460, damping: 34 } : { duration: 0 }}
      className="pointer-events-none fixed bottom-5 right-5 z-40 w-[400px] overflow-hidden
                 rounded-xl border border-ink-700 bg-ink-900/95 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)]
                 backdrop-blur-md"
    >
      {src ? (
        <img src={src} alt="" className="block w-full" />
      ) : (
        <div className="h-[240px] bg-ink-850" />
      )}
      <div className="px-3 py-2">
        <p className="truncate text-[11px] text-fog-100">{frame.app_name || 'unknown app'}</p>
        <p className="truncate font-mono text-[10px] text-fog-500">
          {frame.window_title || '(no window title)'}
        </p>
      </div>
    </motion.div>
  );
}

/** Click opens full size with its app, window title, and observation (§8.4). */
function FullSize({ frame, onClose }: { frame: FrameRow; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [observation, setObservation] = useState<string | null>(null);
  const safe = useMotionSafe();

  useEffect(() => {
    let alive = true;
    void api.readVaultFrame(frame.path).then((d) => alive && setSrc(d));
    // The observation is found by time rather than by a join: the frame ids an
    // observation cites are in a JSON column, and one scan of the recent rows
    // is cheaper and simpler than teaching SQLite to index inside it.
    void api.getObservations(200).then((list) => {
      if (!alive) return;
      const hit = list.find((o) => o.frameIds.includes(frame.id));
      setObservation(hit?.summary ?? null);
    });
    return () => {
      alive = false;
    };
  }, [frame.id, frame.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={safe ? { opacity: 0 } : { opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={safe ? { duration: 0.16 } : { duration: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/92 p-8 backdrop-blur-sm"
    >
      <motion.div
        initial={safe ? { scale: 0.97, y: 8 } : false}
        animate={{ scale: 1, y: 0 }}
        exit={safe ? { scale: 0.98, opacity: 0 } : { opacity: 0 }}
        transition={safe ? spring : { duration: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border
                   border-ink-700 bg-ink-900"
      >
        <div className="min-h-0 flex-1 overflow-auto bg-ink-950">
          {src ? (
            <img src={src} alt="" className="block w-full" />
          ) : (
            <p className="p-10 text-center text-[12px] text-fog-500">
              This frame is no longer on disk — the retention sweep took it between the list and
              the click.
            </p>
          )}
        </div>
        <div className="shrink-0 border-t border-ink-700 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[12px] text-fog-100">{frame.app_name || 'unknown app'}</p>
              <p className="truncate font-mono text-[10px] text-fog-500">
                {frame.window_title || '(no window title)'}
              </p>
            </div>
            <p className="shrink-0 font-mono text-[10px] tabular-nums text-fog-500">
              {new Date(frame.ts).toLocaleString()} · {frame.w}×{frame.h}
            </p>
          </div>
          <p className="mt-2.5 border-t border-ink-800 pt-2.5 text-[11px] leading-relaxed text-fog-300">
            {observation ?? (
              <span className="text-fog-500">
                No observation covers this frame — either it was one of the ones buddy did not need,
                or the observation for this stretch has not been written yet.
              </span>
            )}
          </p>
          <button
            onClick={onClose}
            className="mt-3 text-[11px] text-fog-500 transition-colors hover:text-fog-100"
          >
            Close (esc)
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Formatting ───────────────────────────────────────────────────────────────

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

function shortDay(day: string): string {
  const d = parseDay(day);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'today';
  return d.toLocaleDateString([], { weekday: 'short' });
}

function longDay(day: string): string {
  const d = parseDay(day);
  const today = new Date();
  const prefix = d.toDateString() === today.toDateString() ? 'Today · ' : '';
  return prefix + d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function countdown(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
