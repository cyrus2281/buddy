import { getDb } from '../store/db.js';
import { log } from '../log.js';
import type { T0Signal } from '../capture/scheduler.js';
import type { RhythmView } from '../../shared/types.js';

/// The shape of someone's week, learned for free.
///
/// The T0 signal already says, every two seconds, which app is in front and
/// how long since the last keystroke. Summed per app per local hour, that is
/// an exact record of when this person works and in what — no model, no
/// screenshot, no cost, and it outlives the daily frame purge because it is a
/// few integers per hour rather than a picture.
///
/// It feeds two things. Goal inference gets one line — "on Tuesdays around 10
/// this person is usually in VS Code" — as a tie-breaker, never as evidence.
/// And the "You" screen shows the week as a heatmap, which is the quickest way
/// for someone to see that buddy has actually learned something true about
/// them, and to notice if it has not.

/** A gap longer than this between signals is sleep, a lock, or a pause — not
 *  time spent in whatever app was last in front. */
const MAX_GAP_S = 30;
/** Idle this long, and the time is not "in" the app any more. */
const IDLE_CUTOFF_S = 60;
const FLUSH_MS = 60_000;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class RhythmRecorder {
  private last: T0Signal | null = null;
  private pending = new Map<string, { day: string; hour: number; weekday: number; bundleId: string; appName: string; seconds: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: { excluded: (bundleId: string) => boolean; enabled: () => boolean }) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
    this.last = null;
  }

  /** Each interval is credited to the app that was in front at its start. */
  onSignal = (s: T0Signal) => {
    const prev = this.last;
    this.last = s;
    if (!prev || !this.deps.enabled()) return;
    const dt = (s.ts - prev.ts) / 1000;
    if (dt <= 0 || dt > MAX_GAP_S) return;
    if (prev.idleSeconds >= IDLE_CUTOFF_S) return;
    if (!prev.bundleId && !prev.appName) return;
    // An excluded app is one the person asked buddy not to look at. Knowing
    // how long they spent in their password manager is looking at it.
    if (prev.secureInput || this.deps.excluded(prev.bundleId)) return;

    const d = new Date(prev.ts);
    const day = localDay(prev.ts);
    const hour = d.getHours();
    const key = `${day}|${hour}|${prev.bundleId}`;
    const cur = this.pending.get(key);
    if (cur) {
      cur.seconds += dt;
      cur.appName = prev.appName || cur.appName;
    } else {
      this.pending.set(key, {
        day,
        hour,
        weekday: d.getDay(),
        bundleId: prev.bundleId,
        appName: prev.appName || prev.bundleId,
        seconds: dt,
      });
    }
  };

  flush() {
    if (!this.pending.size) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    try {
      const db = getDb();
      const up = db.prepare(
        `INSERT INTO app_usage (day, hour, weekday, bundle_id, app_name, seconds) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, hour, bundle_id) DO UPDATE SET
           seconds = seconds + excluded.seconds, app_name = excluded.app_name`,
      );
      db.transaction(() => {
        for (const r of rows) up.run(r.day, r.hour, r.weekday, r.bundleId, r.appName, Math.round(r.seconds));
      })();
    } catch (e) {
      log.warn('memory', 'could not record app usage', { error: (e as Error).message });
    }
  }
}

const fmtHour = (h: number) => `${h}:00`;

/** Consecutive weekdays as "Mon–Fri", others listed. */
function dayRange(days: number[]): string {
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
  const runs: number[][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && (last[last.length - 1]! + 1) % 7 === d) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length >= 3 ? `${SHORT[r[0]!]}–${SHORT[r[r.length - 1]!]}` : r.map((d) => SHORT[d]).join(', ')))
    .join(', ');
}

/**
 * The week, averaged over the last `weeks` weeks.
 *
 * Each cell is the average active minutes in that hour **on the days of that
 * weekday buddy actually saw** — a Tuesday the Mac was shut is not a Tuesday
 * spent doing nothing, and averaging it in would teach buddy that this person
 * works half as much as they do.
 */
export function rhythm(now = Date.now(), weeks = 4): RhythmView {
  const since = localDay(now - weeks * 7 * 86_400_000);
  const rows = getDb()
    .prepare('SELECT day, hour, weekday, bundle_id, app_name, seconds FROM app_usage WHERE day >= ?')
    .all(since) as { day: string; hour: number; weekday: number; bundle_id: string; app_name: string; seconds: number }[];

  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const topApp = Array.from({ length: 7 }, () => new Array<string>(24).fill(''));
  const cellApps = new Map<string, Map<string, number>>();
  const daysSeen = Array.from({ length: 7 }, () => new Set<string>());
  const apps = new Map<string, { appName: string; bundleId: string; seconds: number }>();
  const allDays = new Set<string>();

  for (const r of rows) {
    daysSeen[r.weekday]!.add(r.day);
    allDays.add(r.day);
    grid[r.weekday]![r.hour]! += r.seconds;
    const k = `${r.weekday}|${r.hour}`;
    if (!cellApps.has(k)) cellApps.set(k, new Map());
    const m = cellApps.get(k)!;
    m.set(r.app_name, (m.get(r.app_name) ?? 0) + r.seconds);
    const a = apps.get(r.bundle_id) ?? { appName: r.app_name, bundleId: r.bundle_id, seconds: 0 };
    a.seconds += r.seconds;
    apps.set(r.bundle_id, a);
  }

  for (let w = 0; w < 7; w++) {
    const n = daysSeen[w]!.size || 1;
    for (let h = 0; h < 24; h++) {
      grid[w]![h] = Math.round(grid[w]![h]! / n / 60);
      const m = cellApps.get(`${w}|${h}`);
      if (m) topApp[w]![h] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    }
  }

  const days = grid.map((hours, weekday) => {
    const active = hours.map((m, h) => (m >= 10 ? h : -1)).filter((h) => h >= 0);
    return {
      weekday,
      start: active.length ? active[0]! : null,
      end: active.length ? active[active.length - 1]! + 1 : null,
      minutes: hours.reduce((a, b) => a + b, 0),
    };
  });

  const weeksCovered = Math.max(1, Math.ceil(allDays.size / 7));
  const topApps = [...apps.values()]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 8)
    .map((a) => ({ appName: a.appName, bundleId: a.bundleId, minutes: Math.round(a.seconds / 60 / weeksCovered) }));

  const trackedSince = rows.length ? Date.parse(`${[...allDays].sort()[0]}T00:00:00`) : null;

  return {
    weeks: weeksCovered,
    grid,
    topApp,
    days,
    topApps,
    summary: allDays.size >= 3 ? summarise(days, grid, cellApps) : [],
    trackedSince,
  };
}

function summarise(
  days: RhythmView['days'],
  grid: number[][],
  cellApps: Map<string, Map<string, number>>,
): string[] {
  const out: string[] = [];
  const working = days.filter((d) => d.minutes >= 60 && d.start != null);
  if (working.length) {
    const starts = working.map((d) => d.start!).sort((a, b) => a - b);
    const ends = working.map((d) => d.end!).sort((a, b) => a - b);
    const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
    out.push(
      `Usually at the Mac ${dayRange(working.map((d) => d.weekday))}, roughly ${fmtHour(median(starts))}–${fmtHour(median(ends))}.`,
    );
  }

  const byHour = new Array<number>(24).fill(0);
  for (const w of grid) w.forEach((m, h) => (byHour[h]! += m));
  const peak = byHour.indexOf(Math.max(...byHour));
  if (byHour[peak]! > 0) out.push(`Busiest hour: ${fmtHour(peak)}–${fmtHour(peak + 1)}.`);

  const part = (from: number, to: number) => {
    const m = new Map<string, number>();
    for (const [k, apps] of cellApps) {
      const h = Number(k.split('|')[1]);
      if (h < from || h >= to) continue;
      for (const [app, s] of apps) m.set(app, (m.get(app) ?? 0) + s);
    }
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (total < 1800) return null; // half an hour across the whole window
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([a]) => a);
  };
  const parts = [
    ['Mornings', part(5, 12)],
    ['afternoons', part(12, 18)],
    ['evenings', part(18, 24)],
  ] as const;
  const phrases = parts.filter(([, a]) => a?.length).map(([label, a]) => `${label} mostly ${a!.join(' and ')}`);
  if (phrases.length) {
    const s = phrases.join('; ');
    out.push(`${s[0]!.toUpperCase()}${s.slice(1)}.`);
  }
  return out;
}

/**
 * One line for goal inference: what this person usually does at this hour on
 * this weekday. Null until there are at least three days of it and this slot
 * has been seen — a guess about a slot buddy has never observed is noise.
 */
export function rhythmLine(now = Date.now()): string | null {
  const view = rhythm(now);
  if (!view.summary.length) return null;
  const d = new Date(now);
  const w = d.getDay();
  const h = d.getHours();
  const all = getDb()
    .prepare(
      `SELECT app_name, SUM(seconds) AS s FROM app_usage
        WHERE weekday = ? AND hour = ? AND day >= ? GROUP BY bundle_id ORDER BY s DESC`,
    )
    .all(w, h, localDay(now - 28 * 86_400_000)) as { app_name: string; s: number }[];
  const total = all.reduce((a, r) => a + r.s, 0);
  const rows = all.slice(0, 3);
  const slot =
    total >= 600
      ? `On ${WEEKDAYS[w]}s around ${fmtHour(h)} this person is usually in ` +
        rows.map((r) => `${r.app_name} (${Math.round((r.s / total) * 100)}%)`).join(', ') +
        '.'
      : `buddy has rarely seen this person at the Mac on ${WEEKDAYS[w]}s around ${fmtHour(h)}.`;
  return [slot, ...view.summary].join(' ');
}
