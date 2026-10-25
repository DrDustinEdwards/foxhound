
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  accountMembers,
  accounts,
  adminAuditLog,
  billingInvoices,
  billingLineItems,
  failedPayments,
  mrrSnapshots,
  recoveredPayments,
  stripeConnections,
  user,
} from "~/db";
import { PAUSE_REASON_BRAKE, PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// J70 (job_fe19adcaaf19, row D3): /admin/merchants on the family admin pattern
// (Capsomer patterns, Dustin's Q9 of 2026-10-14) and his 2026-10-11 admin
// review, with Recova's merchants page read as the inventory
// (app/admin/merchants/page.tsx blob 21bd4e21, app/admin/AdminClient.tsx blob
// df4b3713, MerchantToggle.tsx blob 48c57535, the two toggle routes blobs
// 145fb9e0 and 118e5828): five platform figures, then one row per account with
// its owner's email, status, Stripe connection, recovery rate, amount
// recovered, last webhook and join date, and inline actions: the Stripe
// dashboard link, billing exempt, pause, and (for Recova's Disconnect) cancel
// through cancelMerchant. Impersonate stays out (ruling 125). Every write goes
// through Foxhound's existing writers.

const harness = vi.hoisted(() => ({ db: null as unknown, sqlite: null as unknown, deauthorized: [] as string[] }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/stripe/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/connect")>()),
  deauthorizeConnectedAccount: async (_env: Env, stripeUserId: string) => {
    harness.deauthorized.push(stripeUserId);
    return { ok: true };
  },
}));

// Looked up so a missing export fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const serverLib: Record<string, unknown> = await import("~/lib/admin/merchants.server");
const pageLib: Record<string, unknown> = await import("~/lib/admin/merchants").catch(() => ({}));
const route: Record<string, unknown> = await import("~/routes/admin/merchants/index");

/** What a toggle's answer says in the page, and the Undo it offers, if any:
 *  the one decision both the in-page (script) path and the no-script banner
 *  read. */
function toggleMessage(answer: unknown): { said: string; undo: { intent: string; accountId: string; value: boolean } | null } {
  expect(typeof pageLib.toggleMessage).toBe("function");
  return (pageLib.toggleMessage as (a: unknown) => { said: string; undo: { intent: string; accountId: string; value: boolean } | null })(answer);
}
const MerchantsPage = route.default as (props: unknown) => React.ReactNode;

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (msAgo: number) => new Date(NOW - msAgo);
const ACTOR = "admin@example.com";

type Seeded = ReturnType<typeof createInMemoryDb>;

async function seed(): Promise<Seeded> {
  const made = createInMemoryDb();
  const { db } = made;
  await db.insert(accounts).values([
    { id: "acct_north", name: "Northwind Coffee", createdAt: at(40 * DAY) },
    { id: "acct_lumen", name: "Lumen Studio", createdAt: at(20 * DAY), billingExempt: true },
    { id: "acct_gone", name: "Gone Goods", createdAt: at(10 * DAY), cancelledAt: at(2 * DAY) },
    { id: "acct_new", name: null, createdAt: at(1 * DAY) },
    { id: "demo_acct", name: "Demo Shop", createdAt: at(50 * DAY) },
  ]);
  await db.insert(user).values([
    { id: "u_rosa", name: "Rosa Park", email: "rosa@example.com", createdAt: at(40 * DAY), updatedAt: at(40 * DAY) },
    { id: "u_sam", name: "Sam Ortiz", email: "sam@example.com", createdAt: at(20 * DAY), updatedAt: at(20 * DAY) },
  ]);
  await db.insert(accountMembers).values([
    { id: "m1", accountId: "acct_north", userId: "u_rosa", role: "owner", status: "active", createdAt: at(40 * DAY) },
    // A member who is not the owner is not the account's email.
    { id: "m2", accountId: "acct_lumen", userId: "u_rosa", role: "member", status: "active", createdAt: at(20 * DAY) },
    { id: "m3", accountId: "acct_lumen", userId: "u_sam", role: "owner", status: "active", createdAt: at(20 * DAY) },
  ]);
  await db.insert(stripeConnections).values([
    {
      id: "sc_north",
      accountId: "acct_north",
      stripeUserId: "acct_1North",
      isPrimary: true,
      connectedAt: at(39 * DAY),
      lastWebhookAt: at(2 * HOUR),
      createdAt: at(39 * DAY),
    },
    // A disconnected primary stops counting as the primary one
    // (APPROVED-DIFFERENCES, 2026-09-19): Lumen's live one is the other.
    {
      id: "sc_lumen_old",
      accountId: "acct_lumen",
      stripeUserId: "acct_1LumenOld",
      isPrimary: true,
      connectedAt: at(19 * DAY),
      disconnectedAt: at(5 * DAY),
      lastWebhookAt: at(6 * DAY),
      createdAt: at(19 * DAY),
    },
    {
      id: "sc_lumen",
      accountId: "acct_lumen",
      stripeUserId: "acct_1Lumen",
      isPrimary: false,
      connectedAt: at(4 * DAY),
      lastWebhookAt: at(3 * HOUR),
      createdAt: at(4 * DAY),
    },
    {
      id: "sc_gone",
      accountId: "acct_gone",
      stripeUserId: "acct_1Gone",
      isPrimary: true,
      connectedAt: at(9 * DAY),
      disconnectedAt: at(2 * DAY),
      createdAt: at(9 * DAY),
    },
    { id: "sc_demo", accountId: "demo_acct", stripeUserId: "acct_demo", isPrimary: true, connectedAt: at(50 * DAY), createdAt: at(50 * DAY) },
  ]);

  const failed = (id: string, accountId: string, status: string, over = {}) => ({
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
    ...over,
  });
  await db.insert(failedPayments).values([
    failed("fp_1", "acct_north", "recovered"),
    failed("fp_2", "acct_north", "recovered"),
    failed("fp_3", "acct_north", "active"),
    failed("fp_4", "acct_north", "active"),
    failed("fp_5", "acct_north", "failed"),
    // Deleted: not counted in the rate (Recova: deleted_at is null).
    failed("fp_6", "acct_north", "failed", { deletedAt: at(1 * DAY) }),
    // Deleted while in a sequence: not in the queue, as Recova's queue read
    // (deleted_at is null) left it out (review LOW-4).
    failed("fp_11", "acct_north", "active", { deletedAt: at(1 * DAY) }),
    failed("fp_7", "acct_lumen", "recovered"),
    failed("fp_8", "acct_lumen", "active"),
    failed("fp_9", "demo_acct", "active"),
    failed("fp_10", "demo_acct", "recovered"),
  ]);
  const recovered = (id: string, fp: string, accountId: string, cents: number, currency: string, over = {}) => ({
    id,
    failedPaymentId: fp,
    accountId,
    amountCents: cents,
    currency,
    recoveredAt: at(3 * DAY),
    recoveryMethod: "retry",
    ...over,
  });
  await db.insert(recoveredPayments).values([
    recovered("rp_1", "fp_1", "acct_north", 4000, "usd"),
    recovered("rp_2", "fp_2", "acct_north", 2500, "eur"),
    // Deleted: neither the row's amount nor the platform's total.
    recovered("rp_3", "fp_5", "acct_north", 9900, "usd", { deletedAt: at(1 * DAY) }),
    recovered("rp_4", "fp_7", "acct_lumen", 1000, "usd"),
    recovered("rp_5", "fp_10", "demo_acct", 7700, "usd"),
  ]);

  const snapshot = (id: string, accountId: string, daysAgo: number, cents: number, currency = "usd") => ({
    id,
    accountId,
    snapshotDate: at(daysAgo * DAY),
    totalMrrCents: cents,
    newMrrCents: 0,
    expansionMrrCents: 0,
    contractionMrrCents: 0,
    churnMrrCents: 0,
    reactivationMrrCents: 0,
    activeCustomersCount: 0,
    newCustomersCount: 0,
    churnedCustomersCount: 0,
    perPlanBreakdown: [],
    perCohortBreakdown: [],
    perChannelBreakdown: [],
    currency,
    createdAt: at(daysAgo * DAY),
  });
  await db.insert(mrrSnapshots).values([
    snapshot("mrr_north_old", "acct_north", 2, 100000),
    snapshot("mrr_north", "acct_north", 1, 120000),
    snapshot("mrr_lumen", "acct_lumen", 1, 30000, "eur"),
    snapshot("mrr_demo", "demo_acct", 1, 990000),
  ]);

  const invoice = (id: string, accountId: string, status: string, createdAgo: number) => ({
    id,
    accountId,
    currency: "usd",
    periodStart: at(45 * DAY),
    periodEnd: at(15 * DAY),
    status,
    totalCents: 0,
    idempotencyKey: `key_${id}`,
    createdAt: at(createdAgo * DAY),
  });
  await db.insert(billingInvoices).values([
    // The month began on 1 October 2026 (UTC); NOW is the 15th.
    invoice("inv_now", "acct_north", "paid", 10),
    invoice("inv_void", "acct_north", "void", 10),
    invoice("inv_last_month", "acct_north", "paid", 20),
    invoice("inv_demo", "demo_acct", "paid", 10),
  ]);
  const line = (id: string, invoiceId: string, accountId: string, type: string, feeCents: number, fp?: string) => ({
    id,
    invoiceId,
    accountId,
    type,
    currency: "usd",
    amountCents: feeCents,
    feeCents,
    recoveredPaymentId: fp ?? null,
    createdAt: at(10 * DAY),
  });
  await db.insert(billingLineItems).values([
    line("li_1", "inv_now", "acct_north", "recovery_fee", 800, "rp_1"),
    // A voided invoice's fee was never earned; last month's is last month's.
    line("li_2", "inv_void", "acct_north", "recovery_fee", 500, "rp_2"),
    line("li_3", "inv_last_month", "acct_north", "recovery_fee", 300, "rp_4"),
    line("li_4", "inv_demo", "demo_acct", "recovery_fee", 1540, "rp_5"),
  ]);
  return made;
}

interface Row {
  id: string;
  name: string | null;
  ownerEmail: string | null;
  createdAt: Date | null;
  billingExempt: boolean;
  processingPaused: boolean;
  pauseReason: string | null;
  cancelledAt: Date | null;
  connectionStatus: "connected" | "disconnected" | "never_connected";
  stripeUserId: string | null;
  lastWebhookAt: Date | null;
  activeRecoveriesCount: number;
  recoveryRatePct: number | null;
  recovered: Array<{ currency: string; cents: number }>;
}

async function listRows(db: unknown): Promise<Row[]> {
  expect(typeof serverLib.listAdminMerchants).toBe("function");
  return (serverLib.listAdminMerchants as (db: unknown) => Promise<Row[]>)(db);
}

describe("listAdminMerchants: one row per account, Recova's inventory from Foxhound's engine", () => {

  it("gives the active owner's email, never another member's", async () => {
    const rows = await listRows((await seed()).db);
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get("acct_north")?.ownerEmail).toBe("rosa@example.com");
    expect(by.get("acct_lumen")?.ownerEmail).toBe("sam@example.com");
    expect(by.get("acct_new")?.ownerEmail).toBeNull();
  });

  it("reads the live connection for the Stripe link and the last webhook, never a disconnected primary", async () => {
    const rows = await listRows((await seed()).db);
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get("acct_north")).toMatchObject({ stripeUserId: "acct_1North", lastWebhookAt: at(2 * HOUR), connectionStatus: "connected" });
    expect(by.get("acct_lumen")).toMatchObject({ stripeUserId: "acct_1Lumen", lastWebhookAt: at(3 * HOUR), connectionStatus: "connected" });
    expect(by.get("acct_gone")).toMatchObject({ stripeUserId: null, lastWebhookAt: null, connectionStatus: "disconnected" });
    expect(by.get("acct_new")).toMatchObject({ stripeUserId: null, connectionStatus: "never_connected" });
  });

  it("works the recovery rate as Recova did: recovered over failed, deleted rows left out, none with no failures", async () => {
    const rows = await listRows((await seed()).db);
    const by = new Map(rows.map((r) => [r.id, r]));
    // North: 2 live recoveries of 5 live failures.
    expect(by.get("acct_north")?.recoveryRatePct).toBe(40);
    expect(by.get("acct_lumen")?.recoveryRatePct).toBe(50);
    expect(by.get("acct_new")?.recoveryRatePct).toBeNull();
  });

  it("sums what each merchant recovered per currency, never adding currencies together", async () => {
    const rows = await listRows((await seed()).db);
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get("acct_north")?.recovered).toEqual(
      expect.arrayContaining([
        { currency: "usd", cents: 4000 },
        { currency: "eur", cents: 2500 },
      ]),
    );
    expect(by.get("acct_north")?.recovered).toHaveLength(2);
    expect(by.get("acct_new")?.recovered).toEqual([]);
  });

  it("keeps Foxhound's own columns: active recoveries, the flags, the pause reason and cancel", async () => {
    const { db } = await seed();
    await db.update(accounts).set({ processingPaused: true, pauseReason: PAUSE_REASON_BRAKE }).where(eq(accounts.id, "acct_north"));
    const by = new Map((await listRows(db)).map((r) => [r.id, r]));
    expect(by.get("acct_north")).toMatchObject({ activeRecoveriesCount: 2, processingPaused: true, pauseReason: PAUSE_REASON_BRAKE });
    expect(by.get("acct_lumen")).toMatchObject({ billingExempt: true, activeRecoveriesCount: 1 });
    expect(by.get("acct_gone")?.cancelledAt).toEqual(at(2 * DAY));
  });
});

interface Figures {
  merchantCount: number;
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  connectedCount: number;
  totalRecovered: Array<{ currency: string; cents: number }>;
  recoveryFeesThisMonth: Array<{ currency: string; cents: number }>;
  paymentsInQueue: number;
}

async function figures(db: unknown): Promise<Figures> {
  expect(typeof serverLib.getMerchantFigures).toBe("function");
  return (serverLib.getMerchantFigures as (db: unknown, now: number) => Promise<Figures>)(db, NOW);
}

describe("getMerchantFigures: Recova's five stat cards, demo accounts not counted", () => {
  it("estimates MRR from each merchant's latest snapshot, per currency", async () => {
    const f = await figures((await seed()).db);
    expect(f.mrrByCurrency).toEqual(
      expect.arrayContaining([
        { currency: "usd", totalCents: 120000, accountCount: 1 },
        { currency: "eur", totalCents: 30000, accountCount: 1 },
      ]),
    );
    expect(f.mrrByCurrency).toHaveLength(2);
  });

  it("counts merchants with a live Stripe connection", async () => {
    const f = await figures((await seed()).db);
    expect(f.connectedCount).toBe(2);
    expect(f.merchantCount).toBe(4);
  });

  it("sums the recovery fees invoiced since the first of the month, a voided invoice left out", async () => {
    const f = await figures((await seed()).db);
    expect(f.recoveryFeesThisMonth).toEqual([{ currency: "usd", cents: 800 }]);
  });
});

// ---------------------------------------------------------------- the action

function context() {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, {
    env: { MONEY_WRITER: inMemoryMoneyWriter(() => harness.sqlite as never).binding } as unknown as Env,
    ctx: {} as ExecutionContext,
    nonce: "",
  });
  c.set(adminContext, { email: ACTOR });
  return c;
}

async function post(fields: Record<string, string>) {
  expect(typeof route.action).toBe("function");
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const action = route.action as (args: unknown) => Promise<{ data: Record<string, unknown>; init?: { status?: number } }>;
  return action({
    request: new Request("https://foxhoundapp.com/admin/merchants?index", { method: "POST", body }),
    context: context(),
    params: {},
  });
}

async function account(db: Seeded["db"], id: string) {
  return (await db.select().from(accounts).where(eq(accounts.id, id)))[0];
}

async function auditActions(db: Seeded["db"]) {
  return (await db.select({ action: adminAuditLog.action, metadata: adminAuditLog.metadata }).from(adminAuditLog)).map((r) => r.action);
}

describe("the action: Foxhound's writers, each with its audit row", () => {
  let seeded: Seeded;
  beforeEach(async () => {
    seeded = await seed();
    harness.db = seeded.db;
    harness.sqlite = seeded.sqlite;
    harness.deauthorized = [];
  });

  it("pauses and resumes processing through setProcessingPaused, marking a person's pause manual", async () => {
    await post({ intent: "processing-paused", accountId: "acct_north", value: "true" });
    expect(await account(seeded.db, "acct_north")).toMatchObject({ processingPaused: true, pauseReason: PAUSE_REASON_MANUAL });
    const resumed = await post({ intent: "processing-paused", accountId: "acct_north", value: "false" });
    expect(resumed.data).toMatchObject({ ok: true, value: false, wasBrakePause: false });
    expect(await account(seeded.db, "acct_north")).toMatchObject({ processingPaused: false, pauseReason: null });
    expect(await auditActions(seeded.db)).toEqual(["merchant.processing.pause", "merchant.processing.resume"]);
  });

  it("refuses an account that does not exist, writing nothing", async () => {
    const res = await post({ intent: "processing-paused", accountId: "acct_nope", value: "true" });
    expect(res.init?.status).toBe(400);
    expect(res.data.ok).toBe(false);
    expect(await auditActions(seeded.db)).toEqual([]);
  });

  it("refuses a value that is not true or false, and an unknown intent", async () => {
    expect((await post({ intent: "billing-exempt", accountId: "acct_north", value: "yes" })).init?.status).toBe(400);
    expect((await post({ intent: "impersonate", accountId: "acct_north" })).init?.status).toBe(400);
    expect(await auditActions(seeded.db)).toEqual([]);
  });

  it("cancels only with the typed word, through cancelMerchant", async () => {
    const wrong = await post({ intent: "cancel", accountId: "acct_north", confirm: "yes" });
    expect(wrong.init?.status).toBe(400);
    expect((await account(seeded.db, "acct_north")).cancelledAt).toBeNull();
    expect(harness.deauthorized).toEqual([]);

    const done = await post({ intent: "cancel", accountId: "acct_north", confirm: "Cancel" });
    expect(done.data).toMatchObject({ ok: true, intent: "cancel", accountId: "acct_north" });
    expect((await account(seeded.db, "acct_north")).cancelledAt).not.toBeNull();
    const conn = (await seeded.db.select().from(stripeConnections).where(eq(stripeConnections.id, "sc_north")))[0];
    expect(conn.disconnectedAt).not.toBeNull();
    expect(harness.deauthorized).toEqual(["acct_1North"]);
    expect(await auditActions(seeded.db)).toEqual(["merchant.cancel"]);
  });

  it("offers no Undo for a stale Pause on a merchant the brake already paused, and Undo can never lift the brake", async () => {
    await seeded.db.update(accounts).set({ processingPaused: true, pauseReason: PAUSE_REASON_BRAKE }).where(eq(accounts.id, "acct_north"));
    // A row rendered before the brake engaged still says Pause.
    const stale = await post({ intent: "processing-paused", accountId: "acct_north", value: "true" });
    expect(stale.data).toMatchObject({ ok: true, value: true, changed: false });
    expect(toggleMessage(stale.data).undo).toBeNull();
    expect(await account(seeded.db, "acct_north")).toMatchObject({ processingPaused: true, pauseReason: PAUSE_REASON_BRAKE });
    // Even an Undo posted by hand resumes only a person's pause.
    const undo = await post({ intent: "processing-paused", accountId: "acct_north", value: "false", undo: "1" });
    expect(undo.init?.status).toBe(409);
    expect(undo.data.ok).toBe(false);
    expect(await account(seeded.db, "acct_north")).toMatchObject({ processingPaused: true, pauseReason: PAUSE_REASON_BRAKE });
  });

  it("undoes a real Pause: the manual pause it made is resumed", async () => {
    const paused = await post({ intent: "processing-paused", accountId: "acct_north", value: "true" });
    expect(paused.data).toMatchObject({ ok: true, changed: true });
    const message = toggleMessage(paused.data);
    expect(message.undo).toEqual({ intent: "processing-paused", accountId: "acct_north", value: false });
    const undone = await post({ intent: "processing-paused", accountId: "acct_north", value: "false", undo: "1" });
    expect(undone.data).toMatchObject({ ok: true, changed: true });
    expect(await account(seeded.db, "acct_north")).toMatchObject({ processingPaused: false, pauseReason: null });
  });

  it("records in the audit row whether the toggle changed anything (PR 140 review)", async () => {
    // Lumen is already exempt: a stale Set exempt changes nothing, and its row says so.
    await post({ intent: "billing-exempt", accountId: "acct_lumen", value: "true" });
    // North is not: a real Set exempt.
    await post({ intent: "billing-exempt", accountId: "acct_north", value: "true" });
    // The brake paused North: an Undo of a pause cannot resume it.
    await seeded.db.update(accounts).set({ processingPaused: true, pauseReason: PAUSE_REASON_BRAKE }).where(eq(accounts.id, "acct_north"));
    await post({ intent: "processing-paused", accountId: "acct_north", value: "true" });
    await post({ intent: "processing-paused", accountId: "acct_north", value: "false", undo: "1" });
    const rows = await seeded.db.select({ action: adminAuditLog.action, metadata: adminAuditLog.metadata }).from(adminAuditLog);
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([
      ["merchant.billing_exempt.enable", { accountId: "acct_lumen", changed: false }],
      ["merchant.billing_exempt.enable", { accountId: "acct_north", changed: true }],
      ["merchant.processing.pause", { accountId: "acct_north", changed: false }],
      ["merchant.processing.resume", { accountId: "acct_north", undo: true, changed: false }],
    ]);
  });

  it("offers no Undo for a stale Set exempt on a merchant already exempt, so Undo cannot bill it", async () => {
    // Lumen is already exempt; a stale row still says Set exempt.
    const stale = await post({ intent: "billing-exempt", accountId: "acct_lumen", value: "true" });
    expect(stale.data).toMatchObject({ ok: true, value: true, changed: false });
    expect(toggleMessage(stale.data).undo).toBeNull();
    expect(toggleMessage(stale.data).said).toMatch(/already billing exempt\. Nothing was changed\./);
    // Neither path offers it: no in-page Undo (undo is null above) and no
    // no-script Undo form. Exemption has no reason column like a pause's, so a
    // hand-posted "End exemption" is an ordinary request the server cannot
    // tell from an Undo; the guard is that no Undo is offered.
    expect(render({ actionData: stale.data })).not.toMatch(/<button[^>]*>Undo/);
    expect((await account(seeded.db, "acct_lumen")).billingExempt).toBe(true);
  });

  it("refuses to cancel a merchant already cancelled", async () => {
    const res = await post({ intent: "cancel", accountId: "acct_gone", confirm: "cancel" });
    expect(res.init?.status).toBe(400);
    expect(await auditActions(seeded.db)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the page

const T = Date.now();
function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    name: "Northwind Coffee",
    ownerEmail: "rosa@example.com",
    createdAt: new Date(T - 40 * DAY),
    billingExempt: false,
    processingPaused: false,
    pauseReason: null,
    cancelledAt: null,
    connectionStatus: "connected",
    stripeUserId: "acct_1North",
    lastWebhookAt: new Date(T - 2 * HOUR),
    activeRecoveriesCount: 2,
    recoveryRatePct: 40,
    recovered: [
      { currency: "usd", cents: 4000 },
      { currency: "eur", cents: 2500 },
    ],
    ...over,
  };
}

const ROWS: Row[] = [
  row("acct_north"),
  row("acct_lumen", { name: "Lumen Studio", ownerEmail: "sam@example.com", billingExempt: true, recoveryRatePct: 50, stripeUserId: "acct_1Lumen" }),
  row("acct_paused", { name: "Paused Pets", processingPaused: true, pauseReason: PAUSE_REASON_BRAKE, recoveryRatePct: 10 }),
  row("acct_gone", { name: "Gone Goods", cancelledAt: new Date(T - 2 * DAY), connectionStatus: "disconnected", stripeUserId: null, lastWebhookAt: null }),
  row("acct_new", { name: null, ownerEmail: null, connectionStatus: "never_connected", stripeUserId: null, lastWebhookAt: null, recoveryRatePct: null, recovered: [], activeRecoveriesCount: 0 }),
];

const FIGURES: Figures = {
  merchantCount: 5,
  mrrByCurrency: [{ currency: "usd", totalCents: 120000, accountCount: 1 }],
  connectedCount: 3,
  totalRecovered: [{ currency: "usd", cents: 5000 }],
  recoveryFeesThisMonth: [{ currency: "usd", cents: 800 }],
  paymentsInQueue: 3,
};

function render(over: { merchants?: Row[]; confirmCancel?: { id: string; name: string | null } | null; actionData?: unknown } = {}) {
  const merchants = over.merchants ?? ROWS;
  const counts = { all: merchants.length, paused: 0, "billing-exempt": 0 };
  const data = { view: "all", merchants, counts, brakePaused: 0, figures: FIGURES, confirmCancel: over.confirmCancel ?? null };
  const Stub = createRoutesStub([
    {
      path: "/admin/merchants",
      Component: () => createElement(MerchantsPage as never, { loaderData: data, actionData: over.actionData } as never),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/merchants"] }));
}



describe("pure helpers", () => {
  it("decides the in-page message and its Undo from the answer alone", () => {
    const base = { ok: true, accountId: "acct_north", name: "Northwind Coffee", wasBrakePause: false };
    expect(toggleMessage({ ...base, intent: "billing-exempt", value: true, changed: true })).toMatchObject({
      said: "Northwind Coffee is billing exempt.",
      undo: { intent: "billing-exempt", accountId: "acct_north", value: false },
    });
    expect(toggleMessage({ ...base, intent: "billing-exempt", value: false, changed: false })).toMatchObject({
      said: "Northwind Coffee was already billed. Nothing was changed.",
      undo: null,
    });
    expect(toggleMessage({ ...base, intent: "processing-paused", value: false, changed: true, wasBrakePause: true }).undo).toBeNull();
    expect(toggleMessage({ ...base, intent: "processing-paused", value: false, changed: true }).undo).toEqual({
      intent: "processing-paused",
      accountId: "acct_north",
      value: true,
    });
  });

  it("accepts the typed word in any case, and nothing else", () => {
    expect(typeof pageLib.isCancelConfirmValid).toBe("function");
    const valid = pageLib.isCancelConfirmValid as (s: string) => boolean;
    expect(valid("cancel")).toBe(true);
    expect(valid(" CANCEL ")).toBe(true);
    expect(valid("cancel merchant")).toBe(false);
    expect(valid("")).toBe(false);
  });
});
