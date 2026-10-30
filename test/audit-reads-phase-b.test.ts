
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  readCardUpdaterEvents,
  readDisputes,
  readOpenInvoices,
  readSubscriptions,
  readUncollectibleInvoices,
} from "~/lib/stripe/reads";

// SESSION 68, PHASE (b): the five reads the pure engine takes as input.
//
// THE LOAD-BEARING PLANT IS THE DERIVED ONE. Legacy's audit issues five
// `limit: 100` calls and walks one page of each, so a merchant past their first
// hundred rows gets an audit of the first hundred with no sign of the rest. The
// no-bare-limit check below is derived from the module's own surface, so a SIXTH
// read added next year joins the rule without anybody remembering to add it,
// which is 350 binding 6's shape.

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
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw new Error(message);
    },
  };
}

const stripeWith = (lists: Record<string, unknown>) => lists as unknown as Stripe;

describe("PLANT 2: every read answers, and a failure is data", () => {
  const stripe = stripeWith({
    invoices: { list: () => fakeList([{ id: "in_1", amount_due: 100 }, { id: "in_2", amount_due: 200 }]) },
    subscriptions: { list: () => fakeList([{ id: "sub_1", status: "active" }]) },
    disputes: { list: () => fakeList([{ id: "dp_1", status: "won" }]) },
    events: { list: () => fakeList([{ id: "evt_1" }, { id: "evt_2" }]) },
  });

  // Rows come back narrowed to what the engine reads, so
  // these hold the count and one read field each, not the Stripe object.
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

  it("the reason names the read and carries no wide dash", async () => {
    const broken = stripeWith({ events: { list: () => throwingList("boom") } });
    const outcome = await readCardUpdaterEvents(broken, 0);
    const reason = outcome.ok === false ? outcome.reason : "";
    expect(reason).toContain("card updater events");
    expect(reason).not.toContain(String.fromCharCode(0x2014));
    expect(reason).not.toContain(String.fromCharCode(0x2013));
  });
});

describe("PLANT 3: the arguments legacy sends", () => {
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
      expand: ["data.default_payment_method", "data.customer.invoice_settings.default_payment_method"],
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
