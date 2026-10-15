import { areaChart } from "enarratio/lite/area";

import { formatDateMonthDay, formatDateShort } from "~/lib/date-format";
import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { formatAmounts } from "~/lib/money-format";

import { healthScoreBand, type HealthScoreBand } from "./health-band";

// The Intelligence customer detail page's words and figures (row S18, job
// J68), kept out of the route so they are testable without a render tree and
// out of views.server.ts so the browser bundle can use them. Recova is the
// spec: app/(app)/intelligence/customers/[id]/page.tsx at blob 8d31766d and
// components/intelligence/HealthSparkline.tsx at blob f4a163f5.

const MONTH_MS = 30 * 86_400_000;

/** Recova's tenureFromSince (page.tsx:20-30) word for word: "unknown",
 *  "< 1 month", "1 month", "N months", "N year(s)", "Ny Mmo". Takes nowMs so
 *  the server and browser renders agree. */
export function tenureFromSince(since: Date | null, nowMs: number): string {
  if (!since) return "unknown";
  const months = Math.floor((nowMs - since.getTime()) / MONTH_MS);
  if (months < 1) return "< 1 month";
  if (months === 1) return "1 month";
  if (months < 12) return `${months} months`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years} year${years > 1 ? "s" : ""}` : `${years}y ${rem}mo`;
}

type Amounts = readonly { currency: string; cents: number }[];

/** What Foxhound has on record for one customer, read from its own tables
 *  (getCustomerActivity in views.server.ts). Money is per currency, never
 *  added across currencies (RULES.md 3.20). */
export interface CustomerActivity {
  recovery: {
    failedPaymentCount: number;
    recoveredCount: number;
    recoveredAmounts: Amounts;
    lastFailedAt: Date | null;
    lastRecoveredAt: Date | null;
    /** A Foxhound sequence is running for one of the customer's payments. */
    activeRecovery: boolean;
  };
  disputes: {
    count: number;
    openCount: number;
    wonCount: number;
    lostCount: number;
    totalDisputed: Amounts;
    lastDisputeAt: Date | null;
    lastOutcome: "resolved_won" | "resolved_lost" | null;
  };
  engagement: {
    /** Any open or click on record, at any time. */
    everEngaged: boolean;
    opens30d: number;
    clicks30d: number;
    lastOpenAt: Date | null;
  };
  /** The latest failed payment, recovery, dispute or engagement event on
   *  record: the page's "Last seen". Null when there is none. */
  lastActivityAt: Date | null;
}

export interface SignalField {
  label: string;
  value: string;
}

const count = (n: number) => n.toLocaleString("en-US");
const date = (d: Date | null) => (d ? formatDateShort(d) : "-");

/** Recova's "Recovery signals" card. Null is its empty state, "No recovery
 *  events". Recova showed the active recovery's raw database id (RULES.md
 *  1.5); Foxhound says whether one is running. */
export function recoverySignalFields(r: CustomerActivity["recovery"]): SignalField[] | null {
  if (r.failedPaymentCount === 0) return null;
  return [
    { label: "Failed payments", value: count(r.failedPaymentCount) },
    { label: "Recovered", value: count(r.recoveredCount) },
    { label: "Recovered amount", value: formatAmounts(r.recoveredAmounts) },
    { label: "Last failed", value: date(r.lastFailedAt) },
    { label: "Last recovered", value: date(r.lastRecoveredAt) },
    { label: "Active recovery", value: r.activeRecovery ? "In progress" : "-" },
  ];
}

/** Recova's "Dispute signals" card; null is "No dispute history". The last
 *  outcome is the dispute list's word ("Won", "Lost"), not the stored state. */
export function disputeSignalFields(d: CustomerActivity["disputes"]): SignalField[] | null {
  if (d.count === 0) return null;
  return [
    { label: "Open", value: count(d.openCount) },
    { label: "Won", value: count(d.wonCount) },
    { label: "Lost", value: count(d.lostCount) },
    { label: "Total disputed", value: formatAmounts(d.totalDisputed) },
    { label: "Last dispute", value: date(d.lastDisputeAt) },
    { label: "Last outcome", value: d.lastOutcome ? DISPUTE_STATE_LABELS[d.lastOutcome] : "-" },
  ];
}

/** Recova's "Engagement signals" card; null is "No engagement data yet". The
 *  30-day counts are counted over the last 30 days, so the labels are true. */
export function engagementSignalFields(e: CustomerActivity["engagement"]): SignalField[] | null {
  if (!e.everEngaged) return null;
  return [
    { label: "Opens (30d)", value: count(e.opens30d) },
    { label: "Clicks (30d)", value: count(e.clicks30d) },
    { label: "Last open", value: date(e.lastOpenAt) },
  ];
}

export interface HealthReading {
  recordedAt: Date;
  healthScore: number;
}

/** The text equivalent of the health history chart. */
export function healthHistoryAlt(readings: readonly HealthReading[]): string {
  const first = readings[0];
  const last = readings[readings.length - 1];
  if (!first || !last) return "Health score: no readings yet.";
  const scores = readings.map((r) => r.healthScore);
  return (
    `Health score over ${readings.length} readings, from ${first.healthScore} on ${formatDateMonthDay(first.recordedAt)} ` +
    `to ${last.healthScore} on ${formatDateMonthDay(last.recordedAt)}; lowest ${Math.min(...scores)}, highest ${Math.max(...scores)}.`
  );
}

/** The line's colour, by the latest score's band, as Recova coloured its line
 *  by the latest score (HealthSparkline.tsx:20-22), on Foxhound's bands and
 *  the same colours the dashboard's health chart uses. */
const BAND_COLOR: Record<HealthScoreBand, string> = {
  at_risk: "var(--red)",
  watch: "var(--warning-text)",
  healthy: "var(--green)",
};

/** Recova's chart is 120px of plot; Enarratio keeps 64px for its axes. */
export const HEALTH_CHART_HEIGHT = 184;

/** Recova's HealthSparkline: an area chart of the readings, oldest first, with
 *  short dates along the bottom. Readings arrive oldest first. */
export function drawHealthHistory(readings: readonly HealthReading[], width: number): string {
  const yLabel = "Health score";
  const latest = readings[readings.length - 1]?.healthScore ?? 0;
  return areaChart({
    data: readings.map((r) => ({ Date: r.recordedAt, score: r.healthScore })),
    x: "Date",
    y: "score",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: BAND_COLOR[healthScoreBand(latest)] },
    formatX: (v) => formatDateMonthDay(new Date(v)),
    alt: healthHistoryAlt(readings),
    width,
    height: HEALTH_CHART_HEIGHT,
  });
}
