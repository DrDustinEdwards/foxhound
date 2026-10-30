import { describe, expect, it } from "vitest";

import {
  accounts,
  adminAuditLog,
  billingInvoices,
  disputes,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { type AdminOverview } from "~/lib/admin/overview.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J44: /admin's Overview on the family admin pattern
// (Dustin's Q9, 2026-10-14) and his 2026-10-11 admin review, with Recova's
// overview (app/admin/page.tsx, blob acb4ccbe) read as the inventory: its
// Needs attention and Recent admin actions panels and its stats, each one
// computed by Foxhound's own engine. Per-currency money stays.

// Imported so that a missing helper fails the assertion that names it, not the
// whole file.
const overviewLib: Partial<typeof import("~/lib/admin/overview")> = await import("~/lib/admin/overview").catch(() => ({}));

// The page's read is getAdminOverview; getPlatformOverview stays the admin
// API's (GET /platform) four fields. Looked up so a missing export fails the
// assertion that names it.
const serverLib: Record<string, unknown> = await import("~/lib/admin/overview.server");
async function adminOverview(db: unknown, nowMs: number): Promise<AdminOverview> {
  expect(typeof serverLib.getAdminOverview).toBe("function");
  return (serverLib.getAdminOverview as (db: unknown, nowMs: number) => Promise<AdminOverview>)(db, nowMs);
}

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo);

async function seed() {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values([
    { id: "acct_north", name: "Northwind Coffee", createdAt: at(40 * DAY) },
    { id: "acct_lumen", name: "Lumen Studio", createdAt: at(3 * DAY), processingPaused: true },
    { id: "acct_brake", name: "Harbor Yoga", createdAt: at(90 * DAY), processingPaused: true, pauseReason: "brake", billingExempt: true },
    // Paused but canceled: processing is already gated by the cancel, so there
    // is nothing to resume and it is not a problem to act on.
    { id: "acct_gone", name: "Gone Co", createdAt: at(60 * DAY), processingPaused: true, cancelledAt: at(5 * DAY) },
    // Demo accounts never count on the operator surface.
    { id: "demo_acct", name: "Demo", createdAt: at(1 * DAY), processingPaused: true, billingExempt: true },
  ]);

  await db.insert(stripeConnections).values([
    { id: "sc_new", accountId: "acct_lumen", stripeUserId: "acct_s1", connectedAt: at(2 * DAY), createdAt: at(2 * DAY) },
    { id: "sc_old", accountId: "acct_north", stripeUserId: "acct_s2", connectedAt: at(30 * DAY), createdAt: at(30 * DAY) },
    {
      id: "sc_gone",
      accountId: "acct_gone",
      stripeUserId: "acct_s3",
      connectedAt: at(3 * DAY),
      disconnectedAt: at(1 * DAY),
      createdAt: at(3 * DAY),
    },
    { id: "sc_demo", accountId: "demo_acct", stripeUserId: "acct_s4", connectedAt: at(1 * DAY), createdAt: at(1 * DAY) },
  ]);

  const dispute = (id: string, accountId: string, daysAgo: number, over: Partial<typeof disputes.$inferInsert> = {}) => ({
    id,
    accountId,
    stripeDisputeId: `dp_${id}`,
    stripeChargeId: `ch_${id}`,
    amountCents: 12000,
    currency: "usd",
    reason: "product_not_received",
    status: "needs_response",
    createdAt: at(daysAgo * DAY),
    ...over,
  });
  await db.insert(disputes).values([
    dispute("d_stale_old", "acct_north", 12, { evidenceDeadline: at(-10 * DAY) }),
    dispute("d_stale", "acct_lumen", 9, { currency: "eur", amountCents: 4500, evidenceDeadline: at(-2 * DAY) }),
    // Its deadline has passed: nothing can be sent, so it goes after the ones
    // that can still be answered.
    dispute("d_stale_past", "acct_north", 15, { evidenceDeadline: at(1 * DAY) }),
    dispute("d_fresh", "acct_north", 2),
    dispute("d_submitted", "acct_north", 10, { submittedAt: at(8 * DAY), state: "submitted" }),
    dispute("d_won", "acct_north", 20, { state: "resolved_won", status: "won" }),
    dispute("d_demo", "demo_acct", 20),
  ]);

  const invoice = (id: string, accountId: string, status: string, over: Partial<typeof billingInvoices.$inferInsert> = {}) => ({
    id,
    accountId,
    currency: "usd",
    periodStart: at(45 * DAY),
    periodEnd: at(15 * DAY),
    status,
    totalCents: 2400,
    idempotencyKey: `key_${id}`,
    createdAt: at(14 * DAY),
    ...over,
  });
  await db.insert(billingInvoices).values([
    invoice("inv_failed", "acct_north", "payment_failed", { chargeAttemptCount: 2, lastChargeAttemptAt: at(1 * DAY) }),
    invoice("inv_paid", "acct_lumen", "paid"),
    // The retry sweep stopped chasing it: the fee is owed and nobody will
    // collect it unless a person does something.
    invoice("inv_gave_up", "acct_lumen", "gave_up", { chargeAttemptCount: 4, lastChargeAttemptAt: at(3 * DAY) }),
    invoice("inv_uncollectible", "acct_north", "uncollectible", { createdAt: at(5 * DAY) }),
    // Voided on purpose, and an old write-off outside the 30-day window.
    invoice("inv_void", "acct_north", "void"),
    invoice("inv_old", "acct_north", "uncollectible", { createdAt: at(40 * DAY) }),
    invoice("inv_demo", "demo_acct", "payment_failed"),
  ]);

  const failed = (id: string, accountId: string, status = "recovered") => ({
    id,
    accountId,
    stripeEventId: `evt_${id}`,
    stripeInvoiceId: `in_${id}`,
    stripeCustomerId: `cus_${id}`,
    customerEmail: "customer@example.com",
    amountCents: 5000,
    currency: "usd",
    declineCategory: "soft",
    status,
    detectedAt: at(20 * DAY),
  });
  await db.insert(failedPayments).values([
    failed("fp_1", "acct_north"),
    failed("fp_2", "acct_lumen"),
    failed("fp_3", "acct_north"),
    failed("fp_4", "acct_north"),
    failed("fp_5", "demo_acct"),
    failed("fp_6", "acct_north"),
    failed("fp_7", "acct_north"),
  ]);
  const recovered = (id: string, fp: string, accountId: string, cents: number, currency: string, recoveredAt: Date, over = {}) => ({
    id,
    failedPaymentId: fp,
    accountId,
    amountCents: cents,
    currency,
    recoveredAt,
    recoveryMethod: "retry",
    ...over,
  });
  // The month began on 1 October 2026 (UTC).
  await db.insert(recoveredPayments).values([
    recovered("rp_usd", "fp_1", "acct_north", 5000, "usd", at(2 * DAY), { attributionKind: "foxhound_retry" }),
    recovered("rp_eur", "fp_2", "acct_lumen", 3000, "eur", at(3 * DAY), { attributionKind: "email_engaged" }),
    recovered("rp_usd2", "fp_6", "acct_north", 2500, "usd", at(4 * DAY), { attributionKind: "card_update" }),
    // Stripe recovered it on its own: not Foxhound's, so not counted, as on /billing.
    recovered("rp_baseline", "fp_7", "acct_north", 6666, "usd", at(1 * DAY)),
    recovered("rp_last_month", "fp_3", "acct_north", 9999, "usd", at(20 * DAY)),
    recovered("rp_deleted", "fp_4", "acct_north", 7777, "usd", at(1 * DAY), { deletedAt: at(1 * DAY / 2) }),
    recovered("rp_demo", "fp_5", "demo_acct", 8888, "usd", at(1 * DAY)),
  ]);

  return db;
}

describe("the Overview's figures come from Foxhound's engine", () => {

  it("counts billing exempt merchants without the demo", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(overview.billingExemptCount).toBe(1);
  });

  it("counts Stripe connections made in the last seven days that are still connected", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(overview.newConnectionsCount).toBe(1);
  });

  it("counts open disputes by Foxhound's state, and lists those a week old with no response, soonest deadline first", async () => {
    const overview = await adminOverview(await seed(), NOW);
    // d_stale_old, d_stale, d_stale_past, d_fresh, d_submitted are open; d_won is resolved.
    expect(overview.openDisputesCount).toBe(5);
    // Counted, not the length of the capped list, so a group past the cap still
    // says how many there are.
    expect(overview).toHaveProperty("staleDisputesCount", 3);
    // Soonest evidence deadline first among those still answerable, then the
    // ones whose deadline has passed (or that have none), oldest first.
    expect(overview.attention.staleDisputes.map((d) => [d.id, d.merchantName, d.amountCents, d.currency])).toEqual([
      ["d_stale", "Lumen Studio", 4500, "eur"],
      ["d_stale_old", "Northwind Coffee", 12000, "usd"],
      ["d_stale_past", "Northwind Coffee", 12000, "usd"],
    ]);
  });

  it("lists fee invoices from the last 30 days that failed or will not be collected", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(overview).toHaveProperty("attention.failedFeeInvoices");
    expect(
      overview.attention.failedFeeInvoices.map((i) => [i.id, i.merchantName, i.status, i.chargeAttemptCount, i.failedAt.getTime()]),
    ).toEqual([
      ["inv_failed", "Northwind Coffee", "payment_failed", 2, NOW - DAY],
      ["inv_gave_up", "Lumen Studio", "gave_up", 4, NOW - 3 * DAY],
      ["inv_uncollectible", "Northwind Coffee", "uncollectible", 0, NOW - 5 * DAY],
    ]);
    expect(overview).toHaveProperty("failedFeeInvoicesCount", 3);
  });

  it("sums what Foxhound recovered since the first of the month (attributed, as /billing) per currency", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(overview).toHaveProperty("recoveredThisMonth.paymentCount");
    expect(overview.recoveredThisMonth.paymentCount).toBe(3);
    expect([...overview.recoveredThisMonth.byCurrency].sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: "eur", cents: 3000 },
      { currency: "usd", cents: 7500 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The page

function overviewData(over: Partial<AdminOverview> = {}): AdminOverview {
  return {
    merchantCount: 3,
    activeRecoveriesCount: 4,
    mrrByCurrency: [
      { currency: "usd", totalCents: 1_250_000, accountCount: 2 },
      { currency: "eur", totalCents: 300_000, accountCount: 1 },
    ],
    cronHealth: { failedLast24h: 0, failedRuns: [], lastRunAt: at(20 * 60 * 1000), disabledCount: 0 },
    pausedCount: 0,
    billingExemptCount: 1,
    newConnectionsCount: 2,
    openDisputesCount: 3,
    recoveredThisMonth: {
      paymentCount: 3,
      byCurrency: [
        { currency: "usd", cents: 7500 },
        { currency: "eur", cents: 3000 },
      ],
    },
    staleDisputesCount: 0,
    failedFeeInvoicesCount: 0,
    attention: { pausedMerchants: [], staleDisputes: [], failedFeeInvoices: [] },
    ...over,
  };
}

const busyAttention: Partial<AdminOverview> = {
  pausedCount: 1,
  staleDisputesCount: 1,
  failedFeeInvoicesCount: 1,
  attention: {
    pausedMerchants: [{ id: "acct_lumen", name: "Lumen Studio", pauseReason: null }],
    staleDisputes: [
      {
        id: "d1",
        accountId: "acct_north",
        merchantName: "Northwind Coffee",
        amountCents: 12000,
        currency: "usd",
        reason: "product_not_received",
        createdAt: at(12 * DAY),
        evidenceDeadline: at(-2 * DAY),
      },
    ],
    failedFeeInvoices: [
      {
        id: "inv_1",
        accountId: "acct_north",
        merchantName: "Northwind Coffee",
        totalCents: 2400,
        currency: "usd",
        status: "payment_failed",
        chargeAttemptCount: 2,
        failedAt: at(DAY),
      },
    ],
  },
  cronHealth: {
    failedLast24h: 1,
    failedRuns: [{ id: "run_1", cronName: "weekly-digest", finishedAt: at(5 * 60 * 60 * 1000), message: "Email binding unavailable" }],
    lastRunAt: at(20 * 60 * 1000),
    disabledCount: 0,
  },
};






describe("Needs attention, as Capsomer's attention list wants it", () => {
  it("folds like rows into groups and keeps every row's own link", () => {
    expect(typeof overviewLib.overviewAttention).toBe("function");
    const items = overviewLib.overviewAttention!(overviewData(busyAttention), NOW);
    expect(items.map((i) => [i.group, i.href])).toEqual([
      ["paused", "/admin/merchants/acct_lumen"],
      ["disputes", "/admin/merchants/acct_north"],
      ["billing", "/admin/merchants/acct_north"],
      ["crons", "/admin/platform/crons#run-run_1"],
    ]);
    expect(items.every((i) => i.tone === "warn")).toBe(true);
  });

  it("says each time the same on the server and in any browser (UTC calendar days)", () => {
    // 00:30 UTC on 15 October, a run 26 hours before. By UTC's calendar that
    // is two days ago; in Honolulu (UTC-10) it is yesterday. The server renders
    // in UTC, so a browser left to its own zone would hydrate different words.
    const lateNow = Date.UTC(2026, 9, 15, 0, 30);
    const data = overviewData({
      cronHealth: {
        failedLast24h: 1,
        failedRuns: [{ id: "r", cronName: "weekly-digest", finishedAt: new Date(lateNow - 26 * 60 * 60 * 1000), message: null }],
        lastRunAt: null,
        disabledCount: 0,
      },
    });
    const saved = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    try {
      const run = overviewLib.overviewAttention!(data, lateNow).find((i) => i.group === "crons");
      expect(run?.when).toEqual({ text: "2 days ago", datetime: "2026-10-13T22:30:00.000Z" });
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("links a group only to a page that lists its rows", () => {
    expect(typeof overviewLib.overviewAttentionGroups).toBe("function");
    const groups = overviewLib.overviewAttentionGroups!(overviewData(busyAttention));
    // /admin/merchants shows a Paused badge; no admin page lists disputes or fee invoices.
    expect(groups.paused.view).toEqual({ href: "/admin/merchants", label: "Merchants" });
    expect(groups.crons.view).toEqual({ href: "/admin/platform/crons", label: "Crons" });
    expect(groups.disputes.view).toBeUndefined();
    expect(groups.billing.view).toBeUndefined();
  });

  it("says a fee nobody will collect as not collected", () => {
    const data = overviewData({
      ...busyAttention,
      attention: {
        ...busyAttention.attention!,
        failedFeeInvoices: [{ ...busyAttention.attention!.failedFeeInvoices[0], status: "gave_up" }],
      },
    });
    const row = overviewLib.overviewAttention!(data, NOW).find((i) => i.group === "billing");
    expect(row?.title).toBe("Northwind Coffee's fee invoice was not collected");
  });

  it("names a group by the engine's count, not by the rows read", () => {
    const groups = overviewLib.overviewAttentionGroups!(
      overviewData({ ...busyAttention, staleDisputesCount: 60, failedFeeInvoicesCount: 70 }),
    );
    expect(groups.disputes.title?.(50)).toBe("60 disputes have had no response for a week");
    expect(groups.billing.title?.(50)).toBe("70 fee invoices not paid");
  });
});

// Recova's Recent admin actions read the newest ten rows of the audit log.
describe("the recent admin actions read", () => {
  it("takes the newest ten, newest first", async () => {
    const { db } = createInMemoryDb();
    await db.insert(adminAuditLog).values(
      Array.from({ length: 12 }, (_, i) => ({
        id: `log_${i}`,
        actorEmail: "admin@example.com",
        action: "cron.disable",
        metadata: { cronName: "weekly-digest" },
        createdAt: at(i * 60 * 1000),
      })),
    );
    const lib: Record<string, unknown> = await import("~/lib/admin/overview.server");
    expect(typeof lib.listRecentAdminActions).toBe("function");
    const listRecentAdminActions = lib.listRecentAdminActions as (db: unknown) => Promise<Array<{ id: string }>>;
    const rows = await listRecentAdminActions(db);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `log_${i}`));
    expect(rows[0]).toMatchObject({
      action: "Disabled a cron",
      target: { label: "weekly-digest", href: "/admin/platform/crons#cron-weekly-digest" },
    });
  });
});
