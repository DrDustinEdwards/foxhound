import type { DeclineCategory } from "~/lib/constants";

// Pure aggregation math for the Recovery dashboard's windowed read model
// (TASK-foxhound-recovery-surface-parity.md Phase 1, legacy's
// fetchDashboardData). No DB access here; app/lib/dashboard/recovery-window.server.ts
// calls these against real query results. Kept separate so the math is
// unit-tested without a database.

export const RECOVERY_RANGES = ["7d", "30d", "90d", "all"] as const;
export type RecoveryRange = (typeof RECOVERY_RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The per-category sparkline is ALWAYS a trailing 30 days, independent of
 *  whatever range the rest of a call is scoped to (see resolveRangeCutoff).
 *  Legacy reused its range-filtered query for this and silently zero-padded
 *  any day outside a sub-30-day range; this constant is why Foxhound queries
 *  the sparkline separately instead of repeating that. */
export const SPARKLINE_TRAILING_DAYS = 30;

export interface RangeResolution {
  /** Epoch ms cutoff (inclusive-from), or null for "all time". */
  cutoffMs: number | null;
  /** How many days the day-bucketed charts should span for this range. */
  rangeDays: number;
  /** Display label ("7d", "30d", "90d", "all time"). */
  rangeLabel: string;
}

/** Resolve a range selector into a query cutoff + chart span + label. Pure,
 *  direct port of legacy's range computation. "all" has no cutoff but still
 *  spans 90 days of daily charts (matching legacy exactly, not a fabricated
 *  choice: an unbounded chart has no natural day count). */
export function resolveRangeCutoff(range: RecoveryRange, nowMs: number): RangeResolution {
  if (range === "7d") return { cutoffMs: nowMs - 7 * DAY_MS, rangeDays: 7, rangeLabel: "7d" };
  if (range === "90d") return { cutoffMs: nowMs - 90 * DAY_MS, rangeDays: 90, rangeLabel: "90d" };
  if (range === "all") return { cutoffMs: null, rangeDays: 90, rangeLabel: "all time" };
  return { cutoffMs: nowMs - 30 * DAY_MS, rangeDays: 30, rangeLabel: "30d" };
}

/** "YYYY-MM-DD" in UTC, the day-bucket key used throughout. Pure. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Count occurrences per UTC day. Pure. */
export function countByDay(dates: Date[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const key = dayKey(d);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Count occurrences per UTC day, split by decline category. Pure. */
export function countByDayAndCategory(
  rows: { detectedAt: Date; declineCategory: DeclineCategory }[],
): Record<DeclineCategory, Map<string, number>> {
  const byCategory: Record<string, Map<string, number>> = {};
  for (const r of rows) {
    if (!byCategory[r.declineCategory]) byCategory[r.declineCategory] = new Map();
    const m = byCategory[r.declineCategory];
    const key = dayKey(r.detectedAt);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return byCategory as Record<DeclineCategory, Map<string, number>>;
}

export interface DailyCentsPoint {
  date: string;
  cents: number;
}

/** Sum cents per day over the last `rangeDays` days from `nowMs` (oldest to
 *  newest), zero-filled for days with nothing. Feeds the revenue-trend chart. */
export function sumCentsByDayWindow(
  rows: { date: Date; cents: number }[],
  rangeDays: number,
  nowMs: number,
): DailyCentsPoint[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const key = dayKey(r.date);
    byDay.set(key, (byDay.get(key) ?? 0) + r.cents);
  }
  const points: DailyCentsPoint[] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const key = dayKey(new Date(nowMs - i * DAY_MS));
    points.push({ date: key, cents: byDay.get(key) ?? 0 });
  }
  return points;
}

export interface DailyRatePoint {
  date: string;
  /** null when nothing had failed yet as of this date (a true zero state,
   *  not a 0% rate). */
  rate: number | null;
}

/**
 * Cumulative running recovery rate for each of the last `rangeDays` days
 * (oldest to newest). Cumulative rather than same-day, so a recovery landing
 * on day X against a failure detected on day Y < X is never double-counted
 * into a same-day rate above 100% (direct port of legacy's own fix and its
 * reasoning, comment preserved because the reasoning is non-obvious).
 */
export function cumulativeRecoveryRateDaily(
  failedByDay: Map<string, number>,
  recoveredByDay: Map<string, number>,
  rangeDays: number,
  nowMs: number,
): DailyRatePoint[] {
  const points: DailyRatePoint[] = [];
  let cumulativeRecovered = 0;
  let cumulativeFailed = 0;
  for (let i = rangeDays - 1; i >= 0; i--) {
    const key = dayKey(new Date(nowMs - i * DAY_MS));
    cumulativeRecovered += recoveredByDay.get(key) ?? 0;
    cumulativeFailed += failedByDay.get(key) ?? 0;
    const rate = cumulativeFailed === 0 ? null : Math.round((cumulativeRecovered / cumulativeFailed) * 100);
    points.push({ date: key, rate });
  }
  return points;
}

export interface CategorySparklinePoint {
  date: string;
  count: number;
}

/** Per-category daily failure counts over a genuine trailing 30-day window
 *  from `nowMs`, independent of any overall range cutoff (see
 *  SPARKLINE_TRAILING_DAYS). Only categories present in `failedByCatByDay`
 *  appear in the result. */
export function categorySparklineWindow(
  failedByCatByDay: Record<DeclineCategory, Map<string, number>>,
  nowMs: number,
): Record<DeclineCategory, CategorySparklinePoint[]> {
  const result: Record<string, CategorySparklinePoint[]> = {};
  for (const category of Object.keys(failedByCatByDay)) {
    const byDay = failedByCatByDay[category as DeclineCategory];
    const points: CategorySparklinePoint[] = [];
    for (let i = SPARKLINE_TRAILING_DAYS - 1; i >= 0; i--) {
      const key = dayKey(new Date(nowMs - i * DAY_MS));
      points.push({ date: key, count: byDay.get(key) ?? 0 });
    }
    result[category] = points;
  }
  return result as Record<DeclineCategory, CategorySparklinePoint[]>;
}

export interface RecoveryTimingBucket {
  dayBucket: string;
  count: number;
  percentage: number;
}

/** Bucket recovery lead times (days from detection to recovery) into Day 1 /
 *  Day 3 / Day 7 / Day 8+, with each bucket's share of the total. Pure,
 *  direct port of legacy's thresholds. */
export function recoveryTimingBuckets(recoveryDays: number[]): RecoveryTimingBucket[] {
  const buckets = { "Day 1": 0, "Day 3": 0, "Day 7": 0, "Day 8+": 0 };
  for (const d of recoveryDays) {
    if (d <= 1) buckets["Day 1"]++;
    else if (d <= 3) buckets["Day 3"]++;
    else if (d <= 7) buckets["Day 7"]++;
    else buckets["Day 8+"]++;
  }
  const total = recoveryDays.length;
  return (Object.entries(buckets) as [string, number][]).map(([dayBucket, count]) => ({
    dayBucket,
    count,
    percentage: total > 0 ? Math.round((count / total) * 100) : 0,
  }));
}

export interface CategoryStat {
  total: number;
  recovered: number;
}

export interface BestCategory {
  cat: DeclineCategory;
  rate: number;
}

/**
 * The best-performing decline category, preferring categories with enough
 * volume to be meaningful (>=3 failures AND >=2 recoveries); falls back to
 * >=2 failures only if nothing qualifies, so an early-stage account still
 * gets a winner surfaced. Direct port of legacy's thresholds.
 */
export function bestCategory(
  categoryStats: Partial<Record<DeclineCategory, CategoryStat>>,
): BestCategory | null {
  const withRates = (Object.entries(categoryStats) as [DeclineCategory, CategoryStat][]).map(
    ([cat, v]) => ({ cat, total: v.total, recovered: v.recovered, rate: Math.round((v.recovered / v.total) * 100) }),
  );
  const strictWinner = withRates.filter((c) => c.total >= 3 && c.recovered >= 2).sort((a, b) => b.rate - a.rate)[0];
  const fallbackWinner = withRates.filter((c) => c.total >= 2).sort((a, b) => b.rate - a.rate)[0];
  const winner = strictWinner ?? fallbackWinner;
  return winner ? { cat: winner.cat, rate: winner.rate } : null;
}

export type WebhookHealthTone = "success" | "neutral" | "failure";

export interface WebhookHealth {
  tone: WebhookHealthTone;
  label: string;
}

const WEBHOOK_HEALTHY_WITHIN_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_QUIET_WITHIN_MS = 72 * 60 * 60 * 1000;

/** Classify Stripe webhook freshness into a Badge-compatible tone. A webhook
 *  received within 24h reads healthy; within 72h reads as a quiet-but-not-
 *  alarming neutral; beyond that reads as a failure worth flagging. Never
 *  having received one yet (a brand new connection) is neutral, not a
 *  failure. */
export function classifyWebhookHealth(lastWebhookAt: Date | null, nowMs: number): WebhookHealth {
  if (!lastWebhookAt) return { tone: "neutral", label: "Waiting for the first webhook" };
  const ageMs = nowMs - lastWebhookAt.getTime();
  if (ageMs <= WEBHOOK_HEALTHY_WITHIN_MS) return { tone: "success", label: "Receiving webhooks" };
  if (ageMs <= WEBHOOK_QUIET_WITHIN_MS) return { tone: "neutral", label: "No webhook in the last day" };
  return { tone: "failure", label: "No webhook in over 3 days" };
}

/** "Today" / "Yesterday" / "Nd ago" / "Nmo ago". Pure, small, and scoped to
 *  this module rather than reused across product areas. */
export function formatRelativeTime(date: Date | null, nowMs: number): string | null {
  if (!date) return null;
  const days = Math.floor((nowMs - date.getTime()) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}
