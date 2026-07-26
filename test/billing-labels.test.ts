import { describe, expect, it } from "vitest";

import {
  BILLING_INVOICE_STATUS_LABELS,
  billingInvoiceStatusTone,
} from "~/lib/billing/labels";
import { platformBillingStatus } from "~/lib/billing/platform-webhook";

// Every consumer of BILLING_INVOICE_STATUS_LABELS renders
// `LABELS[status] ?? status` (/billing, /billing/invoices/:id, and
// /admin/merchants/:id), so a status with no entry leaks its raw snake_case
// value onto a merchant-facing money surface. `gave_up` shipped that way with
// the charge-retry sweep (review LOW-2).

/** The Stripe platform events the reconciler maps onto our status column.
 *  Run through the real mapper rather than hand-copied, so a mapping change
 *  shows up here instead of silently drifting. */
const PLATFORM_EVENT_TYPES = [
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.marked_uncollectible",
  "invoice.voided",
];

/** Statuses written directly by billing code rather than by an event mapping,
 *  with their writers: runAccountBilling ("draft" on the committed ledger row,
 *  "finalized" via buildInvoiceStripeRefUpdate) and the charge-retry sweep
 *  ("finalized", "payment_failed", "gave_up" via buildChargeAttemptUpdate). */
const DIRECTLY_WRITTEN_STATUSES = ["draft", "finalized", "payment_failed", "gave_up"];

describe("every billing_invoices status a writer can produce has a label", () => {
  const fromEvents = PLATFORM_EVENT_TYPES.map((t) => platformBillingStatus(t)).filter(
    (s): s is string => s !== null,
  );
  const allStatuses = [...new Set([...fromEvents, ...DIRECTLY_WRITTEN_STATUSES])];

  it.each(allStatuses)("%s renders a human label, never the raw value", (status) => {
    const label = BILLING_INVOICE_STATUS_LABELS[status];
    expect(label).toBeDefined();
    expect(label).not.toBe(status);
  });

  it("gave_up specifically, because it is the one that shipped unlabelled", () => {
    expect(BILLING_INVOICE_STATUS_LABELS.gave_up).toBe("Not collected");
  });
});

describe("billingInvoiceStatusTone", () => {
  it("treats gave_up as a failure, like its terminal siblings", () => {
    // It was neutral, which read as "nothing to see here" on an invoice
    // Foxhound had stopped trying to collect.
    expect(billingInvoiceStatusTone("gave_up")).toBe("failure");
    expect(billingInvoiceStatusTone("payment_failed")).toBe("failure");
    expect(billingInvoiceStatusTone("void")).toBe("failure");
    expect(billingInvoiceStatusTone("uncollectible")).toBe("failure");
  });

  it("keeps paid successful and in-flight states neutral", () => {
    expect(billingInvoiceStatusTone("paid")).toBe("success");
    expect(billingInvoiceStatusTone("draft")).toBe("neutral");
    expect(billingInvoiceStatusTone("finalized")).toBe("neutral");
  });
});
