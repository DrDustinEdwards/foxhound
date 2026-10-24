import { describe, expect, it } from "vitest";

import {
  billingInvoiceStatusTone,
} from "~/lib/billing/labels";

// Every consumer of BILLING_INVOICE_STATUS_LABELS renders
// `LABELS[status] ?? status` (/billing, /billing/invoices/:id, and
// /admin/merchants/:id), so a status with no entry leaks its raw snake_case
// value onto a merchant-facing money surface. `gave_up` shipped that way with
// the charge-retry sweep (review LOW-2).



describe("billingInvoiceStatusTone", () => {

  it("keeps paid successful and in-flight states neutral", () => {
    expect(billingInvoiceStatusTone("paid")).toBe("success");
    expect(billingInvoiceStatusTone("draft")).toBe("neutral");
    expect(billingInvoiceStatusTone("finalized")).toBe("neutral");
  });
});
