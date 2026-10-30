import { CRON_SCHEDULE_DAILY } from "~/lib/constants";
import { formatDateMonthDay } from "~/lib/date-format";
import { formatMoneyShort } from "~/lib/money-format";

// Pure helpers for the Intelligence dashboard, shared by the
// page and its tests. No database, no AI, no server import: the page bundles
// this for the browser.

// ---- The monthly summary's month pager (Recova's MonthlyNarrative.tsx) ----

/** "YYYY-MM" of a date, in UTC. */
export function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month `delta` months from "YYYY-MM". Recova's shiftMonth. */
export function shiftMonth(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split("-");
  return monthKeyOf(new Date(Date.UTC(Number(y), Number(m) - 1 + delta, 1)));
}

/** "October 2026". Recova's monthLabel. */
export function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---- The empty state's schedule sentence ----

/**
 * Recova's "The first snapshot runs tonight at 2:15am UTC. Check back
 * tomorrow.", with Foxhound's time: intelligence-sync runs daily on
 * CRON_SCHEDULE_DAILY, and the time is read from that schedule, so a change
 * to it cannot leave the sentence naming the wrong hour.
 */
export function firstSnapshotSentence(): string {
  const match = /^(\d+) (\d+) \* \* \*$/.exec(CRON_SCHEDULE_DAILY);
  if (!match) throw new Error(`not a daily schedule: ${CRON_SCHEDULE_DAILY}`);
  const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
  return `The first snapshot runs tonight at ${time} UTC. Check back tomorrow.`;
}

// ---- The daily series (Recova's MRRStatCards, NRRChart, MRRMovementChart) ----

/** Every `stride`th item plus the last: Recova's every-7th-row sampling on its
 *  NRR and churn charts, keeping the newest day. */
export function sampleEveryNth<T>(items: readonly T[], stride = 7): T[] {
  return items.filter((_, i) => i % stride === 0 || i === items.length - 1);
}

interface DailyPoint {
  at: Date;
  totalMrrCents: number;
  newMrrCents: number;
}

/** Recova's "Day-over-day": the latest snapshot's MRR less the one before it.
 *  null with fewer than two snapshots. */
export function dayOverDayCents(points: readonly DailyPoint[]): number | null {
  const last = points[points.length - 1];
  const prior = points[points.length - 2];
  return last && prior ? last.totalMrrCents - prior.totalMrrCents : null;
}

/** Recova's "New MRR (MTD)": new MRR summed over this UTC month's snapshots. */
export function newMrrMonthToDateCents(points: readonly DailyPoint[], nowMs: number): number {
  const month = monthKeyOf(new Date(nowMs));
  return points.filter((p) => monthKeyOf(p.at) === month).reduce((sum, p) => sum + p.newMrrCents, 0);
}

/** "+$120" or "-$45": Recova printed only a plus, and a fall read as a rise. */
export function signedMoney(cents: number, currency: string): string {
  return `${cents < 0 ? "-" : "+"}${formatMoneyShort(Math.abs(cents), currency)}`;
}

export interface MovementWeek {
  /** Monday 00:00 UTC of the week. */
  at: Date;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
}

/** Monday 00:00 UTC of the week holding `at` (Enarratio's week bucket). */
function weekStart(at: Date): number {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return day - ((at.getUTCDay() + 6) % 7) * 86_400_000;
}

/**
 * Each week's MRR movement, summed from its daily snapshots. Recova drew every
 * 7th day's movement and captioned it "by week", which dropped six days in
 * seven; the sum is what the caption says.
 */
export function weeklyMovements(points: readonly MovementWeek[]): MovementWeek[] {
  const weeks = new Map<number, MovementWeek>();
  for (const p of points) {
    const key = weekStart(p.at);
    const w = weeks.get(key) ?? {
      at: new Date(key),
      newMrrCents: 0,
      expansionMrrCents: 0,
      reactivationMrrCents: 0,
      contractionMrrCents: 0,
      churnMrrCents: 0,
    };
    w.newMrrCents += p.newMrrCents;
    w.expansionMrrCents += p.expansionMrrCents;
    w.reactivationMrrCents += p.reactivationMrrCents;
    w.contractionMrrCents += p.contractionMrrCents;
    w.churnMrrCents += p.churnMrrCents;
    weeks.set(key, w);
  }
  return [...weeks.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ---- MRR by plan (Recova's PlanBreakdown.tsx) ----

export interface PlanRow {
  plan: string;
  mrrCents: number;
}

/** buildPlanBreakdown's key for a customer whose plan has no name. */
const UNNAMED_PLAN_KEY = "unknown";

/**
 * The snapshot's per_plan_breakdown (plan name to MRR cents, written by
 * buildPlanBreakdown) as rows, largest first, as Recova sorts them. Plans with
 * no MRR are left out, and the engine's "unknown" key is shown as words rather
 * than a raw stored value. Anything not an object of numbers
 * reads as no plans.
 */
export function planBreakdownRows(raw: unknown): PlanRow[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .map(([plan, mrrCents]) => ({ plan: plan === UNNAMED_PLAN_KEY ? "Unknown plan" : plan, mrrCents }))
    .sort((a, b) => b.mrrCents - a.mrrCents);
}

// ---- Report generation errors ----

/** What generating a report can come back with, besides a narrative. */
export type GenerateReportError =
  | "invalid_month"
  | "not_current_month"
  | "rate_limited"
  | "invalid_intent"
  | "demo_read_only"
  | "server_error";

const ERROR_MESSAGES: Partial<Record<GenerateReportError, string>> = {
  // Recova's words.
  rate_limited: "You hit the hourly generation limit. Try again later.",
  invalid_month: "Invalid month.",
  // Recova's server-500 sentence.
  server_error: "Could not generate the report. Try again or contact support.",
  not_current_month: "Only this month's report can be generated.",
};

/** The HTTP status each refusal is answered with, so a 200 always means a report. */
export const GENERATE_REPORT_ERROR_STATUS: Record<GenerateReportError, number> = {
  invalid_intent: 400,
  invalid_month: 400,
  not_current_month: 400,
  demo_read_only: 403,
  rate_limited: 429,
  server_error: 500,
};

/** The sentence the page shows for an error code. Recova's fallback for anything else. */
export function narrativeErrorMessage(code: string | undefined): string {
  return (
    (code && ERROR_MESSAGES[code as GenerateReportError]) ||
    "Could not generate the report. Try again or contact support."
  );
}

// ---- Text equivalents for the charts (capsid/conventions-web.md rule 8) ----

interface MrrPointLike {
  at: Date;
  totalMrrCents: number;
}

export function mrrTrendAlt(points: readonly MrrPointLike[], currency: string): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "MRR: no snapshots yet.";
  if (points.length === 1) {
    return `MRR on ${formatDateMonthDay(last.at)}: ${formatMoneyShort(last.totalMrrCents, currency)}.`;
  }
  return (
    `MRR across ${points.length} daily snapshots, from ${formatMoneyShort(first.totalMrrCents, currency)} ` +
    `on ${formatDateMonthDay(first.at)} to ${formatMoneyShort(last.totalMrrCents, currency)} on ${formatDateMonthDay(last.at)}.`
  );
}

/** "101.5%". */
export function formatPct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function nrrAlt(points: readonly { at: Date; nrrPct: number | null }[]): string {
  const present = points.filter((p): p is { at: Date; nrrPct: number } => p.nrrPct !== null);
  const last = present[present.length - 1];
  if (!last) return "Net revenue retention: no figure yet.";
  const values = present.map((p) => p.nrrPct);
  return (
    `Net revenue retention by week, latest ${formatPct(last.nrrPct)} on ${formatDateMonthDay(last.at)}, ` +
    `ranging from ${formatPct(Math.min(...values))} to ${formatPct(Math.max(...values))}. 100% is the line.`
  );
}

export function movementAlt(
  points: readonly {
    at: Date;
    newMrrCents: number;
    expansionMrrCents: number;
    reactivationMrrCents: number;
    contractionMrrCents: number;
    churnMrrCents: number;
  }[],
  currency: string,
): string {
  const last = points[points.length - 1];
  if (!last) return "MRR movement: no snapshots yet.";
  const m = (c: number) => formatMoneyShort(c, currency);
  return (
    `MRR movement by week. Week of ${formatDateMonthDay(last.at)}: new ${m(last.newMrrCents)}, ` +
    `expansion ${m(last.expansionMrrCents)}, reactivation ${m(last.reactivationMrrCents)}, ` +
    `contraction ${m(last.contractionMrrCents)}, churn ${m(last.churnMrrCents)}.`
  );
}

export function planAlt(rows: readonly PlanRow[], currency: string): string {
  if (rows.length === 0) return "MRR by plan: no plans with MRR.";
  return `MRR by plan, largest first: ${rows.map((r) => `${r.plan} ${formatMoneyShort(r.mrrCents, currency)}`).join(", ")}.`;
}

export function healthAlt(days: readonly { date: string; atRisk: number; watch: number; healthy: number }[]): string {
  const last = days[days.length - 1];
  if (!last) return "Customer health distribution: no scores yet.";
  return (
    `Customers per health band over 90 days. Latest, ${formatDateMonthDay(new Date(`${last.date}T00:00:00Z`))}: ` +
    `${last.atRisk} high risk, ${last.watch} medium risk, ${last.healthy} healthy.`
  );
}

