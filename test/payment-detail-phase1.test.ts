import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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

  it("the ROUTE sanitizes in the loader, before the body is in the response", () => {
    // The whole point of 256: never render step.aiBodyHtml directly.
    // J76: the raw body is taken off the step before it is returned, so only
    // the sanitized preview is in the response.
    expect(ROUTE).toContain(".map(({ aiBodyHtml, ...step }) => ({");
    expect(ROUTE).toContain("previewHtml: aiBodyHtml ? sanitizeEmailPreviewHtml(aiBodyHtml) : null,");
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
});

describe("previous-failures query shape, per 253's spec", () => {

  it("stays account-scoped, as every read in this tree is", () => {
    expect(QUERIES).toContain("eq(failedPayments.accountId, accountId)");
  });
});
