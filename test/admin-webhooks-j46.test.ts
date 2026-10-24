
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { webhookEvents } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J46 (job_3a2f6b48fb65): /admin/webhooks on the family admin pattern
// (Capsomer patterns, Dustin's Q9 of 2026-10-14) and his 2026-10-11 admin
// review, with Recova's webhook log (app/admin/platform/webhooks/page.tsx and
// WebhookLogClient.tsx, blobs b0aaed26 and b0fcce84) read as the inventory:
// an event-type filter, an errors-only toggle, the account column, the payload
// opened in place and 50 events a page. Foxhound's three health figures stay.
// Filtering and paging are the loader's, from the address, so the list works
// without script and a filtered page can be linked to.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route: Record<string, unknown> = await import("~/routes/admin/webhooks");
// Looked up so a missing export fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const serverLib: Record<string, unknown> = await import("~/lib/admin/webhooks.server");
const pageLib: Record<string, unknown> = await import("~/lib/admin/webhooks").catch(() => ({}));

const NOW = Date.now();
const MIN = 60 * 1000;

interface Filters {
  type: string;
  errorsOnly: boolean;
  pendingOnly: boolean;
  page: number;
}
interface EventRow {
  id: string;
  eventType: string;
  accountId: string | null;
  receivedAt: Date;
  processed: boolean;
  errorMessage: string | null;
  payload: unknown;
}
interface ListResult {
  events: EventRow[];
  total: number;
  page: number;
  pageCount: number;
}

function parse(params: string): Filters {
  expect(typeof pageLib.parseWebhookFilters).toBe("function");
  return (pageLib.parseWebhookFilters as (p: URLSearchParams) => Filters)(new URLSearchParams(params));
}

async function list(db: unknown, filters: Partial<Filters>): Promise<ListResult> {
  expect(typeof serverLib.listWebhookEvents).toBe("function");
  const full: Filters = { type: "", errorsOnly: false, pendingOnly: false, page: 1, ...filters };
  return (serverLib.listWebhookEvents as (db: unknown, f: Filters) => Promise<ListResult>)(db, full);
}

/** 120 events, newest first by index: every third an error, every fifth an
 *  unknown account, every seventh still waiting. Types rotate through three. */
async function seed(n = 120) {
  const { db } = createInMemoryDb();
  const types = ["invoice.payment_failed", "Charge.Dispute.Created", "customer.subscription.updated"];
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `we_${String(i).padStart(3, "0")}`,
    stripeEventId: `evt_${i}`,
    eventType: types[i % 3],
    receivedAt: new Date(NOW - i * MIN),
    accountId: i % 5 === 0 ? null : `acct_${i % 4}`,
    processed: i % 7 !== 0,
    errorMessage: i % 3 === 1 ? `boom ${i}` : null,
    payload: { id: `evt_${i}`, type: types[i % 3], data: { object: { amount: i } } },
  }));
  await db.insert(webhookEvents).values(rows);
  return db;
}

describe("the filters come from the address", () => {
  it("reads the type, the two toggles and the page", () => {
    expect(parse("")).toEqual({ type: "", errorsOnly: false, pendingOnly: false, page: 1 });
    expect(parse("type=%20Invoice%20&errors=1&pending=1&page=3")).toEqual({
      type: "Invoice",
      errorsOnly: true,
      pendingOnly: true,
      page: 3,
    });
  });

  it("falls back to page 1 for a page that is not a whole positive number", () => {
    for (const p of ["0", "-2", "abc", "1.5", "", "1e3"]) expect(parse(`page=${p}`).page, p).toBe(1);
  });

  it("builds the link to a page with the filters kept and the defaults left out", () => {
    expect(typeof pageLib.webhookListHref).toBe("function");
    const href = pageLib.webhookListHref as (f: Filters, page: number) => string;
    expect(href({ type: "", errorsOnly: false, pendingOnly: false, page: 4 }, 1)).toBe("/admin/platform/webhooks");
    expect(href({ type: "invoice paid", errorsOnly: true, pendingOnly: false, page: 1 }, 2)).toBe(
      "/admin/platform/webhooks?type=invoice+paid&errors=1&page=2",
    );
    expect(href({ type: "", errorsOnly: false, pendingOnly: true, page: 1 }, 1)).toBe("/admin/platform/webhooks?pending=1");
  });
});

describe("listWebhookEvents", () => {

  it("keeps the page inside its bounds", async () => {
    const db = await seed();
    const past = await list(db, { page: 99 });
    expect(past.page).toBe(3);
    expect(past.events[0].id).toBe("we_100");
    expect((await list(db, { page: 0 })).page).toBe(1);
  });

  it("filters through Drizzle's like, where a typed wildcard only widens the match", async () => {
    const db = await seed();
    expect((await list(db, { type: "payment%failed" })).total).toBe(40);
    expect((await list(db, { type: "no.such.event" })).total).toBe(0);
  });

  it("shows only the events with an error, or only the waiting ones, and both together", async () => {
    const db = await seed();
    const errors = await list(db, { errorsOnly: true });
    expect(errors.total).toBe(40);
    expect(errors.events.every((e) => e.errorMessage !== null)).toBe(true);

    const pending = await list(db, { pendingOnly: true });
    expect(pending.total).toBe(18);
    expect(pending.events.every((e) => !e.processed)).toBe(true);

    const both = await list(db, { errorsOnly: true, pendingOnly: true, type: "dispute" });
    expect(both.events.every((e) => e.errorMessage !== null && !e.processed && /dispute/i.test(e.eventType))).toBe(true);
    expect(both.total).toBe(both.events.length);
  });
});

describe("the loader", () => {
  beforeEach(async () => {
    harness.db = await seed();
  });

  async function load(search: string) {
    expect(typeof route.loader).toBe("function");
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
    const loader = route.loader as (args: unknown) => Promise<Record<string, unknown>>;
    return loader({ request: new Request(`https://foxhoundapp.com/admin/webhooks${search}`), context, params: {} });
  }

  it("filters and pages from the address and keeps the health figures", async () => {
    const data = await load("?type=invoice&errors=1&page=1");
    const events = data.list as ListResult;
    expect(events.total).toBe(events.events.length);
    expect(events.events.every((e) => e.eventType === "invoice.payment_failed" && e.errorMessage)).toBe(true);
    expect(data.filters).toEqual({ type: "invoice", errorsOnly: true, pendingOnly: false, page: 1 });
    expect(data.summary).toEqual({ totalLast24h: 120, errorsLast24h: 40, unprocessedCount: 18 });
  });
});
