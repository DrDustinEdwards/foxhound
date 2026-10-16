import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";

import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditDisputesSection,
  AuditHealthSection,
  AuditRecoverySection,
  showDisputesSection,
  type CtaState,
} from "~/components/audit/sections";
import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import { toAuditRunView, type AuditRunView } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { readDisputes } from "~/lib/stripe/reads";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J63 (job_66a3ffa02214), rows U3 and U4: the live audit results page and a
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

const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", created: Math.floor(RAN_AT.getTime() / 1000) - 86_400, ...o }) as unknown as Stripe.Invoice;
const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;
const subscription = (o: Record<string, unknown>) =>
  ({
    status: "active",
    currency: "usd",
    customer: "cus_1",
    items: { data: [{ price: { unit_amount: 5_000, recurring: { interval: "month", interval_count: 1 } } }] },
    ...o,
  }) as unknown as Stripe.Subscription;
const cardSub = (customer: string, expMonth: number, expYear = 2026) =>
  subscription({ customer, default_payment_method: { card: { exp_month: expMonth, exp_year: expYear } } });

function inRouter(node: ReactElement, path = "/audit/results"): string {
  const Stub = createRoutesStub([{ path, Component: () => node }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [path] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const recovery = (run: AuditRunView, ctaState: CtaState = "unauthenticated", activeSequences: number | null = null) =>
  inRouter(createElement(AuditRecoverySection, { run, ctaState, activeSequences }));
const disputes = (run: AuditRunView, ctaState: CtaState = "unauthenticated", foxhoundWinRate: number | null = null) =>
  inRouter(createElement(AuditDisputesSection, { run, ctaState, foxhoundWinRate }));
const health = (run: AuditRunView, when: "live" | "stored" = "live", recoveryRatePct: number | null = null) =>
  inRouter(createElement(AuditHealthSection, { run, when, recoveryRatePct }));

describe("U3/U4: Revenue leaking now (AuditRecoverySection, ab6ec2c5)", () => {
  it("keeps Recova's heading and its line under it", () => {
    const t = text(recovery(viewOf()));
    expect(t).toContain("Revenue leaking now");
    expect(t).toContain("What your Stripe account is losing or about to lose.");
  });

  it("says None detected in this period. when nothing leaked, and draws no rows", () => {
    const t = text(recovery(viewOf()));
    expect(t).toContain("None detected in this period.");
    expect(t).not.toContain("Failed invoices");
    expect(t).not.toContain("Past-due subscriptions");
  });

  it("shows the decline breakdown only when an invoice failed", () => {
    const withExpiring = viewOf({ subscriptions: ok([cardSub("cus_1", 10)]) });
    const t = text(recovery(withExpiring));
    expect(t).toContain("Expiring cards");
    expect(t).not.toContain("Soft declines");
    expect(t).not.toContain("Unclassified declines");
  });

  it("names the breakdown rows as Recova does, its four first, then Foxhound's two", () => {
    const t = text(recovery(viewOf({ uncollectibleInvoices: ok([invoice({ amount_due: 1_000 })]) })));
    const order = ["Soft declines", "Expired cards", "Network errors", "Fraud flags", "Revoked authorizations", "Unclassified declines"];
    const at = order.map((label) => t.indexOf(label));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("says past-due subscriptions as Recova does, with no added clause", () => {
    const t = text(recovery(viewOf({ subscriptions: ok([subscription({ status: "past_due" })]) })));
    expect(t).toContain("Past-due subscriptions");
    expect(t).toContain("1 subscription");
    expect(t).not.toContain("next cycle");
  });

  it("draws the expiring-cards timeline with Enarratio, red on the peak month", () => {
    const run = viewOf({
      subscriptions: ok([cardSub("cus_1", 10), cardSub("cus_2", 11), cardSub("cus_3", 11), cardSub("cus_4", 12)]),
    });
    const html = recovery(run);
    expect(html).toContain("enarratio");
    // Recova's x-axis ticks are the month names; the text equivalent names
    // every month with its count.
    expect(text(html)).toContain("Nov 2026");
    expect(text(html)).toMatch(/Cards expiring by month: Oct 2026 1, Nov 2026 2, Dec 2026 1/);
  });

  it("draws no timeline when no card expires in the four months", () => {
    expect(recovery(viewOf())).not.toContain("Cards expiring by month");
  });

  it("says the Card Updater data is unavailable when its read failed, as Recova does", () => {
    const run = viewOf({
      uncollectibleInvoices: ok([invoice({ amount_due: 1_000 })]),
      cardUpdaterEvents: failedRead("events unavailable"),
    });
    expect(text(recovery(run))).toContain("Card Updater: data unavailable for the last 30 days.");
  });

  it("an anonymous visitor gets Recova's pitch and Connect Stripe to start, to /connect", () => {
    const html = recovery(viewOf());
    expect(text(html)).toContain("Recovery is free until we recover something. You pay 20% of what we recover.");
    expect(html).toMatch(/<a[^>]*href="\/connect"[^>]*>Connect Stripe to start<\/a>/);
  });

  it("a signed-in merchant gets View Recovery dashboard, because every account has Recovery", () => {
    const html = recovery(viewOf(), "active");
    expect(html).toMatch(/<a[^>]*href="\/recovery\/dashboard"[^>]*>View Recovery dashboard<\/a>/);
    expect(text(html)).not.toContain("Connect Stripe to start");
  });

  it("on a saved run, says how many failed payments are in recovery now, linked", () => {
    const run = viewOf({ uncollectibleInvoices: ok([invoice({ amount_due: 1_000 })]) });
    const html = recovery(run, "active", 3);
    expect(html).toContain('href="/recovery/payments?status=active"');
    expect(text(html)).toContain("3 are in active recovery sequences");
    expect(text(recovery(run, "active", 1))).toContain("1 is in active recovery sequences");
    expect(text(recovery(run, "active", 0))).not.toContain("active recovery sequences");
  });

  it("is a Capsomer panel, with Capsomer buttons", () => {
    const html = recovery(viewOf());
    expect(html).toContain("cap-panel");
    expect(html).toContain("cap-btn");
  });
});

describe("U3/U4: Disputes unmanaged (AuditDisputesSection, 6db9c3bc)", () => {
  it("is left off when every dispute figure is zero, as Recova's hasDisputeSignal does", () => {
    expect(showDisputesSection(viewOf())).toBe(false);
    expect(showDisputesSection(viewOf({ disputes: ok([dispute({ status: "won" })]) }))).toBe(true);
  });

  it("stays on the page when the disputes read failed, because unread is not zero", () => {
    expect(showDisputesSection(viewOf({ disputes: failedRead("rate limited") }))).toBe(true);
  });

  it("keeps Recova's second lines", () => {
    const noneLost = text(disputes(viewOf({ disputes: ok([dispute({ status: "needs_response", amount: 900 })]) })));
    expect(noneLost).toContain("No disputes forfeited by default");
    expect(noneLost).toContain("No closed disputes yet");

    const lost = text(
      disputes(
        viewOf({
          disputes: ok([
            dispute({ status: "lost", amount: 4_000, evidence_details: { submission_count: 0 } }),
            dispute({ status: "won", amount: 1_000 }),
            dispute({ status: "won", amount: 1_000 }),
          ]),
        }),
      ),
    );
    expect(lost).toContain("1 dispute lost with no evidence submitted");
    expect(lost).toContain("2 won, 1 lost");
    expect(lost).toContain("67% win rate");
  });

  it("shows Revenue left on the table, with copy true to Foxhound", () => {
    const t = text(
      disputes(
        viewOf({
          disputes: ok([dispute({ status: "lost", amount: 4_000, evidence_details: { submission_count: 0 } })]),
        }),
      ),
    );
    expect(t).toContain("Revenue left on the table");
    expect(t).toContain("$40");
    expect(t).toContain("Disputes you lost without submitting evidence.");
    expect(t).not.toContain("submits structured evidence automatically");
  });

  it("anonymous: the fee line from Foxhound's constants and Enable Disputes to /connect", () => {
    const html = disputes(viewOf({ disputes: ok([dispute({ status: "won" })]) }));
    expect(text(html)).toContain("Disputes is free until we win. You pay 20% of disputes we win");
    expect(html).toMatch(/<a[^>]*href="\/connect"[^>]*>Enable Disputes<\/a>/);
  });

  it("signed in: View Disputes dashboard, because every account has Disputes", () => {
    const html = disputes(viewOf({ disputes: ok([dispute({ status: "won" })]) }), "active");
    expect(html).toMatch(/<a[^>]*href="\/disputes\/dashboard"[^>]*>View Disputes dashboard<\/a>/);
  });

  it("a saved run shows Foxhound's own win rate against the historical one", () => {
    const run = viewOf({ disputes: ok([dispute({ status: "won" }), dispute({ status: "lost" })]) });
    const t = text(disputes(run, "active", 75));
    expect(t).toContain("Foxhound win rate: 75% vs your historical 50%");
    expect(text(disputes(run, "active", null))).not.toContain("Foxhound win rate");
  });
});

describe("U3/U4: Business snapshot (AuditHealthSection, 17828ab5)", () => {
  it("live: Recova's line, and None detected in this period. when every figure is zero", () => {
    const t = text(health(viewOf()));
    expect(t).toContain("Your recurring-revenue picture right now.");
    expect(t).toContain("None detected in this period.");
    expect(t).not.toContain("Active subscriptions");
  });

  it("stored: the line says when, because a saved run is not right now", () => {
    expect(text(health(viewOf(), "stored"))).toContain("Your recurring-revenue picture at the time of this run.");
  });

  it("closes with the Intelligence line, true to what Intelligence has", () => {
    const t = text(health(viewOf()));
    expect(t).toContain("Full trend history and cohort analysis available in Intelligence.");
    expect(t).not.toContain("forecasting");
  });

  it("a saved run shows the account's lifetime recovery rate when there is one", () => {
    const run = viewOf({ subscriptions: ok([subscription({})]) });
    const t = text(health(run, "stored", 42));
    expect(t).toContain("Recovery rate");
    expect(t).toContain("Lifetime recovered vs. failed");
    expect(t).toContain("42%");
    expect(text(health(run, "stored", null))).not.toContain("Recovery rate");
  });
});

// --- the two pages -----------------------------------------------------------

const resultsPage = await import("~/routes/audit/results");
const runPage = await import("~/routes/app/audit/run");
// Loaded leniently so a missing module fails an assertion, not the file.
const runsRedirect = await import("~/routes/audit/runs-redirect").catch(() => null);

type ResultsData = {
  run: AuditRunView;
  notSaved: "anonymous" | "not_your_account" | null;
  signedIn: boolean;
};

function renderResults(data: Partial<ResultsData>) {
  const loaderData: ResultsData = {
    run: viewOf(),
    notSaved: "anonymous",
    signedIn: false,
    ...data,
  };
  const Page = resultsPage.default as unknown as (p: { loaderData: ResultsData }) => ReactElement;
  return inRouter(createElement(Page, { loaderData }));
}

describe("U3: the live results page (app/audit/results/page.tsx, 9aad7745)", () => {
  it("heads What's next with Recova's apostrophe", () => {
    expect(text(renderResults({}))).toContain("What's next");
  });

  it("the run-at line is Recova's, without the Stripe account id", () => {
    const t = text(renderResults({}));
    expect(t).toMatch(/Run at Oct 10, 2026/);
    expect(t).not.toContain("acct_stripe_x");
  });

  it("a saved run offers View audit history only, as Recova does", () => {
    const html = renderResults({ signedIn: true, notSaved: null });
    expect(html).toMatch(/<a[^>]*href="\/audit\/dashboard"[^>]*>View audit history<\/a>/);
    expect(text(html)).not.toContain("Open this run");
  });

  it("the sections get the signed-in CTA state", () => {
    const html = renderResults({ signedIn: true, notSaved: null });
    expect(html).toContain('href="/recovery/dashboard"');
    expect(renderResults({})).toContain('href="/connect"');
  });

  it("is built from Capsomer's page head", () => {
    expect(renderResults({})).toContain("cap-page-head");
  });
});

describe("U4: a saved run at Recova's path, /audit/results/:id", () => {
  const routes = readFileSync(fileURLToPath(new URL("../app/routes.ts", import.meta.url)), "utf8");

  it("is routed at results/:id in the app shell", () => {
    expect(routes).toContain('route("results/:id", "./routes/app/audit/run.tsx")');
    expect(routes).not.toContain('route("runs/:id", "./routes/app/audit/run.tsx")');
  });

  it("the old /audit/runs/:id answers one 301 to the new path", () => {
    expect(runsRedirect, "app/routes/audit/runs-redirect.ts exists").not.toBeNull();
    const response = runsRedirect!.loader({
      request: new Request("https://foxhoundapp.test/audit/runs/run_9?x=1"),
      params: { id: "run_9" },
    } as never) as Response;
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/audit/results/run_9?x=1");
  });

  it("the history table and the monthly email link to the new path", () => {
    const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
    expect(read("app/routes/app/audit/dashboard.tsx")).toContain("/audit/results/${run.id}");
    expect(read("app/lib/audit/monthly.server.ts")).toContain("/audit/results/${runId}");
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

describe("U4: the saved run's page (app/audit/results/[id]/page.tsx, a0dbf6ef)", () => {
  it("keeps Recova's banner line and fades the sections in", () => {
    const Page = runPage.default as unknown as (p: { loaderData: unknown }) => ReactElement;
    const run = { ...viewOf(), id: "run_1" };
    const html = inRouter(
      createElement(Page, {
        loaderData: { run, activeSequences: 0, recoveryRatePct: null, foxhoundWinRate: null },
      }),
      "/audit/results/run_1",
    );
    const t = text(html);
    expect(t).toContain("This audit was run on Oct 10, 2026.");
    expect(t).toContain("Data reflects your Stripe account at that point in time.");
    expect(html).toMatch(/<a[^>]*href="\/audit\/dashboard"[^>]*>Back to history<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/audit\/connect"[^>]*>Run new audit<\/a>/);
    expect(html).toContain("audit-reveal");
    expect(html).toContain("cap-page-head");
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

const reads = await import("~/lib/stripe/reads");

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

  const stripe = fakeStripe({
    invoices: [fullInvoice({})],
    subscriptions: [fullSubscription({})],
    disputes: [fullDispute({})],
    events: [fullEvent()],
  });

  it("no full Stripe object is retained by any of the five reads", async () => {
    const outcomes = await Promise.all([
      reads.readUncollectibleInvoices(stripe, 0),
      reads.readOpenInvoices(stripe),
      reads.readSubscriptions(stripe),
      reads.readDisputes(stripe),
      reads.readCardUpdaterEvents(stripe, 0),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      const kept = JSON.stringify(outcome.ok ? outcome.data : null);
      expect(kept, "a field the engine never reads was kept").not.toContain(BULK.slice(0, 100));
      expect(kept).not.toContain('"id":');
      expect(kept).not.toContain('"object":');
    }
  });

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

  it("the old ceiling and its flag are gone", () => {
    expect("AUDIT_READ_SOFT_LIMIT" in reads).toBe(false);
    const source = readFileSync(fileURLToPath(new URL("../app/lib/stripe/reads.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("overLimit");
    expect(source).not.toContain("soft ceiling");
  });
});

describe("Review round 1, must-fix 2 and nits", () => {
  it("the Intelligence line keeps Recova's trend history and cohort analysis", () => {
    expect(text(health(viewOf()))).toContain("Full trend history and cohort analysis available in Intelligence.");
  });

  it("an unread figure says which figure it is", () => {
    const t = text(recovery(viewOf({ subscriptions: failedRead("subs unavailable") })));
    expect(t).toContain("Expiring cards (through next month) Could not be read on this run.");
    expect(t).toContain("Past-due subscriptions Could not be read on this run.");
    expect(text(disputes(viewOf({ disputes: failedRead("x") })))).toContain("Disputes Could not be read on this run.");
    expect(text(health(viewOf({ subscriptions: failedRead("x") })))).toContain("Subscriptions Could not be read on this run.");
  });

  it("one rule for the middle band: the win rate takes the recovery rate's caution colour", () => {
    const run = viewOf({ disputes: ok([dispute({ status: "won" })]) });
    expect(disputes(run, "active", 60)).toMatch(/<span class="[^"]*text-caution[^"]*">60%/);
  });

  it("the live loader returns only what the page renders", () => {
    const source = readFileSync(fileURLToPath(new URL("../app/routes/audit/results.tsx", import.meta.url)), "utf8");
    const returned = source.slice(source.indexOf("  return {\n    run: toAuditRunView"));
    const block = returned.slice(0, returned.indexOf("};"));
    expect(block).not.toContain("stripeAccountId");
    expect(block).not.toContain("runId");
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
