import { CRON_SCHEDULE_MONTHLY } from "~/lib/constants";
import { formatDateMonthDay } from "~/lib/date-format";
import { formatMoneyShort } from "~/lib/money-format";

// Pure helpers for the Intelligence dashboard (row S16, job J67), shared by the
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
 * The next time a monthly cron of the shape "M H D * *" fires at or after
 * `nowMs`. Anything else throws, so a schedule change cannot leave the empty
 * state quietly naming the wrong day.
 */
export function nextScheduledRun(schedule: string, nowMs: number): Date {
  const match = /^(\d+) (\d+) (\d+) \* \*$/.exec(schedule);
  if (!match) throw new Error(`not a monthly schedule: ${schedule}`);
  const [minute, hour, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const now = new Date(nowMs);
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, minute);
  if (thisMonth >= nowMs) return new Date(thisMonth);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, hour, minute));
}

/**
 * Recova's "The first snapshot runs tonight at 2:15am UTC. Check back
 * tomorrow." was true of Recova's daily job. Foxhound's intelligence-sync runs
 * on CRON_SCHEDULE_MONTHLY, so the sentence names that run, computed from the
 * schedule itself.
 */
export function firstSnapshotSentence(nowMs: number): string {
  const at = nextScheduledRun(CRON_SCHEDULE_MONTHLY, nowMs);
  const day = at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  return `The first snapshot runs on ${day} at ${time} UTC. Check back after it runs.`;
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
 * than a raw stored value (RULES.md 1.5). Anything not an object of numbers
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
  | "ai_not_configured"
  | "ai_no_credit"
  | "generation_failed"
  | "not_entitled"
  | "invalid_intent"
  | "demo_read_only"
  | "limiter_unavailable"
  | "server_error";

const ERROR_MESSAGES: Partial<Record<GenerateReportError, string>> = {
  // Recova's words.
  rate_limited: "You hit the hourly generation limit. Try again later.",
  invalid_month: "Invalid month.",
  generation_failed: "Generation failed. Please try again.",
  // Recova's server-500 sentence.
  server_error: "Could not generate the report. Try again or contact support.",
  limiter_unavailable: "Reports cannot be generated right now. Try again shortly.",
  // Foxhound's: the narrative needs Anthropic credit, and its absence is said.
  ai_not_configured: "Reports cannot be generated right now: the AI analyst is not set up.",
  ai_no_credit: "Reports cannot be generated right now: the AI analyst is out of credit.",
  not_current_month: "Only this month's report can be generated.",
};

/** The HTTP status each refusal is answered with, so a 200 always means a report. */
export const GENERATE_REPORT_ERROR_STATUS: Record<GenerateReportError, number> = {
  invalid_intent: 400,
  invalid_month: 400,
  not_current_month: 400,
  demo_read_only: 403,
  not_entitled: 403,
  rate_limited: 429,
  ai_not_configured: 503,
  ai_no_credit: 503,
  generation_failed: 502,
  limiter_unavailable: 503,
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
    `MRR across ${points.length} monthly snapshots, from ${formatMoneyShort(first.totalMrrCents, currency)} ` +
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
    `Net revenue retention by month, latest ${formatPct(last.nrrPct)} on ${formatDateMonthDay(last.at)}, ` +
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
    `MRR movement by month. Latest, ${formatDateMonthDay(last.at)}: new ${m(last.newMrrCents)}, ` +
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

/**
 * Enarratio draws a <title> inside every bar and point, which browsers show as
 * a hover tooltip. This page adds no tooltips (Recova's were struck, 193); the
 * chart keeps its accessible name and its data table, which carry the same
 * numbers as text. The same rule as the recovery dashboard's charts.
 */
export function withoutHoverTitles(html: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/g, "");
}
