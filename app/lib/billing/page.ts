import { humanize } from "@drdustinedwards/site-helpers/text";
import { formatDate } from "capsomer/behavior/time";
import { DISPUTE_FEE_BPS, RECOVERY_FEE_BPS } from "~/lib/constants";

// What /billing shows, in the shapes its sections render. Pure and client-safe:
// the rows themselves are built on the server (page.server.ts) and these are
// the types and the small formatting rules the sections share.

const BPS_PER_PERCENT = 100;

export const RECOVERY_FEE_PERCENT = RECOVERY_FEE_BPS / BPS_PER_PERCENT;
export const DISPUTE_FEE_PERCENT = DISPUTE_FEE_BPS / BPS_PER_PERCENT;

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... */
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

export function formatLongDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A billing status's tone, in Capsomer's status words: paid is ok, a failed or
 * abandoned collection is critical, everything else is a plain label.
 */
export type FeeStatusTone = "ok" | "crit" | "neutral";

export interface RecoveryHistoryRow {
  invoiceId: string;
  periodLabel: string;
  currency: string;
  recoveredCents: number;
  feeCents: number;
  /**
   * Credit notes issued since against these fees, as a positive amount; 0 when
   * none.
   */
  creditedCents: number;
  statusLabel: string;
  statusTone: FeeStatusTone;
  invoiceUrl: string | null;
  stripeInvoiceId: string | null;
}

export interface DisputeFeeRow {
  key: string;
  disputeId: string;
  currency: string;
  disputeAmountCents: number;
  feeCents: number;
  /** True when the $500 cap held the fee below the percentage. */
  feeCapped: boolean;
  /**
   * Credit notes issued since against this fee, as a positive amount; 0 when
   * none.
   */
  creditedCents: number;
  statusLabel: string;
  statusTone: FeeStatusTone;
  invoiceUrl: string | null;
  stripeInvoiceId: string | null;
}

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

/** A readable status, never the raw column value. */
export function subscriptionStatusLabel(status: string): string {
  return SUBSCRIPTION_STATUS_LABELS[status] ?? humanize(status);
}

export function subscriptionStatusTone(status: string): FeeStatusTone {
  if (status === "active") return "ok";
  if (status === "past_due") return "crit";
  return "neutral";
}

const PRODUCT_DISPLAY_NAMES: Record<string, string> = {
  intelligence: "Intelligence",
  disputes: "Disputes",
};

export function productDisplayName(slug: string): string {
  return PRODUCT_DISPLAY_NAMES[slug] ?? humanize(slug);
}

export function subscriptionDetail(
  s: Pick<SubscriptionView, "status" | "canceledAt" | "currentPeriodEndsAt">,
): { text: string; warn: boolean } | null {
  if (!s.currentPeriodEndsAt) return null;
  const end = formatDate(s.currentPeriodEndsAt, { style: "medium" }) ?? "";
  if (s.status === "active" && !s.canceledAt) return { text: `Renews ${end}`, warn: false };
  if (s.status === "active" && s.canceledAt) return { text: `Cancels on ${end}`, warn: true };
  if (s.status === "canceled") return { text: `Expired ${end}`, warn: false };
  return null;
}
