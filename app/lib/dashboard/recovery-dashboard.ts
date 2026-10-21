import {
  DAY_MS,
  DECLINE_CATEGORIES,
  type DeclineCategory,
  HOUR_MS,
  RECOVERY_FEE_BPS,
} from "~/lib/constants";
import { recoveryFeeCents } from "~/lib/billing/fees";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { formatMoney } from "~/lib/money-format";

import { dayKey, type DailyRatePoint, type RecoveryTimingBucket } from "./recovery-window";

// The /recovery/dashboard page's display arithmetic (J74, row S5): pure, no
// database, safe in the browser bundle. Recova is the spec for what each panel
// shows (app/(app)/recovery/dashboard at the blob shas named in the route);
// every number here is computed from Foxhound's own read model and constants.

/** A money total in one currency. Mirrors stats.server.ts's CurrencyAmount
 *  without importing a server module into the browser bundle. */
export interface CurrencyCents {
  currency: string;
  cents: number;
}

/** The recovery fee as Foxhound's pricing constant prints it ("20%"). */
export const RECOVERY_FEE_LABEL = `${RECOVERY_FEE_BPS / 100}%`;

/** Sum per currency, never across currencies (RULES.md 3.20). */
function sumByCurrency(rows: readonly { currency: string; cents: number }[]): CurrencyCents[] {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.cents);
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}

export interface RoiColumn {
  recovered: CurrencyCents[];
  fee: CurrencyCents[];
  kept: CurrencyCents[];
}

/**
 * One column of Recova's ROI widget. All time takes the rows Foxhound's
 * billing run would invoice (billableRecoveryRowConditions in
 * app/db/billable.ts: a billable attribution kind, held for the maturity, not
 * refunded, disputed or deleted); This month takes the same attributed rows
 * recovered since the 1st without the maturity, whose fee is billed once they
 * have held (listAttributedRecoveredSince). The fee is computed per
 * recovery with the billing run's own function and then summed, the way
 * getRecoveryStats sums feeOwed, so the panel and the invoice cannot round
 * differently. Recova's ROIWidget took 20% of every retry, email click and
 * manual recovery; Foxhound never bills a manual or Stripe-baseline recovery,
 * so those claims are not copied (ROWS-S S5, 181).
 */
export function roiColumn(rows: readonly { amountCents: number; currency: string }[]): RoiColumn {
  const recovered = sumByCurrency(rows.map((r) => ({ currency: r.currency, cents: r.amountCents })));
  const fee = sumByCurrency(rows.map((r) => ({ currency: r.currency, cents: recoveryFeeCents(r.amountCents) })));
  const kept = recovered.map((r) => ({
    currency: r.currency,
    cents: r.cents - (fee.find((f) => f.currency === r.currency)?.cents ?? 0),
  }));
  return { recovered, fee, kept };
}

/** Totals side by side, each in its own currency; none at all reads as zero. */
export function formatCurrencyTotals(rows: readonly CurrencyCents[]): string {
  if (rows.length === 0) return formatMoney(0, "usd");
  return rows.map((r) => formatMoney(r.cents, r.currency)).join(" · ");
}

/**
 * Recova's "N% of MRR" under Currently at risk: one decimal, shown only when
 * the account has an MRR figure. Only an at-risk total in a single currency is
 * divided, because an MRR estimate is one number in one currency and a sum
 * across currencies is meaningless (RULES.md 3.20).
 */
export function atRiskPctOfMrr(atRisk: readonly CurrencyCents[], mrrEstimateCents: number | null): number | null {
  if (!mrrEstimateCents || mrrEstimateCents <= 0 || atRisk.length !== 1) return null;
  return Math.round((atRisk[0]!.cents / mrrEstimateCents) * 1000) / 10;
}

/** "Oct 3" for a YYYY-MM-DD day key or a Date, in UTC so the server and the
 *  browser print the same day. */
export function formatShortDate(day: string | Date): string {
  const date = typeof day === "string" ? new Date(`${day}T00:00:00Z`) : day;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Oct 3, 2026", in UTC, for the Detected column. */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Enarratio draws a <title> inside every bar and point, which browsers show as
 * a hover tooltip. Recova's chart tooltips were struck (193) and this page adds
 * none, so they are removed. The chart keeps its accessible name (aria-label on
 * the SVG) and its data table, which carry the same numbers as text.
 */
export function withoutHoverTitles(html: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/g, "");
}

// ---- Recovery rate chart ----

/** The sentence a reader without the chart gets: where the running rate
 *  started and ended over the range. */
export function recoveryRateAlt(points: readonly DailyRatePoint[], rangeLabel: string): string {
  const present = points.filter((p): p is { date: string; rate: number } => p.rate !== null);
  if (present.length === 0) return `Recovery rate, ${rangeLabel}: no failed payments in this range yet.`;
  const first = present[0]!;
  const last = present[present.length - 1]!;
  if (present.length === 1) return `Recovery rate, ${rangeLabel}: ${first.rate}% on ${formatShortDate(first.date)}.`;
  return `Running recovery rate, ${rangeLabel}: ${first.rate}% on ${formatShortDate(first.date)} and ${last.rate}% on ${formatShortDate(last.date)}.`;
}

// ---- Recovered revenue chart ----

export interface DailyRecoveredRow {
  Day: string;
  currency: string;
  amount: number;
}

/**
 * Recovered amounts per UTC day over the last `days` days (oldest first),
 * zero-filled, one row per day per currency. Recova's buildDailyChart summed
 * amount_cents across currencies; a cross-currency sum is meaningless
 * (RULES.md 3.20), so each currency keeps its own bars.
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
      rows.push({ Day, currency: currency.toUpperCase(), amount: (byKey.get(`${Day}|${currency}`) ?? 0) / 100 });
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
    const total = formatMoney(Math.round(e.total * 100), currency);
    if (!e.best) return `${total}`;
    return `${total}, most on ${formatShortDate(e.best.Day)} (${formatMoney(Math.round(e.best.amount * 100), currency)})`;
  });
  return `Revenue recovered per day over the last ${days} days: ${parts.join("; ")}.`;
}

// ---- Recovery timing chart ----

export function recoveryTimingAlt(buckets: readonly RecoveryTimingBucket[]): string {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const parts = buckets.map((b) => `${b.dayBucket} ${b.percentage}% (${b.count})`);
  return `When the ${total} recover${total === 1 ? "y" : "ies"} of the last 30 days happened, by days after the payment failed: ${parts.join(", ")}.`;
}

// ---- Email performance by decline type ----

export interface EmailCategoryRow {
  Category: string;
  series: "Open rate" | "Click rate";
  rate: number;
}

/**
 * Recova draws every decline category it has, a zero bar included, rather than
 * only the ones with sends; Foxhound's categories are its engine's
 * (DECLINE_CATEGORIES), labelled by its own names, never the raw value.
 */
export function emailCategoryRows(
  performance: readonly { category: DeclineCategory; openRatePct: number; clickRatePct: number; emailCount: number }[],
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
  performance: readonly { category: DeclineCategory; openRatePct: number; clickRatePct: number; emailCount: number }[],
): string {
  const sent = performance.filter((p) => p.emailCount > 0);
  const parts = sent.map(
    (p) =>
      `${DECLINE_CATEGORY_LABELS[p.category]}: ${p.openRatePct}% opened and ${p.clickRatePct}% clicked of ${p.emailCount}`,
  );
  return `Recovery email open and click rates by decline type. ${parts.join("; ")}.`;
}

// ---- Decline breakdown ----

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
      pct: input.totalFailedCount > 0 ? Math.round((count / input.totalFailedCount) * 100) : 0,
      // Recova's own rule: a rate only once a category has two failures.
      recoveredPct: stats && stats.total >= 2 ? Math.round((stats.recovered / stats.total) * 100) : null,
      spark: (input.categorySparkline[category] ?? []).map((p) => p.count),
    };
  });
}

/** Recova's text beside each bar: "3 · 50% · 33% recovered". */
export function declineRowText(row: DeclineRow): string {
  return `${row.count} · ${row.pct}%${row.recoveredPct !== null ? ` · ${row.recoveredPct}% recovered` : ""}`;
}

// ---- Getting started (Recova's OnboardingChecklist) ----

export interface OnboardingInput {
  connected: boolean;
  senderName: string | null;
  notificationEmail: string | null;
  onboardingCompleted: boolean;
}

/** Recova's gate, read from its page.tsx: the checklist shows until onboarding
 *  is marked complete or all three steps are done. */
export function onboardingNeeded(o: OnboardingInput): boolean {
  return !o.onboardingCompleted && !(o.connected && !!o.senderName && !!o.notificationEmail);
}

// ---- Recovery queue ----

/** The queue's heading window, in hours, from the read model's window. */
export function hoursFromMs(ms: number): number {
  return Math.round(ms / HOUR_MS);
}

// ---- Failed payments table ----

export interface PaymentStepSummary {
  completed: number;
  total: number;
  /** The label of the next step still to run, or null when none is left. */
  next: string | null;
}

/**
 * Recova's Steps cell (components/recovery/PaymentRow.tsx, blob 0d2e1f52):
 * executed steps over all steps, and the first step, in sequence order, that
 * has neither run nor been given a result (a cancelled step has a result and
 * is never "next").
 */
export function paymentStepSummary(
  steps: readonly { stepNumber: number | null; stepType: string; executedAt: Date | null; result: string | null }[],
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

/** A decline category's label, or the stored value when it is not one of the
 *  engine's categories (never blank). */
export function declineLabel(category: string): string {
  return (DECLINE_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

/** What the getting-started checklist shows: which of Recova's three steps
 *  are done, and whether the checklist shows at all. Only whether each field
 *  is set crosses to the page, never the address itself. */
export interface OnboardingChecklistState {
  needed: boolean;
  connected: boolean;
  senderNameSet: boolean;
  alertAddressSet: boolean;
}

export function onboardingChecklistState(
  profile: { senderName: string | null; notificationEmail: string | null; onboardingCompleted: boolean },
  connected: boolean,
): OnboardingChecklistState {
  return {
    needed: onboardingNeeded({ connected, ...profile }),
    connected,
    senderNameSet: !!profile.senderName,
    alertAddressSet: !!profile.notificationEmail,
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

/**
 * Recova's deliverability panel on what Foxhound records: null (the empty
 * state) until a bounce or a spam complaint has been recorded in the range,
 * then bounce and spam rates over the range's sent emails, rounded as Recova
 * rounded them. There is no delivered rate: Foxhound stores no delivered
 * event (app/lib/email/events.ts ignores it).
 */
export function deliverabilityFigures(c: { sent: number; bounced: number; complaints: number }): DeliverabilityFigures | null {
  if (c.bounced + c.complaints === 0) return null;
  const pct = (n: number) => (c.sent > 0 ? Math.round((n / c.sent) * 100) : null);
  return { sent: c.sent, bounced: c.bounced, complaints: c.complaints, bounceRatePct: pct(c.bounced), spamRatePct: pct(c.complaints) };
}
