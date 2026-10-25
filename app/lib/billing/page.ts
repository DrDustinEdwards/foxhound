import { DISPUTE_FEE_BPS, RECOVERY_FEE_BPS } from "~/lib/constants";
import { formatDateShort } from "~/lib/date-format";

// What /billing (J65, row S3) shows, in the shapes its sections render. Pure and
// client-safe: the rows themselves are built on the server (page.server.ts) and
// these are the types and the small formatting rules the sections share.
//
// Recova is the spec for every label here (app/(app)/billing/page.tsx at blob
// 34e56833 and its four section components); the numbers are Foxhound's own
// constants, never retyped.

const BPS_PER_PERCENT = 100;

/** 20, from RECOVERY_FEE_BPS: Recova's "{RECOVERY_FEE_PCT}% of attributed recoveries". */
export const RECOVERY_FEE_PERCENT = RECOVERY_FEE_BPS / BPS_PER_PERCENT;
/** 20, from DISPUTE_FEE_BPS: Recova's "{DISPUTES_FEE_PCT}% of disputes we win". */
export const DISPUTE_FEE_PERCENT = DISPUTE_FEE_BPS / BPS_PER_PERCENT;

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st: the run's day of month as
 *  Recova writes it ("Invoiced on the 1st"). */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "August 1, 2026", in UTC: Recova's next invoice date. The run fires at 04:00
 *  UTC, and a local zone would show the previous day west of London. */
export function formatLongDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A billing status's tone, in Capsomer's status words: paid is ok, a failed or
 *  abandoned collection is critical, everything else is a plain label. */
export type FeeStatusTone = "ok" | "crit" | "neutral";

/** One of Recova's recovery assessment rows: one Foxhound invoice that billed
 *  recovery fees, with its recoveries and their fees only. */
export interface RecoveryHistoryRow {
  invoiceId: string;
  periodLabel: string;
  currency: string;
  recoveredCents: number;
  feeCents: number;
  /** Credit notes issued since against these fees (PRICING.md rev 5), as a
   *  positive amount; 0 when none. */
  creditedCents: number;
  statusLabel: string;
  statusTone: FeeStatusTone;
  invoiceUrl: string | null;
  stripeInvoiceId: string | null;
}

/** One of Recova's dispute fee rows: a dispute fee already invoiced, or one the
 *  next run will invoice (Pending). */
export interface DisputeFeeRow {
  key: string;
  disputeId: string;
  currency: string;
  disputeAmountCents: number;
  feeCents: number;
  /** True when the $500 cap held the fee below the percentage. */
  feeCapped: boolean;
  /** Credit notes issued since against this fee, as a positive amount; 0 when none. */
  creditedCents: number;
  statusLabel: string;
  statusTone: FeeStatusTone;
  invoiceUrl: string | null;
  stripeInvoiceId: string | null;
}

/** The account_subscriptions fields Recova's Subscriptions section reads. */
export interface SubscriptionView {
  id: string;
  product: string;
  status: string;
  currentPeriodEndsAt: Date | null;
  canceledAt: Date | null;
}

const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  canceled: "Canceled",
  past_due: "Past due",
};

/** A readable status, never the raw column value (RULES.md 1.5). */
export function subscriptionStatusLabel(status: string): string {
  return SUBSCRIPTION_STATUS_LABELS[status] ?? titleCase(status.replace(/[-_]/g, " "));
}

/** Recova's badge colors: active green, past due red, the rest neutral. */
export function subscriptionStatusTone(status: string): FeeStatusTone {
  if (status === "active") return "ok";
  if (status === "past_due") return "crit";
  return "neutral";
}

const PRODUCT_DISPLAY_NAMES: Record<string, string> = {
  intelligence: "Intelligence",
  disputes: "Disputes",
};

/** Recova's productDisplayName, word for word. */
export function productDisplayName(slug: string): string {
  return PRODUCT_DISPLAY_NAMES[slug] ?? titleCase(slug.replace(/[-_]/g, " "));
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Recova's line under a subscription: "Renews", "Cancels on" or "Expired" with
 * the period end, and nothing without one. `warn` marks "Cancels on", which
 * Recova colors apart; here it takes Foxhound's amber accent.
 */
export function subscriptionDetail(
  s: Pick<SubscriptionView, "status" | "canceledAt" | "currentPeriodEndsAt">,
): { text: string; warn: boolean } | null {
  if (!s.currentPeriodEndsAt) return null;
  const end = formatDateShort(s.currentPeriodEndsAt);
  if (s.status === "active" && !s.canceledAt) return { text: `Renews ${end}`, warn: false };
  if (s.status === "active" && s.canceledAt) return { text: `Cancels on ${end}`, warn: true };
  if (s.status === "canceled") return { text: `Expired ${end}`, warn: false };
  return null;
}
