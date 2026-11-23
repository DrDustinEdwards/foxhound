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
