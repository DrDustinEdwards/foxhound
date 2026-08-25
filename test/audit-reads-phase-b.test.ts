import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  AUDIT_READ_SOFT_LIMIT,
  collectPaginated,
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

describe("PLANT 1: the walk is paginated and bounded", () => {
  it("collects every page rather than the first one", async () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const result = await collectPaginated(fakeList(items));
    // 250 is past legacy's single page of 100 and inside the soft ceiling.
    expect(result.items).toHaveLength(250);
    expect(result.overLimit).toBe(false);
  });

  it("stops at the soft ceiling and SAYS SO, rather than truncating silently", async () => {
    const items = Array.from({ length: AUDIT_READ_SOFT_LIMIT + 10 }, (_, i) => i);
    const result = await collectPaginated(items && fakeList(items));
    expect(result.items).toHaveLength(AUDIT_READ_SOFT_LIMIT);
    expect(result.overLimit).toBe(true);
  });

  it("an empty list is not over the limit, which an off-by-one would get wrong", async () => {
    expect(await collectPaginated(fakeList([]))).toEqual({ items: [], overLimit: false });
  });
});

describe("PLANT 2: every read answers, and a failure is data", () => {
  const stripe = stripeWith({
    invoices: { list: () => fakeList([{ id: "in_1" }]) },
    subscriptions: { list: () => fakeList([{ id: "sub_1" }]) },
    disputes: { list: () => fakeList([{ id: "dp_1" }]) },
    events: { list: () => fakeList([{ id: "evt_1" }]) },
  });

  it("all five succeed and carry their rows", async () => {
    expect(await readUncollectibleInvoices(stripe, 0)).toEqual({ ok: true, data: [{ id: "in_1" }] });
    expect(await readOpenInvoices(stripe)).toEqual({ ok: true, data: [{ id: "in_1" }] });
    expect(await readSubscriptions(stripe)).toEqual({ ok: true, data: [{ id: "sub_1" }] });
    expect(await readDisputes(stripe)).toEqual({ ok: true, data: [{ id: "dp_1" }] });
    expect(await readCardUpdaterEvents(stripe, 0)).toEqual({ ok: true, data: [{ id: "evt_1" }] });
  });

  it("A THROWN READ BECOMES ok:false WITH A REASON, never an exception", async () => {
    const broken = stripeWith({ disputes: { list: () => throwingList("rate limited") } });
    const outcome = await readDisputes(broken);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe(
      "Could not read disputes from Stripe: rate limited",
    );
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
    // past-due and cancelled subscriptions are two of the audit's six scopes.
    // Same call, same expansion, one parameter apart.
    expect(calls.subscriptions).toEqual({
      status: "all",
      limit: 100,
      expand: ["data.default_payment_method"],
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


describe("PLANT 4: NO STRIPE LIST ANYWHERE IS WALKED AS A BARE PAGE", () => {
  const root = fileURLToPath(new URL("../app/lib", import.meta.url));
  const LIST_CALL = /\w+\.(invoices|subscriptions|disputes|events|customers|charges)\.list\(/g;

  /** Every Stripe collection `.list(` call under app/lib, with the file it sits
   *  in and the 200 characters before it, comments stripped first so an
   *  assertion cannot pass or fail on prose (352 binding 5). */
  function listCallSites(): { file: string; before: string; call: string }[] {
    const sites: { file: string; before: string; call: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const source = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n");
        for (const match of source.matchAll(LIST_CALL)) {
          sites.push({
            file: full.slice(root.length + 1).split("\\").join("/"),
            before: source.slice(Math.max(0, match.index - 200), match.index),
            call: match[0],
          });
        }
      }
    };
    walk(root);
    return sites;
  }

  it("outside the reads module, every list call is walked with for await", () => {
    // Legacy broke this rule five times in one function. Derived from the tree,
    // so a read added later joins the rule without anybody remembering to.
    const offenders = listCallSites()
      .filter((site) => site.file !== "stripe/reads.ts")
      .filter((site) => !/for await[^;]*$/.test(site.before))
      .map((site) => `${site.file} :: ${site.call}`);
    expect(offenders).toEqual([]);
  });

  it("inside the reads module, every list call goes through the ONE bounded walk", () => {
    // Not a context sniff. The module is asserted to have exactly one place that
    // consumes a list, and every reader is asserted to delegate to it.
    const source = readFileSync(`${root}/stripe/reads.ts`, "utf8");
    const inModule = listCallSites().filter((site) => site.file === "stripe/reads.ts");
    expect(inModule).toHaveLength(5);
    for (const site of inModule) {
      expect(site.before, `${site.call} is not inside read()`).toMatch(/return read\([\s\S]*=>\s*$/);
    }
    expect(source).toContain("for await (const item of list)");
    // ONE call site for the walk, and it is inside read(). The declaration
    // carries a type parameter so it does not match this, which is what makes
    // the count a count of CALLERS rather than of mentions.
    expect(source.match(/collectPaginated\(/g) ?? []).toHaveLength(1);
    expect(source).toContain("await collectPaginated(list())");
  });

  it("the sweep really found list calls, so an empty offender list means something", () => {
    // 259's data-dependent zero: "no offenders" and "nothing was read" look
    // identical without this.
    expect(listCallSites().length).toBeGreaterThanOrEqual(6);
  });
});
