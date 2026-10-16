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
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(RECOVA_HEADER);
    expect(lines[0].split(",")).toHaveLength(13);
  });

  it("fills each column from Foxhound's own row, steps from the step counts", () => {
    const csv = buildPaymentsCsv(
      [
        fakeRow({
          status: "recovered",
          resolvedAt: new Date("2026-07-03T12:00:00.000Z"),
          notes: "Called the customer",
        }),
      ],
      new Map([["dfp_1", { executed: 2, total: 3 }]]),
    );
    expect(csv.trim().split("\r\n")[1]).toBe(
      "Jordan Lee,jordan@example.com,Growth,49.99,USD,Soft decline,insufficient_funds,Recovered,2,3,2026-07-01T00:00:00.000Z,2026-07-03T12:00:00.000Z,Called the customer",
    );
  });

  it("writes 0 and 0 for a payment with no steps, and blanks for no resolution or notes", () => {
    const csv = buildPaymentsCsv([fakeRow()]);
    expect(csv.trim().split("\r\n")[1]).toBe(
      "Jordan Lee,jordan@example.com,Growth,49.99,USD,Soft decline,insufficient_funds,Active,0,0,2026-07-01T00:00:00.000Z,,",
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

  it("quotes a field containing a line feed or a carriage return", () => {
    const csv = buildPaymentsCsv([fakeRow({ notes: "line one\nline two" })]);
    expect(csv).toContain('"line one\nline two"');
    const cr = buildPaymentsCsv([fakeRow({ notes: "line one\rline two" })]);
    expect(cr).toContain('"line one\rline two"');
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

describe("buildPaymentsCsv: spreadsheet-formula safety", () => {
  // A customer name, plan or note comes from Stripe or the merchant and can
  // start with a formula trigger; a spreadsheet would run it on open.
  it.each([
    ["=HYPERLINK(\"http://example.com\")", "'=HYPERLINK(\"\"http://example.com\"\")"],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["\tleading tab", "'\tleading tab"],
    ["\rleading cr", "'\rleading cr"],
  ])("neutralises a cell starting with a trigger: %j", (name, expected) => {
    const csv = buildPaymentsCsv([fakeRow({ customerName: name })]);
    const dataLine = csv.slice(csv.indexOf("\r\n") + 2);
    expect(dataLine.startsWith(expected) || dataLine.startsWith(`"${expected}"`)).toBe(true);
    expect(dataLine.startsWith(name)).toBe(false);
  });

  it("neutralises every column, not only the name (email, plan, decline code, notes)", () => {
    const csv = buildPaymentsCsv([
      fakeRow({ customerEmail: "=a@example.com", planName: "+Plan", declineCode: "-x", notes: "@note" }),
    ]);
    const cells = csv.trim().split("\r\n")[1].split(",");
    expect(cells[1]).toBe("'=a@example.com");
    expect(cells[2]).toBe("'+Plan");
    expect(cells[6]).toBe("'-x");
    expect(cells[12]).toBe("'@note");
  });

  it("a CR-led cell is both neutralised and quoted", () => {
    const csv = buildPaymentsCsv([fakeRow({ notes: "\r=1+1" })]);
    expect(csv).toContain(`"'\r=1+1"`);
  });

  it("leaves an ordinary cell, a mid-cell trigger and the amount untouched", () => {
    const csv = buildPaymentsCsv([fakeRow({ customerName: "Jo = Lee", planName: "Pro-Plus" })]);
    const cells = csv.trim().split("\r\n")[1].split(",");
    expect(cells[0]).toBe("Jo = Lee");
    expect(cells[2]).toBe("Pro-Plus");
    expect(cells[3]).toBe("49.99");
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

  it("stays scoped to the account: another account's payment id counts nothing", async () => {
    const counts = await countStepsForFailedPayments(seed(), "acc_1", ["fp_a", "fp_x"]);
    expect(counts.get("fp_x")).toBeUndefined();
  });

  it("reads more ids than one D1 statement can bind (the All page size)", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `fp_none_${i}`).concat("fp_a");
    const counts = await countStepsForFailedPayments(seed(), "acc_1", ids);
    expect(counts.get("fp_a")).toEqual({ executed: 2, total: 3 });
  });
});
