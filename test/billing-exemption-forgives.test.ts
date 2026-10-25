import { describe, expect, it, vi } from "vitest";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// A BILLING EXEMPTION FORGIVES, AS RECOVA'S DID (Dustin, 2026-10-25, decision
// card "Forgive, like Recova").
//
// Recova's monthly billing cron skipped exempt accounts and only ever billed
// the prior calendar month, so a fee that came due while an account was exempt
// was never billed. Foxhound checked billing_exempt only at run time and had no
// lower date bound, so every fee held during an exemption was billed at the
// first run after it ended. These run the real billable queries against a
// SQLite carrying the committed migrations, with the exemption toggled through
// the same money write the admin pages use.

const harness = vi.hoisted(() => ({ db: null as unknown, sqlite: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { getBillableDisputes, getBillableRecoveries } = await import("~/db/billable");
const { setBillingExempt } = await import("~/lib/admin/merchants.server");
const { listBillableRecoveredForRoi } = await import("~/lib/recovery/dashboard-queries.server");
const schema = await import("~/db/schema");

const ACCOUNT = "acct_exempt";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const day = (n: number) => new Date(T0 + n * DAY);
const ENV = { MONEY_WRITER: inMemoryMoneyWriter(() => harness.sqlite as never).binding } as unknown as Env;

async function seed() {
  const made = createInMemoryDb();
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  await made.db.insert(schema.accounts).values({ id: ACCOUNT, name: "Exempt Co", createdAt: day(0) });
  return made.db;
}

async function recovery(db: Awaited<ReturnType<typeof seed>>, id: string, recoveredDay: number) {
  await db.insert(schema.failedPayments).values({
    id: `fp_${id}`,
    accountId: ACCOUNT,
    stripeEventId: `evt_${id}`,
    stripeInvoiceId: `in_${id}`,
    stripeCustomerId: "cus_1",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: day(recoveredDay),
  });
  await db.insert(schema.recoveredPayments).values({
    id,
    failedPaymentId: `fp_${id}`,
    accountId: ACCOUNT,
    recoveredAt: day(recoveredDay),
    amountCents: 10_000,
    currency: "usd",
    recoveryMethod: "email",
    attributionKind: "email_engaged",
  });
}

async function wonDispute(db: Awaited<ReturnType<typeof seed>>, id: string, resolvedDay: number) {
  await db.insert(schema.disputes).values({
    id,
    accountId: ACCOUNT,
    stripeDisputeId: `dp_${id}`,
    stripeChargeId: `ch_${id}`,
    amountCents: 10_000,
    currency: "usd",
    reason: "fraudulent",
    status: "won",
    state: "resolved_won",
    createdAt: day(resolvedDay - 20),
    submittedAt: day(resolvedDay - 10),
    resolvedAt: day(resolvedDay),
    resolvedFeeCents: 2_000,
  });
  await db.insert(schema.disputeApprovals).values({
    id: `ap_${id}`,
    disputeId: id,
    accountId: ACCOUNT,
    evidenceVersionHash: "h",
    approvedAt: day(resolvedDay - 11),
  });
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("a billing exemption forgives the fees that came due while exempt", () => {
  it("never bills a recovery or dispute win from an exempt stretch once the exemption ends", async () => {
    const db = await seed();
    // Recovered before the exemption (day 40 to 70), matured inside it.
    await recovery(db, "rp_matured_while_exempt", 15);
    // Recovered inside the exemption; matures after it ends.
    await recovery(db, "rp_recovered_while_exempt", 60);
    // Recovered and matured after the exemption ends.
    await recovery(db, "rp_after", 80);
    await wonDispute(db, "dp_won_while_exempt", 50);
    await wonDispute(db, "dp_won_after", 90);

    // With no exemption it would be billable once matured.
    expect(ids(await getBillableRecoveries(db, ACCOUNT, day(46).getTime()))).toEqual(["rp_matured_while_exempt"]);

    expect(await setBillingExempt(ENV, ACCOUNT, true, day(40))).toBe(true);
    expect(await setBillingExempt(ENV, ACCOUNT, false, day(70))).toBe(true);

    const asOf = day(120).getTime();
    expect(ids(await getBillableRecoveries(db, ACCOUNT, asOf))).toEqual(["rp_after"]);
    expect(ids(await getBillableDisputes(db, ACCOUNT, asOf))).toEqual(["dp_won_after"]);
  });

  it("stays right when an exemption is turned on and off more than once", async () => {
    const db = await seed();
    await recovery(db, "rp_gap", 0); // matures day 30, between the two exemptions
    await recovery(db, "rp_second", 50); // recovered in the second exemption
    await wonDispute(db, "dp_first", 15); // won in the first exemption
    await wonDispute(db, "dp_gap", 35); // won between them

    expect(await setBillingExempt(ENV, ACCOUNT, true, day(10))).toBe(true);
    expect(await setBillingExempt(ENV, ACCOUNT, false, day(20))).toBe(true);
    // The gap's fees are billed in the gap, as Recova billed a month it was not exempt.
    expect(ids(await getBillableRecoveries(db, ACCOUNT, day(36).getTime()))).toEqual(["rp_gap"]);
    expect(ids(await getBillableDisputes(db, ACCOUNT, day(36).getTime()))).toEqual(["dp_gap"]);

    // A stale second "Set exempt" changes nothing and opens no second period.
    expect(await setBillingExempt(ENV, ACCOUNT, true, day(45))).toBe(true);
    expect(await setBillingExempt(ENV, ACCOUNT, true, day(46))).toBe(false);
    expect(await setBillingExempt(ENV, ACCOUNT, false, day(60))).toBe(true);
    expect(await setBillingExempt(ENV, ACCOUNT, false, day(61))).toBe(false);

    const periods = await db.select().from(schema.billingExemptionPeriods);
    expect(periods.map((p) => [p.startedAt.getTime(), p.endedAt?.getTime()])).toEqual([
      [day(10).getTime(), day(20).getTime()],
      [day(45).getTime(), day(60).getTime()],
    ]);
    // rp_gap was due from day 30 and the second exemption came while it was
    // still unbilled, so it is forgiven too; rp_second was earned while exempt.
    expect(ids(await getBillableRecoveries(db, ACCOUNT, day(120).getTime()))).toEqual([]);
    expect(ids(await getBillableDisputes(db, ACCOUNT, day(120).getTime()))).toEqual([]);
  });

  it("keeps a fee invoiced before a later exemption in the ROI widget, and drops one it forgave", async () => {
    const db = await seed();
    await recovery(db, "rp_invoiced", 0); // matures day 30, invoiced day 32
    await recovery(db, "rp_forgiven", 10); // matures day 40, inside the exemption
    await db.insert(schema.billingInvoices).values({
      id: "inv_1",
      accountId: ACCOUNT,
      currency: "usd",
      periodStart: day(0),
      periodEnd: day(31),
      idempotencyKey: "inv_1",
      createdAt: day(32),
    });
    await db.insert(schema.billingLineItems).values({
      id: "li_1",
      invoiceId: "inv_1",
      accountId: ACCOUNT,
      type: "recovery_fee",
      currency: "usd",
      amountCents: 2_000,
      feeCents: 2_000,
      recoveredPaymentId: "rp_invoiced",
      createdAt: day(32),
    });

    expect(await setBillingExempt(ENV, ACCOUNT, true, day(35))).toBe(true);
    const asOf = day(120).getTime();
    expect(ids(await getBillableRecoveries(db, ACCOUNT, asOf))).toEqual([]);
    const roi = await listBillableRecoveredForRoi(db, ACCOUNT, asOf, null);
    expect(roi).toEqual([{ amountCents: 10_000, currency: "usd" }]);
  });
});
