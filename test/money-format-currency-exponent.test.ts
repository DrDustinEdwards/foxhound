import { describe, expect, it } from "vitest";

import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import type { FailedPaymentRow } from "~/lib/recovery/queries.server";

// Stripe amounts are in the currency minor unit; zero-decimal currencies are whole units.

describe("the payments CSV export writes the amount in whole units of its currency", () => {
  it("a 5,000 yen payment exports as 5000, not 50.00", () => {
    const row = {
      id: "fp_1",
      customerName: "Sample Customer",
      customerEmail: "customer@example.com",
      planName: null,
      amountCents: 5000,
      currency: "jpy",
      declineCategory: "soft",
      declineCode: null,
      status: "active",
      detectedAt: new Date("2026-10-01T00:00:00.000Z"),
      resolvedAt: null,
    } as unknown as FailedPaymentRow;
    const line = buildPaymentsCsv([row]).split("\r\n")[1];
    expect(line).toContain(",5000,JPY,");
  });
});
