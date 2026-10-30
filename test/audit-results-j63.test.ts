
import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  showDisputesSection,
} from "~/components/audit/sections";
import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import { toAuditRunView } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { readDisputes } from "~/lib/stripe/reads";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J63, rows U3 and U4: the live audit results page and a
// saved run, against Recova's app/audit/results/page.tsx (blob 9aad7745),
// app/audit/results/[id]/page.tsx (a0dbf6ef) and the four section components
// (AuditRecoverySection ab6ec2c5, AuditDisputesSection 6db9c3bc,
// AuditHealthSection 17828ab5, ExpiringCardsTimeline 33537a84), read whole at
// HEAD. Each test names the Recova line it holds Foxhound to.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const RAN_AT = new Date("2026-10-10T09:00:00.000Z");
const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failedRead = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

function auditWith(over: Partial<AuditInputs> = {}) {
  return runAudit({
    stripeAccountId: "acct_stripe_x",
    lookbackDays: 90,
    ranAt: RAN_AT,
    reads: {
      uncollectibleInvoices: ok<Stripe.Invoice>([]),
      openInvoices: ok<Stripe.Invoice>([]),
      subscriptions: ok<Stripe.Subscription>([]),
      disputes: ok<Stripe.Dispute>([]),
      cardUpdaterEvents: ok<Stripe.Event>([]),
      ...over,
    },
  });
}

const viewOf = (over: Partial<AuditInputs> = {}) => toAuditRunView(auditWith(over), "One. Two. Three.");

const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;




describe("U3/U4: Disputes unmanaged (AuditDisputesSection, 6db9c3bc)", () => {
  it("is left off when every dispute figure is zero, as Recova's hasDisputeSignal does", () => {
    expect(showDisputesSection(viewOf())).toBe(false);
    expect(showDisputesSection(viewOf({ disputes: ok([dispute({ status: "won" })]) }))).toBe(true);
  });

  it("stays on the page when the disputes read failed, because unread is not zero", () => {
    expect(showDisputesSection(viewOf({ disputes: failedRead("rate limited") }))).toBe(true);
  });
});

// --- the two pages -----------------------------------------------------------

const runPage = await import("~/routes/app/audit/run");
// Loaded leniently so a missing module fails an assertion, not the file.
const runsRedirect = await import("~/routes/audit/runs-redirect").catch(() => null);



describe("U4: a saved run at Recova's path, /audit/results/:id", () => {

  it("the old /audit/runs/:id answers one 301 to the new path", () => {
    expect(runsRedirect, "app/routes/audit/runs-redirect.ts exists").not.toBeNull();
    const response = runsRedirect!.loader({
      request: new Request("https://foxhoundapp.test/audit/runs/run_9?x=1"),
      params: { id: "run_9" },
    } as never) as Response;
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/audit/results/run_9?x=1");
  });
});

// U4's loader, against two accounts.
let sqlite: Database.Database;
const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "user_1",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: accountId, role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

describe("U4: the saved run's live figures, scoped to the account", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    for (const id of [ACCOUNT_A, ACCOUNT_B]) {
      sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, id);
    }
  });

  const failed = (accountId: string, id: string, status: string) =>
    sqlite
      .prepare(
        `INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at)
         VALUES (?, ?, ?, ?, 'cus_1', 'c@example.com', 1000, 'usd', 'soft', ?, 1000)`,
      )
      .run(id, accountId, `evt_${id}`, `in_${id}`, status);

  const disputeRow = (accountId: string, id: string, state: string, submittedBy: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, submitted_at, submitted_by, created_at)
         VALUES (?, ?, ?, 'ch_1', 1000, 'usd', 'fraudulent', 'lost', ?, ?, ?, 1000)`,
      )
      .run(id, accountId, `dp_${id}`, state, submittedBy ? 2000 : null, submittedBy);

  it("counts active sequences, the lifetime recovery rate and Foxhound's win rate for this account only", async () => {
    const { saveAuditRun } = await import("~/lib/audit/persist.server");
    const id = await saveAuditRun({} as Env, auditWith(), {
      accountId: ACCOUNT_A,
      isAuthenticated: true,
      summary: "s",
      now: RAN_AT,
    });
    failed(ACCOUNT_A, "f1", "active");
    failed(ACCOUNT_A, "f2", "recovered");
    failed(ACCOUNT_A, "f3", "recovered");
    failed(ACCOUNT_A, "f4", "failed_unrecovered");
    failed(ACCOUNT_B, "f5", "active");
    failed(ACCOUNT_B, "f6", "active");
    disputeRow(ACCOUNT_A, "d1", "resolved_won", "owner@alpha.test");
    disputeRow(ACCOUNT_A, "d2", "resolved_lost", "owner@alpha.test");
    disputeRow(ACCOUNT_A, "d3", "resolved_won", "merchant_or_stripe");
    disputeRow(ACCOUNT_B, "d4", "resolved_lost", "owner@beta.test");

    const data = (await runPage.loader({
      context: contextFor(ACCOUNT_A),
      request: new Request(`https://foxhoundapp.test/audit/results/${id}`),
      params: { id },
    } as never)) as { activeSequences: number; recoveryRatePct: number | null; foxhoundWinRate: number | null };
    expect(data.activeSequences).toBe(1);
    expect(data.recoveryRatePct).toBe(50);
    // Of the two Foxhound submitted and that resolved, one won.
    expect(data.foxhoundWinRate).toBe(50);
  });

  it("an account Foxhound has submitted nothing for has no win rate, not 0%", async () => {
    const { saveAuditRun } = await import("~/lib/audit/persist.server");
    const id = await saveAuditRun({} as Env, auditWith(), {
      accountId: ACCOUNT_B,
      isAuthenticated: true,
      summary: "s",
      now: RAN_AT,
    });
    disputeRow(ACCOUNT_A, "d1", "resolved_won", "owner@alpha.test");
    const data = (await runPage.loader({
      context: contextFor(ACCOUNT_B),
      request: new Request(`https://foxhoundapp.test/audit/results/${id}`),
      params: { id },
    } as never)) as { foxhoundWinRate: number | null; recoveryRatePct: number | null };
    expect(data.foxhoundWinRate).toBeNull();
    expect(data.recoveryRatePct).toBeNull();
  });
});

describe("RULES.md 3.19: the audit's Stripe reads page to the end and log the count", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => info.mockRestore());

  it("reads every dispute past the old soft ceiling", async () => {
    const items = Array.from({ length: 2_010 }, (_, i) => ({ id: `dp_${i}` }));
    const stripe = {
      disputes: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            for (const item of items) yield item;
          },
        }),
      },
    } as unknown as Stripe;
    const outcome = await readDisputes(stripe);
    expect(outcome.ok && outcome.data.length).toBe(2_010);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`disputes: 2010 rows`));
  });
});

// ---- Review round 1 (PR #123) -------------------------------------------------


/** A Stripe-shaped list of the given items, page by page as the SDK yields. */
const listOf = (items: unknown[]) => () => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) yield item;
  },
});

// A field the engine never reads, big enough that keeping it is the failure.
const BULK = "x".repeat(10_000);

const fullInvoice = (o: Record<string, unknown>) => ({
  id: "in_1",
  object: "invoice",
  amount_due: 1_500,
  currency: "eur",
  due_date: 1,
  created: Math.floor(RAN_AT.getTime() / 1000) - 86_400,
  status: "open",
  last_finalization_error: { decline_code: "expired_card", message: BULK },
  last_payment_error: { code: "card_declined", message: BULK },
  charge: { id: "ch_1", failure_code: "insufficient_funds", outcome: { reason: BULK } },
  lines: { data: [{ description: BULK }] },
  metadata: { note: BULK },
  ...o,
});

const fullSubscription = (o: Record<string, unknown>) => ({
  id: "sub_1",
  object: "subscription",
  status: "active",
  currency: "eur",
  customer: { id: "cus_9", email: "c@example.com", metadata: { note: BULK } },
  default_payment_method: { id: "pm_1", card: { exp_month: 11, exp_year: 2026, brand: "visa" }, billing_details: { address: BULK } },
  items: { data: [{ id: "si_1", price: { unit_amount: 7_000, recurring: { interval: "month", interval_count: 1 }, product: { description: BULK } } }] },
  canceled_at: null,
  cancellation_details: { reason: null, comment: BULK },
  metadata: { note: BULK },
  ...o,
});

const fullDispute = (o: Record<string, unknown>) => ({
  id: "dp_1",
  object: "dispute",
  status: "lost",
  amount: 4_000,
  currency: "eur",
  evidence_details: { submission_count: 0, due_by: 1 },
  evidence: { uncategorized_text: BULK },
  charge: { id: "ch_1", description: BULK },
  ...o,
});

const fullEvent = () => ({ id: "evt_1", object: "event", type: "payment_method.automatically_updated", created: 1, data: { object: { note: BULK } } });

const fakeStripe = (lists: { invoices: unknown[]; subscriptions: unknown[]; disputes: unknown[]; events: unknown[] }) =>
  ({
    invoices: { list: listOf(lists.invoices) },
    subscriptions: { list: listOf(lists.subscriptions) },
    disputes: { list: listOf(lists.disputes) },
    events: { list: listOf(lists.events) },
  }) as unknown as Stripe;

describe("Review round 1, must-fix 1: the reads keep only what the engine reads", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => info.mockRestore());


  it("the engine's answer from the narrowed rows is the answer from the full objects", async () => {
    const full = {
      uncollectibleInvoices: ok([fullInvoice({}) as unknown as Stripe.Invoice]),
      openInvoices: ok([fullInvoice({ id: "in_2", last_finalization_error: null, last_payment_error: null }) as unknown as Stripe.Invoice]),
      subscriptions: ok([
        fullSubscription({}) as unknown as Stripe.Subscription,
        fullSubscription({ status: "past_due", customer: "cus_8" }) as unknown as Stripe.Subscription,
        fullSubscription({ status: "canceled", canceled_at: Math.floor(RAN_AT.getTime() / 1000) - 10, cancellation_details: { reason: "cancellation_requested" } }) as unknown as Stripe.Subscription,
      ]),
      disputes: ok([fullDispute({}) as unknown as Stripe.Dispute, fullDispute({ status: "needs_response", amount: 900 }) as unknown as Stripe.Dispute]),
      cardUpdaterEvents: ok([fullEvent() as unknown as Stripe.Event]),
    };
    const narrowStripe = fakeStripe({
      invoices: [fullInvoice({}), fullInvoice({ id: "in_2", last_finalization_error: null, last_payment_error: null })],
      subscriptions: (full.subscriptions as { data: unknown[] }).data,
      disputes: (full.disputes as { data: unknown[] }).data,
      events: [fullEvent()],
    });
    // The fake invoices list ignores the status filter, so each invoice read
    // returns both; build the full-object input the same way.
    full.uncollectibleInvoices = ok([fullInvoice({}), fullInvoice({ id: "in_2", last_finalization_error: null, last_payment_error: null })] as unknown as Stripe.Invoice[]);
    full.openInvoices = full.uncollectibleInvoices;
    const { collectAuditInputs } = await import("~/lib/audit/run.server");
    const narrowed = await collectAuditInputs(narrowStripe, 90, RAN_AT);
    const a = runAudit({ stripeAccountId: "acct_x", lookbackDays: 90, ranAt: RAN_AT, reads: full });
    const b = runAudit({ stripeAccountId: "acct_x", lookbackDays: 90, ranAt: RAN_AT, reads: narrowed });
    expect(b).toEqual(a);
    // And the fixture exercised the fields, so equality means something.
    expect(a.failedInvoices.ok && a.failedInvoices.data.byCategory.expired).toBeGreaterThan(0);
    expect(a.expiringCards.ok && a.expiringCards.data.count).toBe(1);
    expect(a.health.ok && a.health.data.voluntaryChurnRateBps).toBeGreaterThan(0);
    expect(a.meta.currency).toBe("eur");
  });
});

describe("the audit reads each failed invoice's real decline code", () => {
  it("files an invoice under its charge's decline, not unknown, on the pinned API version", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // What Stripe sends now: no charge, no last_payment_error on the invoice.
    const bare = fullInvoice({ last_finalization_error: null, last_payment_error: null, charge: undefined });
    const stripe = {
      ...fakeStripe({ invoices: [bare], subscriptions: [], disputes: [], events: [] }),
      invoicePayments: { list: listOf([{ created: 1, payment: { payment_intent: "pi_1" } }]) },
      paymentIntents: {
        retrieve: async () => ({ last_payment_error: { decline_code: "expired_card" }, latest_charge: { failure_code: "card_declined" } }),
      },
    } as unknown as Stripe;
    const { collectAuditInputs } = await import("~/lib/audit/run.server");
    const reads = await collectAuditInputs(stripe, 90, RAN_AT);
    const result = runAudit({ stripeAccountId: "acct_x", lookbackDays: 90, ranAt: RAN_AT, reads });
    expect(result.failedInvoices.ok && result.failedInvoices.data.byCategory.expired).toBeGreaterThan(0);
  });
});

describe("Review round 1: a failed live-figure read still renders the saved run", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT_A, ACCOUNT_A);
  });

  it("logs the whole error and answers the run with no live figures", async () => {
    const { saveAuditRun } = await import("~/lib/audit/persist.server");
    const id = await saveAuditRun({} as Env, auditWith(), {
      accountId: ACCOUNT_A,
      isAuthenticated: true,
      summary: "s",
      now: RAN_AT,
    });
    // The disputes table is gone, so the live-figure read throws.
    sqlite.exec("PRAGMA foreign_keys = OFF; DROP TABLE disputes;");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const data = (await runPage.loader({
        context: contextFor(ACCOUNT_A),
        request: new Request(`https://foxhoundapp.test/audit/results/${id}`),
        params: { id },
      } as never)) as { run: { id: string }; activeSequences: number | null; recoveryRatePct: number | null; foxhoundWinRate: number | null };
      expect(data.run.id).toBe(id);
      expect(data.activeSequences).toBeNull();
      expect(data.recoveryRatePct).toBeNull();
      expect(data.foxhoundWinRate).toBeNull();
      expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    } finally {
      error.mockRestore();
    }
  });
});
