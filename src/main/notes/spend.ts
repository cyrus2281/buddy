import { EventEmitter } from 'node:events';
import { kv } from '../store/db.js';
import { log } from '../log.js';
import type { SpendReport, SpendTier } from '../../shared/types.js';

/// The daily spend meter and its hard cap (PRD §5, R5).
///
/// The budget is ~$1.50–2.50 per 8-hour day. The risk the cap exists for is not
/// a single expensive call — the Operator has its own three budgets for that
/// (§6.5) — it is the Observer quietly running all night against a machine
/// someone left logged in, or a pathological screen that defeats pHash dedupe
/// and sends T2 six frames every three minutes.
///
/// **The cap pauses T2 and T3. It never blocks the user.** Refusing to infer a
/// goal because an overnight loop spent the budget would turn a cost control
/// into a broken hotkey; a person pressing the hotkey has asked for that money
/// to be spent. So `allow()` is consulted by the two background tiers, and
/// `record()` by everything — the meter tells the whole truth even where the
/// cap does not apply.

const KEY = (day: string) => `spend.${day}`;
const HISTORY_DAYS = 7;

export function dayKey(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface DayRecord {
  total: number;
  byTier: Partial<Record<SpendTier, number>>;
  calls: number;
}

const EMPTY: DayRecord = { total: 0, byTier: {}, calls: 0 };

const ZERO_TIERS: Record<SpendTier, number> = {
  t2: 0,
  t3: 0,
  inference: 0,
  operator: 0,
  'wake-check': 0,
  qa: 0,
};

export class SpendMeter extends EventEmitter {
  private capUsd: number;
  /** Latched so the "cap reached" line is logged once, not every three minutes. */
  private announcedFor: string | null = null;

  constructor(capUsd: number) {
    super();
    this.capUsd = capUsd;
  }

  setCap(capUsd: number) {
    const was = this.capped();
    this.capUsd = capUsd;
    if (was && !this.capped()) {
      this.announcedFor = null;
      log.info('spend', 'daily cap raised; observation resumes', { capUsd });
    }
    this.emit('changed', this.report());
  }

  cap(): number {
    return this.capUsd;
  }

  private read(day: string): DayRecord {
    return kv.get<DayRecord>(KEY(day), EMPTY);
  }

  /** Every model call buddy makes lands here, whichever tier spent it. */
  record(tier: SpendTier, costUsd: number, ts = Date.now()): SpendReport {
    const day = dayKey(ts);
    const rec = this.read(day);
    const next: DayRecord = {
      total: rec.total + costUsd,
      byTier: { ...rec.byTier, [tier]: (rec.byTier[tier] ?? 0) + costUsd },
      calls: rec.calls + 1,
    };
    kv.set(KEY(day), next);

    if (next.total >= this.capUsd && this.announcedFor !== day) {
      this.announcedFor = day;
      log.warn('spend', 'daily cap reached — T2 and T3 are paused until tomorrow', {
        day,
        total: Number(next.total.toFixed(4)),
        capUsd: this.capUsd,
      });
      this.emit('capped', this.report(ts));
    }
    const report = this.report(ts);
    this.emit('changed', report);
    return report;
  }

  spentToday(ts = Date.now()): number {
    return this.read(dayKey(ts)).total;
  }

  capped(ts = Date.now()): boolean {
    return this.spentToday(ts) >= this.capUsd;
  }

  /**
   * May a background tier spend?
   *
   * Only T2 and T3 ask. Everything else — goal inference, the Operator, M4's
   * wake checks — is something the user set in motion, and a cost control that
   * silently disables the product is not a cost control.
   */
  allow(tier: SpendTier, ts = Date.now()): boolean {
    if (tier !== 't2' && tier !== 't3') return true;
    return !this.capped(ts);
  }

  report(ts = Date.now()): SpendReport {
    const day = dayKey(ts);
    const rec = this.read(day);
    const history: { day: string; total: number }[] = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const d = dayKey(ts - i * 86_400_000);
      history.push({ day: d, total: this.read(d).total });
    }
    return {
      day,
      total: rec.total,
      byTier: { ...ZERO_TIERS, ...rec.byTier },
      calls: rec.calls,
      capUsd: this.capUsd,
      capped: rec.total >= this.capUsd,
      history,
    };
  }

  /** Settings' "reset today's spend": a user who raised the cap after hitting it
   *  should not have to wait for midnight to see observation resume. */
  resetToday(ts = Date.now()) {
    kv.set(KEY(dayKey(ts)), EMPTY);
    this.announcedFor = null;
    log.info('spend', "today's spend reset by the user");
    this.emit('changed', this.report(ts));
  }
}
