import {
  DAY_MS,
  FEE_INVOICE_MAX_RETRY_AGE_DAYS,
  FEE_INVOICE_MAX_RETRY_ATTEMPTS,
} from "~/lib/constants";

// The fee-invoice collection state machine, ported from legacy's
// lib/dispute-fees.ts decideFeeRetryAction (parity ruling 11). Pure: it decides,
// it never calls Stripe or writes.
//
// Why Foxhound needs it at all. runAccountBilling commits the billing_invoices
// row and its line items as one atomic batch, THEN attempts the Stripe charge as
// a separate follow-up. A failure in that second half leaves a committed ledger
// row whose money never moved, and the invoice-level idempotency key means the
// next monthly run cannot simply re-bill the period: the key collides, the batch
// rolls back, and the invoice is stranded permanently. Nothing retried it,
// because nothing existed to do the retrying.
//
// Stripe also does not auto-retry a one-off `charge_automatically` invoice, so
// even a cleanly finalized invoice whose charge fails just sits there. Legacy hit
// exactly this and solved it with the machine below.
//
// THE CAPS ARE NOT LEGACY'S NUMBERS, deliberately. Legacy ran this hourly with
// 4 attempts / 14 days. Foxhound runs it monthly, so a 14-day age cap would fire
// before the first retry and the `pay` branch would be unreachable. The age cap
// is rescaled to 90 days and is what actually ends the retries: at the monthly
// cadence an invoice ages past 90 days after two or three retries, before the
// 4-attempt ceiling is reached. The attempt cap only binds if runs come closer
// together than monthly. See FEE_INVOICE_MAX_RETRY_AGE_DAYS in
// app/lib/constants.ts for the run-by-run count.

type FeeRetryAction = "pay" | "sync_paid" | "give_up";

export interface FeeRetryDecision {
  action: FeeRetryAction;
  /** Stable machine-readable reason, logged with the run so a give_up is
   *  attributable to a specific branch rather than "it stopped". */
  reason: string;
}

export interface FeeRetryInput {
  /** The LIVE Stripe invoice status, not our billing_invoices.status. The
   *  decision has to be made against what Stripe currently believes, which is
   *  also how a locally-stale row gets corrected (see sync_paid). */
  invoiceStatus: string;
  /** Charge attempts made so far for this invoice (billing_invoices.charge_attempt_count). */
  attemptCount: number;
  /** When the Stripe invoice was created, in ms. */
  invoiceCreatedMs: number;
  nowMs: number;
  maxAttempts?: number;
  maxAgeDays?: number;
}

/**
 * Decide what to do with one unpaid fee invoice. Branch order is load-bearing
 * and matches legacy:
 *
 *   paid                  -> sync_paid  (Stripe collected; our row is stale)
 *   void | uncollectible  -> give_up    (terminal at Stripe, never re-charge)
 *   age  > maxAgeDays     -> give_up
 *   attempts >= maxAttempts -> give_up
 *   otherwise             -> pay
 *
 * The two terminal-status checks come FIRST, before either cap, because a
 * voided invoice that is also over-age must report why it is really dead. Any
 * unrecognized status falls through to the caps and then to `pay`, which is the
 * safe direction here: `pay` on an already-paid Stripe invoice is a no-op at
 * Stripe, whereas failing closed would strand the invoice this exists to rescue.
 */
export function decideFeeRetryAction(input: FeeRetryInput): FeeRetryDecision {
  const {
    invoiceStatus,
    attemptCount,
    invoiceCreatedMs,
    nowMs,
    maxAttempts = FEE_INVOICE_MAX_RETRY_ATTEMPTS,
    maxAgeDays = FEE_INVOICE_MAX_RETRY_AGE_DAYS,
  } = input;

  if (invoiceStatus === "paid") {
    return { action: "sync_paid", reason: "stripe_status_paid" };
  }
  if (invoiceStatus === "void" || invoiceStatus === "uncollectible") {
    return { action: "give_up", reason: `stripe_status_${invoiceStatus}` };
  }

  const ageDays = (nowMs - invoiceCreatedMs) / DAY_MS;
  if (ageDays > maxAgeDays) {
    return { action: "give_up", reason: "max_age_exceeded" };
  }
  if (attemptCount >= maxAttempts) {
    return { action: "give_up", reason: "max_attempts_reached" };
  }

  return { action: "pay", reason: "retry" };
}

/** Our billing_invoices.status for a Stripe status, when the sweep syncs a row
 *  it found already settled. Only the settled states appear here; an invoice
 *  still open keeps whatever status the retry path gives it. */
export function billingStatusForSettledStripeStatus(stripeStatus: string): string | null {
  if (stripeStatus === "paid") return "paid";
  if (stripeStatus === "void") return "void";
  if (stripeStatus === "uncollectible") return "uncollectible";
  return null;
}
