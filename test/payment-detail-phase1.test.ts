import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import { estimateCustomerLtvCents } from "~/lib/recovery/queries.server";

// S7 Phase 1 closing build, rulings 253, 255 and 256.
//
// 256 refuted 254's premise: Foxhound already ships sanitize-html and
// app/lib/recovery/email-preview.server.ts already carries legacy's exact
// allowlist, server-side. So the expander wires to that helper and NO
// dependency was added. These assertions pin the sanitization actually
// reaching the response, not merely the helper existing.
//
// 253's column guard: failed_payments.customer_ltv_cents holds a DIFFERENT
// value and must never be rendered under legacy's "est. LTV" label. The LTV is
// computed fresh, and legacy's own gate is two recovered payments, not one.

const ROUTE = readFileSync("app/routes/app/recovery/payments/detail.tsx", "utf8");
const QUERIES = readFileSync("app/lib/recovery/queries.server.ts", "utf8");

describe("expander sanitization: hostile aiBodyHtml is neutralized", () => {
  it("strips a script tag entirely", () => {
    const out = sanitizeEmailPreviewHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain("script");
    expect(out).toContain("<p>hi</p>");
  });

  it("strips an inline event handler while keeping the element's text", () => {
    const out = sanitizeEmailPreviewHtml('<p onclick="steal()">click</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("click");
  });

  it("strips a javascript: href but keeps a safe one", () => {
    expect(sanitizeEmailPreviewHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
    expect(sanitizeEmailPreviewHtml('<a href="https://example.com">x</a>')).toContain("https://example.com");
  });

  it("drops an img payload, which is not on legacy's allowlist", () => {
    expect(sanitizeEmailPreviewHtml('<img src=x onerror="alert(1)">')).not.toContain("img");
  });

  it("the ROUTE sanitizes in the loader, before the body is in the response", () => {
    // The whole point of 256: never render step.aiBodyHtml directly.
    expect(ROUTE).toContain("sanitizeEmailPreviewHtml(step.aiBodyHtml)");
    expect(ROUTE).toContain("__html: step.previewHtml");
    expect(ROUTE).not.toContain("__html: step.aiBodyHtml");
  });
});

describe("LTV computed fresh, under 253's column guard", () => {
  it("averages and multiplies by twelve", () => {
    expect(estimateCustomerLtvCents([1000, 2000])).toBe(18000);
    expect(estimateCustomerLtvCents([1000, 2000, 3000])).toBe(24000);
  });

  it("returns null below legacy's own two-payment gate", () => {
    // Legacy writes `allCustomerPayments.length >= 2` and passes null below it,
    // rendering no subtext at all. One sample is not an average.
    expect(estimateCustomerLtvCents([])).toBeNull();
    expect(estimateCustomerLtvCents([5000])).toBeNull();
  });

  it("never reads customerLtvCents, which holds a different value", () => {
    expect(QUERIES).not.toMatch(/estimatedLtvCents:\s*\w*\.?customerLtvCents/);
    expect(ROUTE).not.toContain("customerLtvCents");
  });
});

describe("previous-failures query shape, per 253's spec", () => {
  it("scopes to the same customer, excludes this payment, orders newest first, caps at five", () => {
    expect(QUERIES).toContain("eq(failedPayments.stripeCustomerId, failedPayment.stripeCustomerId)");
    expect(QUERIES).toContain("ne(failedPayments.id, failedPaymentId)");
    expect(QUERIES).toContain("orderBy(desc(failedPayments.detectedAt))");
    expect(QUERIES).toContain("limit(5)");
  });

  it("stays account-scoped, as every read in this tree is", () => {
    expect(QUERIES).toContain("eq(failedPayments.accountId, accountId)");
  });

  it("the route renders the list under legacy's heading", () => {
    expect(ROUTE).toContain("Previous failures (");
  });
});

describe("notes textarea renders with an honest submit path", () => {
  it("renders the column value and legacy's placeholder", () => {
    expect(ROUTE).toContain("failedPayment.notes");
    expect(ROUTE).toContain("Add a note about this payment or customer...");
  });

  it("carries legacy's amber Save note button", () => {
    expect(ROUTE).toContain("Save note");
    expect(ROUTE).toContain("bg-amber");
  });

  it("posts the note intent, so the handler refuses it honestly rather than faking a save", () => {
    expect(ROUTE).toContain('value="note"');
    expect(ROUTE).toContain("MANUAL_ACTIONS_NOT_AVAILABLE_MESSAGE");
  });
});
