import { describe, expect, it } from "vitest";

import { formatMoney } from "~/lib/money-format";
import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import type { FailedPaymentRow } from "~/lib/recovery/queries.server";

// A TRUTHFULNESS FIX (RULES.md 1.2). Stripe sends every amount in the
// currency's minor unit, and the minor unit is not always a hundredth: for
// Stripe's zero-decimal currencies the amount IS the whole unit, and for its
// three-decimal currencies it is a thousandth (https://docs.stripe.com/currencies).
// formatMoney, ported from Recova, divided everything by 100, so a 5,000 yen
// dispute read as 50 yen. Recova has the same defect; the legacy figure was a
// lie, not a spec.

describe("formatMoney reads the amount in the currency's own minor unit", () => {
  it("a zero-decimal currency is not divided: 5000 JPY is 5,000 yen", () => {
    expect(formatMoney(5000, "jpy")).toBe("¥5,000");
  });

  it("a three-decimal currency is divided by 1,000 and keeps three places", () => {
    expect(formatMoney(12345, "kwd")).toBe("KWD\u00a012.345");
  });

  it("UGX is sent as a two-decimal value (Stripe's special case), so it is still divided by 100", () => {
    expect(formatMoney(500, "ugx")).toBe("UGX\u00a05");
  });

  it("USD is unchanged", () => {
    expect(formatMoney(123456, "usd")).toBe("$1,234.56");
  });

  it("a code Intl refuses falls back to the figure and the code, as Recova did, instead of throwing", () => {
    expect(() => formatMoney(5000, "us")).not.toThrow();
    expect(formatMoney(5000, "us")).toBe("50.00 US");
  });
});

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
    const line = buildPaymentsCsv([row]).split("\n")[1];
    expect(line).toContain(",5000,JPY,");
  });
});
