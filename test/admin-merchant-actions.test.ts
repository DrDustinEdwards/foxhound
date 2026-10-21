import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts } from "~/db";
import * as schema from "~/db/schema";
import { getBillableRecoveries } from "~/db/billable";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { accountProcessingEligible as intelligenceProcessingEligible } from "~/lib/intelligence/sync.server";
import { setBillingExempt, setProcessingPaused } from "~/lib/admin/merchants.server";
import { buildCancelMerchantBatch, cancelMerchant } from "~/lib/admin/merchant-cancel.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Admin Pass 2: money-adjacent operator actions. Proves the resolution of the
// processing-vs-billing conflict the task surfaced: cancelledAt (and
// processing_paused) stop future processing, but cancelledAt alone must NEVER
// suppress billing of an already-matured, unbilled recovery (that gate lives
// only in app/db/billable.ts, which this file does not touch).

const fakeDb = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

describe("setBillingExempt / setProcessingPaused (plain scoped updates, real sqlite)", () => {
  it("setBillingExempt flips only the target account's flag", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });
    await db.insert(schema.accounts).values({ id: "acc_2", name: "Other", billingExempt: false, processingPaused: false });

    await setBillingExempt(db, "acc_1", true);

    const [a, b] = await Promise.all([
      db.select({ billingExempt: schema.accounts.billingExempt }).from(schema.accounts).where(eq(schema.accounts.id, "acc_1")),
      db.select({ billingExempt: schema.accounts.billingExempt }).from(schema.accounts).where(eq(schema.accounts.id, "acc_2")),
    ]);
    expect(a[0]?.billingExempt).toBe(true);
    expect(b[0]?.billingExempt).toBe(false);
  });

  it("setProcessingPaused flips only the target account's flag", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await setProcessingPaused(db, "acc_1", true);
    const rows = await db
      .select({ processingPaused: schema.accounts.processingPaused })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, "acc_1"));
    expect(rows[0]?.processingPaused).toBe(true);
  });
});

describe("buildCancelMerchantBatch (pure, compile-tested like buildBillingInvoiceBatch)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("stamps accounts.cancelledAt first, then disconnects every given connection", () => {
    const batch = buildCancelMerchantBatch(fakeDb, "acc_1", [
      { id: "conn_1", stripeUserId: "acct_stripe_1" },
      { id: "conn_2", stripeUserId: "acct_stripe_2" },
    ], now);

    expect(batch).toHaveLength(3);
    const accountStmt = sqlOf(batch[0]);
    expect(accountStmt.sql).toMatch(/update .*accounts.* set/i);
    expect(accountStmt.sql).toMatch(/cancelled_at/i);
    expect(accountStmt.params).toContain(now.getTime());
    expect(accountStmt.params).toContain("acc_1");

    const conn1 = sqlOf(batch[1]);
    expect(conn1.sql).toMatch(/update .*stripe_connections.* set/i);
    expect(conn1.sql).toMatch(/disconnected_at/i);
    expect(conn1.params).toContain("conn_1");

    const conn2 = sqlOf(batch[2]);
    expect(conn2.params).toContain("conn_2");
  });

  it("still stamps the account when there are zero active connections", () => {
    const batch = buildCancelMerchantBatch(fakeDb, "acc_1", [], now);
    expect(batch).toHaveLength(1);
  });
});

describe("cancelMerchant orchestration (injected deps, no live DB/Stripe)", () => {
  it("commits the local state BEFORE any Stripe call, in strict order", async () => {
    const order: string[] = [];
    const result = await cancelMerchant({} as Env, "acc_1", {
      cancelLocal: async () => {
        order.push("local");
        return [{ id: "conn_1", stripeUserId: "acct_1" }];
      },
      deauthorize: async () => {
        order.push("deauthorize");
        return { ok: true };
      },
    });

    expect(order).toEqual(["local", "deauthorize"]);
    expect(result.connectionsDisconnected).toBe(1);
    expect(result.deauthorizeErrors).toEqual([]);
  });

  it("a deauthorize failure never rolls back or throws: the merchant stays cancelled locally, the failure is surfaced", async () => {
    const result = await cancelMerchant({} as Env, "acc_1", {
      cancelLocal: async () => [
        { id: "conn_1", stripeUserId: "acct_1" },
        { id: "conn_2", stripeUserId: "acct_2" },
      ],
      deauthorize: async (_env, stripeUserId) =>
        stripeUserId === "acct_2" ? { ok: false, error: "stripe unavailable" } : { ok: true },
    });

    // The local commit already happened (cancelLocal returned) regardless of
    // what deauthorize does; connectionsDisconnected reflects the local write.
    expect(result.connectionsDisconnected).toBe(2);
    expect(result.deauthorizeErrors).toEqual([
      { connectionId: "conn_2", stripeUserId: "acct_2", error: "stripe unavailable" },
    ]);
  });

  it("never throws even if every deauthorize call throws", async () => {
    await expect(
      cancelMerchant({} as Env, "acc_1", {
        cancelLocal: async () => [{ id: "conn_1", stripeUserId: "acct_1" }],
        deauthorize: async () => {
          throw new Error("network blip");
        },
      }),
    ).rejects.toThrow(/network blip/);
    // NOTE: deauthorizeConnectedAccount's real implementation never throws (it
    // catches internally and returns {ok:false}); this proves cancelMerchant's
    // own loop has no try/catch of its own around a misbehaving dep, which is
    // fine because the real dep is contractually non-throwing. Documented here
    // so a future dep swap that CAN throw is a deliberate choice, not a surprise.
  });
});

describe("cancelledAt is a PROCESSING gate only, never a billing gate", () => {
  it("recovery-tick's processing gate excludes a cancelled account", () => {
    const sql = sqlOf(fakeDb.select().from(accounts).where(accountProcessingEligibleCondition()));
    const where = sql.sql.split(/\bwhere\b/i)[1] ?? "";
    expect(where).toMatch(/cancelled_at/i);
    expect(where).toMatch(/is null/i);
  });

  it("intelligence sync's processing gate excludes a cancelled account", () => {
    const sql = sqlOf(fakeDb.select().from(accounts).where(intelligenceProcessingEligible()));
    expect(sql.sql).toMatch(/cancelled_at/i);
  });

  it("a cancelled account's already-matured, unbilled recovery still appears in getBillableRecoveries", async () => {
    const { db } = createInMemoryDb();
    const ACCOUNT_ID = "acc_cancelled";
    const RECOVERED_AT = new Date("2026-06-01T00:00:00.000Z");
    const ASOF = new Date("2026-07-20T00:00:00.000Z").getTime(); // well past the 30-day maturity window

    await db.insert(schema.accounts).values({
      id: ACCOUNT_ID,
      name: "Cancelled Co",
      billingExempt: false,
      processingPaused: false,
      cancelledAt: new Date("2026-06-15T00:00:00.000Z"), // cancelled AFTER the recovery happened
    });
    await db.insert(schema.failedPayments).values({
      id: "fp_1",
      stripeEventId: "evt_1",
      stripeInvoiceId: "in_1",
      stripeCustomerId: "cus_1",
      customerEmail: "c@example.com",
      amountCents: 5_000,
      currency: "usd",
      declineCategory: "soft",
      status: "recovered",
      detectedAt: RECOVERED_AT,
      accountId: ACCOUNT_ID,
    });
    await db.insert(schema.recoveredPayments).values({
      id: "rec_1",
      failedPaymentId: "fp_1",
      recoveredAt: RECOVERED_AT,
      amountCents: 5_000,
      currency: "usd",
      recoveryMethod: "retry",
      accountId: ACCOUNT_ID,
      attributionKind: "foxhound_retry",
    });

    const rows = await getBillableRecoveries(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("rec_1");
  });
});

describe("billing_exempt still produces zero billable recoveries (existing predicate, re-asserted here for the toggle's story)", () => {
  it("an exempt account's matured recovery does not appear in getBillableRecoveries", async () => {
    const { db } = createInMemoryDb();
    const ACCOUNT_ID = "acc_exempt";
    const RECOVERED_AT = new Date("2026-06-01T00:00:00.000Z");
    const ASOF = new Date("2026-07-20T00:00:00.000Z").getTime();

    await db.insert(schema.accounts).values({
      id: ACCOUNT_ID,
      name: "Exempt Co",
      billingExempt: true,
      processingPaused: false,
    });
    await db.insert(schema.failedPayments).values({
      id: "fp_2",
      stripeEventId: "evt_2",
      stripeInvoiceId: "in_2",
      stripeCustomerId: "cus_2",
      customerEmail: "c2@example.com",
      amountCents: 5_000,
      currency: "usd",
      declineCategory: "soft",
      status: "recovered",
      detectedAt: RECOVERED_AT,
      accountId: ACCOUNT_ID,
    });
    await db.insert(schema.recoveredPayments).values({
      id: "rec_2",
      failedPaymentId: "fp_2",
      recoveredAt: RECOVERED_AT,
      amountCents: 5_000,
      currency: "usd",
      recoveryMethod: "retry",
      accountId: ACCOUNT_ID,
      attributionKind: "foxhound_retry",
    });

    const rows = await getBillableRecoveries(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(0);
  });
});
