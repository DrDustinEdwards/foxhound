import type { BillingLineItemType } from "~/lib/constants";
import type { Tone } from "~/lib/recovery/labels";

// Human-readable labels + status tone for the billing evidence ledger (Phase 5
// slice 5d). Pure, mirrors app/lib/recovery/labels.ts and app/lib/disputes/labels.ts.

export const BILLING_LINE_ITEM_TYPE_LABELS: Record<BillingLineItemType, string> = {
  recovery_fee: "Recovery fee",
  dispute_fee: "Dispute fee",
  subscription: "Subscription",
  adjustment: "Adjustment",
};

export const BILLING_INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  paid: "Paid",
  payment_failed: "Payment failed",
  uncollectible: "Uncollectible",
  void: "Void",
  // Written by the charge-dispatch retry sweep when it stops chasing an invoice
  // (app/lib/billing/fee-retry.ts). Every consumer renders LABELS[status] ??
  // status, so without an entry a merchant saw the raw string "gave_up" on
  // /billing. "Not collected" says what happened without implying the merchant
  // did something wrong or that Foxhound will try again.
  gave_up: "Not collected",
};

/** Statuses that mean the invoice will never be collected. */
const FAILED_INVOICE_STATUSES = new Set(["payment_failed", "void", "uncollectible", "gave_up"]);

export function billingInvoiceStatusTone(status: string): Tone {
  if (status === "paid") return "success";
  if (FAILED_INVOICE_STATUSES.has(status)) return "failure";
  return "neutral";
}
