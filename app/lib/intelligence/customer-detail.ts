import { formatCount } from "@drdustinedwards/site-helpers/text";
import { describeSeries } from "capsomer/behavior/chart-frame";
import { formatDate } from "capsomer/behavior/time";
import { areaChart } from "enarratio/lite/area";
import type { ChartFit } from "capsomer/react/chart-frame";

import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { formatAmounts } from "~/lib/money/totals";

import { healthScoreBand, type HealthScoreBand } from "./health-band";
import { DAY_MS } from "~/lib/constants";

// The Intelligence customer detail page's words and figures, kept out of the route so they are testable without a
// render tree and out of views.server.ts so the browser bundle can use them.

const MONTH_MS = 30 * DAY_MS;

/** "unknown", "< 1 month", "1 month", "N months", "N year(s)", "Ny Mmo". Takes nowMs so server and browser renders agree. */
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

/** What Foxhound has on record for one customer (getCustomerActivity in views.server.ts). Money is per currency, never added across. */
export interface CustomerActivity {
  recovery: {
    failedPaymentCount: number;
    recoveredCount: number;
    recoveredAmounts: Amounts;
    lastFailedAt: Date | null;
    lastRecoveredAt: Date | null;
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
    everEngaged: boolean;
    opens30d: number;
    clicks30d: number;
    lastOpenAt: Date | null;
  };
  /** The latest failed payment, recovery, dispute or engagement event: the page's "Last seen". Null when none. */
  lastActivityAt: Date | null;
}

export interface SignalField {
  label: string;
  value: string;
}

const date = (d: Date | null) => (d ? (formatDate(d, { style: "medium" }) ?? "") : "-");

/** The "Recovery signals" card. Null is its empty state, "No recovery events". Says whether a sequence is running, not its raw id. */
export function recoverySignalFields(r: CustomerActivity["recovery"]): SignalField[] | null {
  if (r.failedPaymentCount === 0) return null;
  return [
    { label: "Failed payments", value: formatCount(r.failedPaymentCount) },
    { label: "Recovered", value: formatCount(r.recoveredCount) },
    { label: "Recovered amount", value: formatAmounts(r.recoveredAmounts) },
    { label: "Last failed", value: date(r.lastFailedAt) },
    { label: "Last recovered", value: date(r.lastRecoveredAt) },
    { label: "Active recovery", value: r.activeRecovery ? "In progress" : "-" },
  ];
}

/** The "Dispute signals" card; null is "No dispute history". The last outcome is the dispute list's word ("Won", "Lost"). */
export function disputeSignalFields(d: CustomerActivity["disputes"]): SignalField[] | null {
  if (d.count === 0) return null;
  return [
    { label: "Open", value: formatCount(d.openCount) },
    { label: "Won", value: formatCount(d.wonCount) },
    { label: "Lost", value: formatCount(d.lostCount) },
    { label: "Total disputed", value: formatAmounts(d.totalDisputed) },
    { label: "Last dispute", value: date(d.lastDisputeAt) },
    { label: "Last outcome", value: d.lastOutcome ? DISPUTE_STATE_LABELS[d.lastOutcome] : "-" },
  ];
}

/** The "Engagement signals" card; null is "No engagement data yet". */
export function engagementSignalFields(e: CustomerActivity["engagement"]): SignalField[] | null {
  if (!e.everEngaged) return null;
  return [
    { label: "Opens (30d)", value: formatCount(e.opens30d) },
    { label: "Clicks (30d)", value: formatCount(e.clicks30d) },
    { label: "Last open", value: date(e.lastOpenAt) },
  ];
}

export interface HealthReading {
  recordedAt: Date;
  healthScore: number;
}

function healthHistoryAlt(readings: readonly HealthReading[]): string {
  return describeSeries({
    what: "Health score",
    x: readings.map((r) => formatDate(r.recordedAt, { style: "monthDay" }) ?? ""),
    values: readings.map((r) => r.healthScore),
    at: "on",
    empty: readings.length ? "Health score: 0 each time." : "Health score: no readings yet.",
  });
}

/** The line's color by the latest score's band, the same colors as the dashboard's health chart. */
const BAND_COLOR: Record<HealthScoreBand, string> = {
  at_risk: "var(--red)",
  watch: "var(--warn)",
  healthy: "var(--green)",
};

/** Enarratio keeps 64px of this for its axes. */
const HEALTH_CHART_HEIGHT = 184;

/** An area chart of the readings, oldest first, with short dates along the bottom. */
export function drawHealthHistory(
  readings: readonly HealthReading[],
  width: number,
  fit: ChartFit = {},
): string {
  const yLabel = "Health score (0-100)";
  const latest = readings[readings.length - 1]?.healthScore ?? 0;
  return areaChart({
    title: "Health score history",
    data: readings.map((r) => ({ Date: r.recordedAt, score: r.healthScore })),
    x: "Date",
    y: "score",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: BAND_COLOR[healthScoreBand(latest)] },
    formatX: (v) => formatDate(new Date(v), { style: "monthDay" }) ?? "",
    alt: healthHistoryAlt(readings),
    hoverTitles: false,
    width,
    height: HEALTH_CHART_HEIGHT,
    ...fit,
  });
}
