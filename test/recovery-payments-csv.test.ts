import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import { countStepsForFailedPayments, type FailedPaymentRow } from "~/lib/recovery/queries.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

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
    networkAdviceCode: null,
    networkDeclineCode: null,
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

const RECOVA_HEADER =
  "Customer Name,Email,Plan,Amount,Currency,Decline Category,Decline Code,Status,Steps Executed,Total Steps,Detected At,Resolved At,Notes";

describe("buildPaymentsCsv", () => {
  it("writes Recova's 13 columns in Recova's order (lib/csv.ts PAYMENT_CSV_HEADERS)", () => {
    const csv = buildPaymentsCsv([fakeRow()]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(RECOVA_HEADER);
    expect(lines[0].split(",")).toHaveLength(13);
  });

  it("writes 0 and 0 for a payment with no steps, and blanks for no resolution or notes", () => {
    const csv = buildPaymentsCsv([fakeRow()]);
    expect(csv.split("\n")[1]).toBe(
      "Jordan Lee,jordan@example.com,Growth,49.99,USD,soft,insufficient_funds,active,0,0,2026-07-01T00:00:00.000Z,,",
    );
  });

  it("doubles an embedded quote and wraps the field in quotes", () => {
    const csv = buildPaymentsCsv([fakeRow({ planName: 'The "Pro" plan' })]);
    expect(csv).toContain('"The ""Pro"" plan"');
  });

  it("falls back to empty strings for null customer name / plan / decline code", () => {
    const csv = buildPaymentsCsv([fakeRow({ customerName: null, planName: null, declineCode: null })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine.startsWith(",jordan@example.com,,")).toBe(true);
  });
});

describe("buildPaymentsCsv: spreadsheet-formula safety", () => {

  it("a CR-led cell is both neutralised and quoted", () => {
    const csv = buildPaymentsCsv([fakeRow({ notes: "\r=1+1" })]);
    expect(csv).toContain(`"'\r=1+1"`);
  });
});

describe("countStepsForFailedPayments", () => {
  function seed() {
    const { sqlite, db } = createInMemoryDb();
    runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Mine" }));
    runStatement(sqlite, db.insert(accounts).values({ id: "acc_2", name: "Theirs" }));
    const payment = (id: string, accountId: string) =>
      runStatement(
        sqlite,
        db.insert(failedPayments).values({
          id,
          accountId,
          stripeEventId: `evt_${id}`,
          stripeInvoiceId: `in_${id}`,
          stripeCustomerId: `cus_${id}`,
          customerEmail: "customer@example.com",
          amountCents: 4999,
          currency: "usd",
          declineCategory: "soft",
          status: "active",
          detectedAt: new Date("2026-07-01T00:00:00.000Z"),
        }),
      );
    let n = 0;
    const step = (failedPaymentId: string, accountId: string, executed: boolean, deleted = false) =>
      runStatement(
        sqlite,
        db.insert(recoverySteps).values({
          id: `st_${n++}`,
          failedPaymentId,
          accountId,
          stepType: "email",
          scheduledAt: new Date("2026-07-02T00:00:00.000Z"),
          executedAt: executed ? new Date("2026-07-02T00:00:00.000Z") : null,
          deletedAt: deleted ? new Date("2026-07-05T00:00:00.000Z") : null,
        }),
      );
    payment("fp_a", "acc_1");
    payment("fp_b", "acc_1");
    payment("fp_x", "acc_2");
    step("fp_a", "acc_1", true);
    step("fp_a", "acc_1", true);
    step("fp_a", "acc_1", false);
    step("fp_a", "acc_1", true, true);
    step("fp_x", "acc_2", true);
    return db;
  }

  it("counts executed and total steps per payment, skipping deleted steps", async () => {
    const counts = await countStepsForFailedPayments(seed(), "acc_1", ["fp_a", "fp_b"]);
    expect(counts.get("fp_a")).toEqual({ executed: 2, total: 3 });
    expect(counts.get("fp_b")).toBeUndefined();
  });
});
