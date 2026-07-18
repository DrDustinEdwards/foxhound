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
};

export function billingInvoiceStatusTone(status: string): Tone {
  if (status === "paid") return "success";
  if (status === "payment_failed" || status === "void" || status === "uncollectible") return "failure";
  return "neutral";
}
