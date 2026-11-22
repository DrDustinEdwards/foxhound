import { describeSeries } from "capsomer/behavior/chart-frame";
import { formatDate } from "capsomer/behavior/time";
import { CRON_SCHEDULE_DAILY } from "~/lib/constants";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { monthKey } from "@dustinedwards/site-runtime/time";

// Pure helpers for the Intelligence dashboard, shared by the page and its tests. No database, no AI, no server
// import: the page bundles this for the browser.

export function shiftMonth(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split("-");
  return monthKey(new Date(Date.UTC(Number(y), Number(m) - 1 + delta, 1)));
}

export function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The first-snapshot sentence; the time is read from CRON_SCHEDULE_DAILY (when intelligence-sync runs), so a
 *  schedule change cannot leave it naming the wrong hour. */
export function firstSnapshotSentence(): string {
  const match = /^(\d+) (\d+) \* \* \*$/.exec(CRON_SCHEDULE_DAILY);
  if (!match) throw new Error(`not a daily schedule: ${CRON_SCHEDULE_DAILY}`);
  const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
  return `The first snapshot runs tonight at ${time} UTC. Check back tomorrow.`;
}

/** Every `stride`th item plus the last, keeping the newest day (NRR and churn charts). */
export function sampleEveryNth<T>(items: readonly T[], stride = 7): T[] {
  return items.filter((_, i) => i % stride === 0 || i === items.length - 1);
}

interface DailyPoint {
  at: Date;
  totalMrrCents: number;
  newMrrCents: number;
}

/** The latest snapshot's MRR less the one before it; null with fewer than two snapshots. */
export function dayOverDayCents(points: readonly DailyPoint[]): number | null {
  const last = points[points.length - 1];
  const prior = points[points.length - 2];
  return last && prior ? last.totalMrrCents - prior.totalMrrCents : null;
}

/** New MRR summed over this UTC month's snapshots. */
export function newMrrMonthToDateCents(points: readonly DailyPoint[], nowMs: number): number {
  const month = monthKey(new Date(nowMs));
  return points.filter((p) => monthKey(p.at) === month).reduce((sum, p) => sum + p.newMrrCents, 0);
}

/** "+$120" or "-$45": the sign is shown both ways so a fall does not read as a rise. */
export function signedMoney(cents: number, currency: string): string {
  return `${cents < 0 ? "-" : "+"}${formatMoneyShort(Math.abs(cents), currency)}`;
}

export interface MovementWeek {
  at: Date;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
}

function weekStart(at: Date): number {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return day - ((at.getUTCDay() + 6) % 7) * 86_400_000;
}

/** Each week's MRR movement, summed from its daily snapshots (sampling every 7th day would drop six in seven). */
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

export interface PlanRow {
  plan: string;
  mrrCents: number;
}

const UNNAMED_PLAN_KEY = "unknown";

/** The snapshot's per_plan_breakdown (written by buildPlanBreakdown) as rows, largest first. Plans with no MRR
 *  are left out, the "unknown" key is shown as words, and anything not an object of numbers reads as no plans. */
export function planBreakdownRows(raw: unknown): PlanRow[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .map(([plan, mrrCents]) => ({
      plan: plan === UNNAMED_PLAN_KEY ? "Unknown plan" : plan,
      mrrCents,
    }))
    .sort((a, b) => b.mrrCents - a.mrrCents);
}

export type GenerateReportError =
  | "invalid_month"
  | "not_current_month"
  | "rate_limited"
  | "invalid_intent"
  | "demo_read_only"
  | "server_error";

const ERROR_MESSAGES: Partial<Record<GenerateReportError, string>> = {
  rate_limited: "You hit the hourly generation limit. Try again later.",
  invalid_month: "Invalid month.",
  server_error: "Could not generate the report. Try again or contact support.",
  not_current_month: "Only this month's report can be generated.",
};

export const GENERATE_REPORT_ERROR_STATUS: Record<GenerateReportError, number> = {
  invalid_intent: 400,
  invalid_month: 400,
  not_current_month: 400,
  demo_read_only: 403,
  rate_limited: 429,
  server_error: 500,
};

/** The sentence the page shows for an error code. */
export function narrativeErrorMessage(code: string | undefined): string {
  return (
    (code && ERROR_MESSAGES[code as GenerateReportError]) ||
    "Could not generate the report. Try again or contact support."
  );
}

interface MrrPointLike {
  at: Date;
  totalMrrCents: number;
}

const day = (at: Date) => formatDate(at, { style: "monthDay" }) ?? "";

export function mrrTrendAlt(points: readonly MrrPointLike[], currency: string): string {
  return describeSeries({
    what: "MRR",
    x: points.map((p) => day(p.at)),
    values: points.map((p) => p.totalMrrCents),
    format: (c) => formatMoneyShort(c, currency),
    at: "on",
  });
}

export function formatPct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function nrrAlt(points: readonly { at: Date; nrrPct: number | null }[]): string {
  const present = points.filter((p): p is { at: Date; nrrPct: number } => p.nrrPct !== null);
  if (!present.length) return "Net revenue retention: no figure yet.";
  return `${describeSeries({
    what: "Net revenue retention by week",
    x: present.map((p) => day(p.at)),
    values: present.map((p) => p.nrrPct),
    format: formatPct,
    at: "on",
    empty: "Net revenue retention by week: 0%.",
  })} 100% is the line.`;
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
    `MRR movement by week. Week of ${day(last.at)}: new ${m(last.newMrrCents)}, ` +
    `expansion ${m(last.expansionMrrCents)}, reactivation ${m(last.reactivationMrrCents)}, ` +
    `contraction ${m(last.contractionMrrCents)}, churn ${m(last.churnMrrCents)}.`
  );
}

export function planAlt(rows: readonly PlanRow[], currency: string): string {
  if (rows.length === 0) return "MRR by plan: no plans with MRR.";
  return `MRR by plan, largest first: ${rows.map((r) => `${r.plan} ${formatMoneyShort(r.mrrCents, currency)}`).join(", ")}.`;
}

export function healthAlt(
  days: readonly { date: string; atRisk: number; watch: number; healthy: number }[],
): string {
  const last = days[days.length - 1];
  if (!last) return "Customer health distribution: no scores yet.";
  return (
    `Customers per health band over 90 days. Latest, ${formatDate(new Date(`${last.date}T00:00:00Z`), { style: "monthDay" }) ?? ""}: ` +
    `${last.atRisk} high risk, ${last.watch} medium risk, ${last.healthy} healthy.`
  );
}
