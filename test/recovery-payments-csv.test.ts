import { describe, expect, it } from "vitest";

import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import type { FailedPaymentRow } from "~/lib/recovery/queries.server";

// TASK-foxhound-recovery-surface-parity.md Phase 3: the CSV export builder,
// pure and DB-free.

function fakeRow(overrides: Partial<FailedPaymentRow> = {}): FailedPaymentRow {
  return {
    id: "dfp_1",
    stripeEventId: "evt_1",
    stripeInvoiceId: "inv_1",
    stripeCustomerId: "cus_1",
    customerEmail: "jordan@example.com",
    customerName: "Jordan Lee",
    amountCents: 4999,
    currency: "usd",
    declineCode: "insufficient_funds",
    declineCategory: "soft",
    planName: "Growth",
    customerSince: null,
    status: "active",
    detectedAt: new Date("2026-07-01T00:00:00.000Z"),
    resolvedAt: null,
    notes: null,
    cardBrand: null,
    cardCountry: null,
    cardFunding: null,
    customerLtvCents: null,
    stripeProductId: null,
    stripePriceId: null,
    customerTimezone: null,
    deletedAt: null,
    processor: null,
    processorPaymentId: null,
    processorCustomerId: null,
    subscriptionStart: null,
    subscriptionId: null,
    timeOfFailureHour: null,
    failureDayOfWeek: null,
    priorFailureCount: null,
    isFirstFailureEver: null,
    merchantMrrRange: null,
    merchantIndustry: null,
    planInterval: null,
    amountTier: null,
    abTestGroup: null,
    customerAgeDays: null,
    accountId: "acc_1",
    stripeConnectionId: null,
    isRenewalNoise: false,
    refundSignalAt: null,
    ...overrides,
  };
}

describe("buildPaymentsCsv", () => {
  it("writes a header row plus one row per payment", () => {
    const csv = buildPaymentsCsv([fakeRow()]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "Customer,Email,Plan,Amount,Currency,Decline category,Decline code,Status,Detected at",
    );
    expect(lines[1]).toBe(
      "Jordan Lee,jordan@example.com,Growth,49.99,usd,Soft decline,insufficient_funds,In recovery,2026-07-01T00:00:00.000Z",
    );
  });

  it("quotes a field containing a comma", () => {
    const csv = buildPaymentsCsv([fakeRow({ customerName: "Acme, Inc." })]);
    expect(csv).toContain('"Acme, Inc."');
  });

  it("doubles an embedded quote and wraps the field in quotes", () => {
    const csv = buildPaymentsCsv([fakeRow({ planName: 'The "Pro" plan' })]);
    expect(csv).toContain('"The ""Pro"" plan"');
  });

  it("falls back to empty strings for null customer name / plan / decline code", () => {
    const csv = buildPaymentsCsv([fakeRow({ customerName: null, planName: null, declineCode: null })]);
    const dataLine = csv.trim().split("\r\n")[1];
    expect(dataLine.startsWith(",jordan@example.com,,")).toBe(true);
  });

  it("falls back to the raw category/status when no label exists", () => {
    const csv = buildPaymentsCsv([fakeRow({ declineCategory: "not_a_real_category" as never, status: "weird" })]);
    const dataLine = csv.trim().split("\r\n")[1];
    expect(dataLine).toContain("not_a_real_category");
    expect(dataLine).toContain("weird");
  });

  it("returns just the header for an empty payment list", () => {
    const csv = buildPaymentsCsv([]);
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});
