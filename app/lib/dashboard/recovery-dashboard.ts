import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import {
  DAY_MS,
  DECLINE_CATEGORIES,
  type DeclineCategory,
  HOUR_MS,
  RECOVERY_FEE_BPS,
} from "~/lib/constants";
import { recoveryFeeCents, unrefundedCents } from "~/lib/billing/fees";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { formatMoney, fromMajorUnits, toMajorUnits } from "@dustinedwards/site-runtime/money";

import { dayKey } from "@dustinedwards/site-runtime/time";
import type { RecoveryTimingBucket } from "./recovery-window";
import { percent } from "capsomer/behavior/meter";

// The /recovery/dashboard page's display arithmetic: pure, no database, safe in
// the browser bundle.

/** The recovery fee as Foxhound's pricing constant prints it ("20%"). */
export const RECOVERY_FEE_LABEL = `${RECOVERY_FEE_BPS / 100}%`;

export interface RoiColumn {
  recovered: CurrencyAmount[];
  fee: CurrencyAmount[];
  kept: CurrencyAmount[];
}

export function roiColumn(
  rows: readonly { amountCents: number; refundedCents: number; currency: string }[],
): RoiColumn {
  // A partly refunded recovery counts for what the merchant kept of it, and its
  // fee is taken on that, as the billing run takes it.
  const net = rows.map((r) => ({
    currency: r.currency,
    cents: unrefundedCents(r.amountCents, r.refundedCents),
  }));
  const recovered = groupSumByCurrency(net);
  const fee = groupSumByCurrency(
    net.map((r) => ({ currency: r.currency, cents: recoveryFeeCents(r.cents) })),
  );
  const kept = recovered.map((r) => ({
    currency: r.currency,
    cents: r.cents - (fee.find((f) => f.currency === r.currency)?.cents ?? 0),
  }));
  return { recovered, fee, kept };
}

export function atRiskPctOfMrr(
  atRisk: readonly CurrencyAmount[],
  mrrEstimateCents: number | null,
): number | null {
  if (!mrrEstimateCents || mrrEstimateCents <= 0 || atRisk.length !== 1) return null;
  return Math.round((atRisk[0]!.cents / mrrEstimateCents) * 1000) / 10;
}

/**
 * "Oct 3" for a YYYY-MM-DD day key or a Date, in UTC so the server and the
 * browser print the same day.
 */
export function formatShortDate(day: string | Date): string {
  const date = typeof day === "string" ? new Date(`${day}T00:00:00Z`) : day;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Oct 3, 2026", in UTC, for the Detected column. */
export function formatDetectedDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface DailyRecoveredRow {
  Day: string;
  currency: string;
  amount: number;
}

/**
 * Recovered amounts per UTC day over the last `days` days (oldest first),
 * zero-filled, one row per day per currency.
 */
export function dailyRecoveredRows(
  payments: readonly { recoveredAt: Date; amountCents: number; currency: string }[],
  days: number,
  nowMs: number,
): { rows: DailyRecoveredRow[]; currencies: string[] } {
  const currencies = [...new Set(payments.map((p) => p.currency))];
  if (currencies.length === 0) currencies.push("usd");
  const byKey = new Map<string, number>();
  for (const p of payments) {
    const key = `${dayKey(p.recoveredAt)}|${p.currency}`;
    byKey.set(key, (byKey.get(key) ?? 0) + p.amountCents);
  }
  const rows: DailyRecoveredRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const Day = dayKey(new Date(nowMs - i * DAY_MS));
    for (const currency of currencies) {
      rows.push({
        Day,
        currency: currency.toUpperCase(),
        amount: toMajorUnits(byKey.get(`${Day}|${currency}`) ?? 0, currency),
      });
    }
  }
  return { rows, currencies: currencies.map((c) => c.toUpperCase()) };
}

export function recoveredRevenueAlt(rows: readonly DailyRecoveredRow[], days: number): string {
  const byCurrency = new Map<string, { total: number; best: DailyRecoveredRow | null }>();
  for (const r of rows) {
    const entry = byCurrency.get(r.currency) ?? { total: 0, best: null };
    entry.total += r.amount;
    if (r.amount > 0 && (!entry.best || r.amount > entry.best.amount)) entry.best = r;
    byCurrency.set(r.currency, entry);
  }
  const parts = [...byCurrency.entries()].map(([currency, e]) => {
    const total = formatMoney(fromMajorUnits(e.total, currency), currency);
    if (!e.best) return `${total}`;
    return `${total}, most on ${formatShortDate(e.best.Day)} (${formatMoney(fromMajorUnits(e.best.amount, currency), currency)})`;
  });
  return `Revenue recovered per day over the last ${days} days: ${parts.join("; ")}.`;
}

export function recoveryTimingAlt(buckets: readonly RecoveryTimingBucket[]): string {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const parts = buckets.map((b) => `${b.dayBucket} ${b.percentage}% (${b.count})`);
  return `When the ${total} recover${total === 1 ? "y" : "ies"} of the last 30 days happened, by days after the payment failed: ${parts.join(", ")}.`;
}

export interface EmailCategoryRow {
  Category: string;
  series: "Open rate" | "Click rate";
  rate: number;
}

export function emailCategoryRows(
  performance: readonly {
    category: DeclineCategory;
    openRatePct: number;
    clickRatePct: number;
    emailCount: number;
  }[],
): { rows: EmailCategoryRow[]; totalSent: number } {
  const byCategory = new Map(performance.map((p) => [p.category, p]));
  const rows: EmailCategoryRow[] = [];
  for (const category of DECLINE_CATEGORIES) {
    const p = byCategory.get(category);
    const Category = DECLINE_CATEGORY_LABELS[category];
    rows.push({ Category, series: "Open rate", rate: p?.openRatePct ?? 0 });
    rows.push({ Category, series: "Click rate", rate: p?.clickRatePct ?? 0 });
  }
  return { rows, totalSent: performance.reduce((s, p) => s + p.emailCount, 0) };
}

export function emailCategoryAlt(
  performance: readonly {
    category: DeclineCategory;
    openRatePct: number;
    clickRatePct: number;
    emailCount: number;
  }[],
): string {
  const sent = performance.filter((p) => p.emailCount > 0);
  const parts = sent.map(
    (p) =>
      `${DECLINE_CATEGORY_LABELS[p.category]}: ${p.openRatePct}% opened and ${p.clickRatePct}% clicked of ${p.emailCount}`,
  );
  return `Recovery email open and click rates by decline type. ${parts.join("; ")}.`;
}

export interface DeclineRow {
  category: DeclineCategory;
  label: string;
  count: number;
  /** Share of all failures in the range, whole percent. */
  pct: number;
  /** Recovered share within the category, once it has two or more failures. */
  recoveredPct: number | null;
  /** Failures per day over the trailing 30 days, oldest first. */
  spark: number[];
}

export function declineRows(input: {
  totalFailedCount: number;
  categoryBreakdown: Partial<Record<DeclineCategory, number>>;
  categoryStats: Partial<Record<DeclineCategory, { total: number; recovered: number }>>;
  categorySparkline: Partial<Record<DeclineCategory, { date: string; count: number }[]>>;
}): DeclineRow[] {
  return DECLINE_CATEGORIES.map((category) => {
    const count = input.categoryBreakdown[category] ?? 0;
    const stats = input.categoryStats[category];
    return {
      category,
      label: DECLINE_CATEGORY_LABELS[category],
      count,
      pct: percent(count, input.totalFailedCount),
      recoveredPct: stats && stats.total >= 2 ? percent(stats.recovered, stats.total) : null,
      spark: (input.categorySparkline[category] ?? []).map((p) => p.count),
    };
  });
}

export function declineRowText(row: DeclineRow): string {
  return `${row.count} · ${row.pct}%${row.recoveredPct !== null ? ` · ${row.recoveredPct}% recovered` : ""}`;
}

export interface OnboardingInput {
  connected: boolean;
  senderName: string | null;
  notificationEmail: string | null;
  onboardingCompleted: boolean;
  liveSendsEnabled: boolean;
}

export function onboardingNeeded(o: OnboardingInput): boolean {
  return (
    !o.onboardingCompleted &&
    !(o.connected && !!o.senderName && !!o.notificationEmail && o.liveSendsEnabled)
  );
}

/** The queue's heading window, in hours, from the read model's window. */
export function hoursFromMs(ms: number): number {
  return Math.round(ms / HOUR_MS);
}

export interface PaymentStepSummary {
  completed: number;
  total: number;
  /** The label of the next step still to run, or null when none is left. */
  next: string | null;
}

export function paymentStepSummary(
  steps: readonly {
    stepNumber: number | null;
    stepType: string;
    executedAt: Date | null;
    result: string | null;
  }[],
  label: (stepType: string) => string,
): PaymentStepSummary {
  const sorted = [...steps].sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
  const next = sorted.find((s) => s.executedAt === null && s.result === null);
  return {
    completed: sorted.filter((s) => s.executedAt !== null).length,
    total: sorted.length,
    next: next ? label(next.stepType) : null,
  };
}

/**
 * A decline category's label, or the stored value when it is not one of the
 * engine's categories (never blank).
 */
export function declineLabel(category: string): string {
  return (DECLINE_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

export interface OnboardingChecklistState {
  needed: boolean;
  connected: boolean;
  senderNameSet: boolean;
  alertAddressSet: boolean;
  customerEmailsOn: boolean;
}

export function onboardingChecklistState(
  profile: {
    senderName: string | null;
    notificationEmail: string | null;
    onboardingCompleted: boolean;
    liveSendsEnabled: boolean;
  },
  connected: boolean,
): OnboardingChecklistState {
  return {
    needed: onboardingNeeded({ connected, ...profile }),
    connected,
    senderNameSet: !!profile.senderName,
    alertAddressSet: !!profile.notificationEmail,
    customerEmailsOn: profile.liveSendsEnabled,
  };
}

export interface DeliverabilityFigures {
  sent: number;
  bounced: number;
  complaints: number;
  /** Share of the range's sent emails, whole percent; null with no send. */
  bounceRatePct: number | null;
  spamRatePct: number | null;
}

export function deliverabilityFigures(c: {
  sent: number;
  bounced: number;
  complaints: number;
}): DeliverabilityFigures | null {
  if (c.bounced + c.complaints === 0) return null;
  const pct = (n: number) => (c.sent > 0 ? percent(n, c.sent) : null);
  return {
    sent: c.sent,
    bounced: c.bounced,
    complaints: c.complaints,
    bounceRatePct: pct(c.bounced),
    spamRatePct: pct(c.complaints),
  };
}
