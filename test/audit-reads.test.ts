import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";

import {
  readCardUpdaterEvents,
  readDisputes,
  readOpenInvoices,
  readSubscriptions,
  readUncollectibleInvoices,
} from "~/lib/stripe/reads";

// The audit's Stripe reads. Every read pages to the end (legacy walked one page of
// 100 and audited the first hundred rows with no sign of the rest), and its rows
// are narrowed to what the engine reads.

/** A fake Stripe list: an async iterable that yields `count` items across as
 *  many pages as the SDK would, which is exactly what `for await` consumes. */
function fakeList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function throwingList(message: string): AsyncIterable<never> {
  return {
    // oxlint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw new Error(message);
    },
  };
}

const stripeWith = (lists: Record<string, unknown>) => lists as unknown as Stripe;

describe("every read answers, and a failure is data", () => {
  const stripe = stripeWith({
    invoices: {
      list: () =>
        fakeList([
          { id: "in_1", amount_due: 100 },
          { id: "in_2", amount_due: 200 },
        ]),
    },
    subscriptions: { list: () => fakeList([{ id: "sub_1", status: "active" }]) },
    disputes: { list: () => fakeList([{ id: "dp_1", status: "won" }]) },
    events: { list: () => fakeList([{ id: "evt_1" }, { id: "evt_2" }]) },
  });

  it("all five succeed and carry their rows", async () => {
    const invoices = await readUncollectibleInvoices(stripe, 0);
    expect(invoices.ok && invoices.data.map((i) => i.amount_due)).toEqual([100, 200]);
    const open = await readOpenInvoices(stripe);
    expect(open.ok && open.data).toHaveLength(2);
    const subs = await readSubscriptions(stripe);
    expect(subs.ok && subs.data.map((s) => s.status)).toEqual(["active"]);
    const disputes = await readDisputes(stripe);
    expect(disputes.ok && disputes.data.map((d) => d.status)).toEqual(["won"]);
    const events = await readCardUpdaterEvents(stripe, 0);
    expect(events.ok && events.data).toHaveLength(2);
  });

  it("a failure names the read", async () => {
    const broken = stripeWith({ events: { list: () => throwingList("boom") } });
    const outcome = await readCardUpdaterEvents(broken, 0);
    expect(outcome.ok === false && outcome.reason).toContain("card updater events");
  });
});

describe("the arguments each read sends", () => {
  it("each read passes legacy's filters, and subscriptions expand the payment method", async () => {
    const calls: Record<string, unknown> = {};
    const spy = (name: string) => (params: unknown) => {
      calls[name] = params;
      return fakeList([]);
    };
    const stripe = stripeWith({
      invoices: { list: spy("invoices") },
      subscriptions: { list: spy("subscriptions") },
      disputes: { list: spy("disputes") },
      events: { list: spy("events") },
    });

    await readUncollectibleInvoices(stripe, 1_700_000_000);
    expect(calls.invoices).toEqual({
      status: "uncollectible",
      created: { gte: 1_700_000_000 },
      limit: 100,
    });

    await readSubscriptions(stripe);
    // `status: "all"` where the expiring-card cron uses "active", because
    // past-due and canceled subscriptions are two of the audit's six scopes.
    // Same call, same expansion, one parameter apart.
    expect(calls.subscriptions).toEqual({
      status: "all",
      limit: 100,
      expand: [
        "data.default_payment_method",
        "data.customer.invoice_settings.default_payment_method",
      ],
    });

    await readCardUpdaterEvents(stripe, 1_700_000_000);
    // ONE event name. Legacy's own comment is the citation: the historical
    // names are no longer emitted, so a fallback would imply coverage that does
    // not exist.
    expect(calls.events).toEqual({
      type: "payment_method.automatically_updated",
      created: { gte: 1_700_000_000 },
      limit: 100,
    });
  });
});

describe("paging and narrowing", () => {
  const RAN_AT = new Date("2026-10-10T09:00:00.000Z");
  const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
  const listOf = (items: unknown[]) => () => fakeList(items);
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => info.mockRestore());

  it("reads every dispute past the old soft ceiling and logs the count", async () => {
    const items = Array.from({ length: 2_010 }, (_, i) => ({ id: `dp_${i}` }));
    const outcome = await readDisputes(stripeWith({ disputes: { list: listOf(items) } }));
    expect(outcome.ok && outcome.data.length).toBe(2_010);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("disputes: 2010 rows"));
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
    default_payment_method: {
      id: "pm_1",
      card: { exp_month: 11, exp_year: 2026, brand: "visa" },
      billing_details: { address: BULK },
    },
    items: {
      data: [
        {
          id: "si_1",
          price: {
            unit_amount: 7_000,
            recurring: { interval: "month", interval_count: 1 },
            product: { description: BULK },
          },
        },
      ],
    },
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

  const fullEvent = () => ({
    id: "evt_1",
    object: "event",
    type: "payment_method.automatically_updated",
    created: 1,
    data: { object: { note: BULK } },
  });

  it("the engine's answer from the narrowed rows is the answer from the full objects", async () => {
    const invoices = [
      fullInvoice({}),
      fullInvoice({ id: "in_2", last_finalization_error: null, last_payment_error: null }),
    ];
    const subscriptions = [
      fullSubscription({}),
      fullSubscription({ status: "past_due", customer: "cus_8" }),
      fullSubscription({
        status: "canceled",
        canceled_at: Math.floor(RAN_AT.getTime() / 1000) - 10,
        cancellation_details: { reason: "cancellation_requested" },
      }),
    ];
    const disputes = [fullDispute({}), fullDispute({ status: "needs_response", amount: 900 })];
    const events = [fullEvent()];
    // The fake invoices list ignores the status filter, so each invoice read
    // returns both; the full-object input is built the same way.
    const full = {
      uncollectibleInvoices: ok(invoices as unknown as Stripe.Invoice[]),
      openInvoices: ok(invoices as unknown as Stripe.Invoice[]),
      subscriptions: ok(subscriptions as unknown as Stripe.Subscription[]),
      disputes: ok(disputes as unknown as Stripe.Dispute[]),
      cardUpdaterEvents: ok(events as unknown as Stripe.Event[]),
    };
    const stripe = stripeWith({
      invoices: { list: listOf(invoices) },
      subscriptions: { list: listOf(subscriptions) },
      disputes: { list: listOf(disputes) },
      events: { list: listOf(events) },
    });
    const { collectAuditInputs } = await import("~/lib/audit/run.server");
    const narrowed = await collectAuditInputs(stripe, 90, RAN_AT);
    const run = (reads: AuditInputs) =>
      runAudit({ stripeAccountId: "acct_x", lookbackDays: 90, ranAt: RAN_AT, reads });
    const a = run(full);
    expect(run(narrowed)).toEqual(a);
    // The fixture exercised the fields, so equality means something.
    expect(a.failedInvoices.ok && a.failedInvoices.data.byCategory.expired).toBeGreaterThan(0);
    expect(a.expiringCards.ok && a.expiringCards.data.count).toBe(1);
    expect(a.health.ok && a.health.data.voluntaryChurnRateBps).toBeGreaterThan(0);
    expect(a.meta.currency).toBe("eur");
  });

  it("files an invoice under its charge's decline, not unknown, on the pinned API version", async () => {
    // What Stripe sends now: no charge, no last_payment_error on the invoice.
    const bare = fullInvoice({
      last_finalization_error: null,
      last_payment_error: null,
      charge: undefined,
    });
    const stripe = stripeWith({
      invoices: { list: listOf([bare]) },
      subscriptions: { list: listOf([]) },
      disputes: { list: listOf([]) },
      events: { list: listOf([]) },
      invoicePayments: { list: listOf([{ created: 1, payment: { payment_intent: "pi_1" } }]) },
      paymentIntents: {
        retrieve: async () => ({
          last_payment_error: { decline_code: "expired_card" },
          latest_charge: { failure_code: "card_declined" },
        }),
      },
    });
    const { collectAuditInputs } = await import("~/lib/audit/run.server");
    const reads = await collectAuditInputs(stripe, 90, RAN_AT);
    const result = runAudit({ stripeAccountId: "acct_x", lookbackDays: 90, ranAt: RAN_AT, reads });
    expect(
      result.failedInvoices.ok && result.failedInvoices.data.byCategory.expired,
    ).toBeGreaterThan(0);
  });
});
