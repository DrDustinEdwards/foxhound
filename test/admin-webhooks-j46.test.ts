import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { webhookEvents, type Db } from "~/db";
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
const WebhooksPage = route.default as (props: unknown) => React.ReactNode;
// Looked up so a missing export fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const serverLib: Record<string, unknown> = await import("~/lib/admin/webhooks.server");
const pageLib: Record<string, unknown> = await import("~/lib/admin/webhooks").catch(() => ({}));

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
    expect(href({ type: "", errorsOnly: false, pendingOnly: false, page: 4 }, 1)).toBe("/admin/webhooks");
    expect(href({ type: "invoice paid", errorsOnly: true, pendingOnly: false, page: 1 }, 2)).toBe(
      "/admin/webhooks?type=invoice+paid&errors=1&page=2",
    );
    expect(href({ type: "", errorsOnly: false, pendingOnly: true, page: 1 }, 1)).toBe("/admin/webhooks?pending=1");
  });
});

describe("listWebhookEvents", () => {
  it("pages 50 events at a time, newest first, and counts them all", async () => {
    const db = await seed();
    const first = await list(db, {});
    expect(first.total).toBe(120);
    expect(first.pageCount).toBe(3);
    expect(first.page).toBe(1);
    expect(first.events).toHaveLength(50);
    expect(first.events[0].id).toBe("we_000");
    expect(first.events[49].id).toBe("we_049");

    const last = await list(db, { page: 3 });
    expect(last.events.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => `we_${100 + i}`));
  });

  it("keeps the page inside its bounds", async () => {
    const db = await seed();
    const past = await list(db, { page: 99 });
    expect(past.page).toBe(3);
    expect(past.events[0].id).toBe("we_100");
    expect((await list(db, { page: 0 })).page).toBe(1);
  });

  it("matches the event type as a substring, in any case", async () => {
    const db = await seed();
    const r = await list(db, { type: "DISPUTE" });
    expect(r.total).toBe(40);
    expect(r.events.every((e) => e.eventType === "Charge.Dispute.Created")).toBe(true);
    expect((await list(db, { type: "payment_f" })).total).toBe(40);
  });

  it("takes the user's text literally, not as a pattern", async () => {
    const db = await seed();
    expect((await list(db, { type: "%" })).total).toBe(0);
    expect((await list(db, { type: "payment%failed" })).total).toBe(0);
    expect((await list(db, { type: "invoice_payment" })).total).toBe(0);
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

  it("says one page of nothing when nothing matches", async () => {
    const db = await seed();
    expect(await list(db, { type: "no.such.event" })).toEqual({ events: [], total: 0, page: 1, pageCount: 1 });
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

  it("serves page two of the whole log", async () => {
    const data = await load("?page=2");
    const events = data.list as ListResult;
    expect(events.page).toBe(2);
    expect(events.events[0].id).toBe("we_050");
  });
});

// ---------------------------------------------------------------- the page

function event(i: number, over: Partial<EventRow> = {}): EventRow {
  return {
    id: `we_${i}`,
    eventType: "invoice.payment_failed",
    accountId: "acct_north",
    receivedAt: new Date(NOW - i * HOUR),
    processed: true,
    errorMessage: null,
    payload: { id: `evt_${i}`, object: "event", livemode: false },
    ...over,
  };
}

const DEFAULT_FILTERS: Filters = { type: "", errorsOnly: false, pendingOnly: false, page: 1 };

function render(over: { events?: EventRow[]; total?: number; page?: number; pageCount?: number; filters?: Partial<Filters> } = {}) {
  const events = over.events ?? [event(1), event(2, { errorMessage: "No such customer", accountId: null }), event(3, { processed: false })];
  const data = {
    summary: { totalLast24h: 12, errorsLast24h: 2, unprocessedCount: 1 },
    list: { events, total: over.total ?? events.length, page: over.page ?? 1, pageCount: over.pageCount ?? 1 },
    filters: { ...DEFAULT_FILTERS, ...over.filters },
  };
  const Stub = createRoutesStub([
    {
      path: "/admin/webhooks",
      Component: () => createElement(WebhooksPage as never, { loaderData: data } as never),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/webhooks"] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

describe("the Webhooks page", () => {
  it("keeps the three health figures, each a link to the events behind it", () => {
    const html = render();
    const t = text(html);
    expect(t).toMatch(/12 Received/);
    expect(t).toMatch(/2 Errors/);
    expect(t).toMatch(/1 Unprocessed/);
    expect(html).toMatch(/href="\/admin\/webhooks\?errors=1"/);
    expect(html).toMatch(/href="\/admin\/webhooks\?pending=1"/);
  });

  it("is a captioned table with sentence-case column names and the account column", () => {
    const html = render();
    expect(html).toMatch(/<caption[^>]*>[^<]*webhook events/i);
    const headers = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(headers).toEqual(["Event type", "Account", "Status", "Received", "Error"]);
    expect(html).not.toMatch(/\buppercase\b|\btracking-/);
  });

  it("links a known account to its merchant page and says so when there is none", () => {
    const html = render();
    expect(html).toContain('href="/admin/merchants/acct_north"');
    expect(text(html)).toContain("No account");
  });

  it("says each event's status in a word with its shape", () => {
    const t = text(render());
    expect(t).toContain("Processed");
    expect(t).toContain("Error");
    expect(t).toContain("Pending");
    expect(t).toContain("No such customer");
  });

  it("opens each payload in place from a real button wired to its row", () => {
    const html = render();
    const buttons = [...html.matchAll(/<button[^>]*aria-expanded="false"[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b).toMatch(/type="button"/);
      const controls = /aria-controls="([^"]+)"/.exec(b)?.[1];
      expect(controls).toBeTruthy();
      // The row it controls is in the table, hidden until opened, across every column.
      const row = new RegExp(`<tr[^>]*id="${controls!.replace(/[:]/g, "\\$&")}"[^>]*hidden`).exec(html);
      expect(row, controls).not.toBeNull();
    }
    expect(text(html)).toMatch(/invoice\.payment_failed payload/);
  });

  it("pretty-prints the payload inside the hidden row", () => {
    const html = render({ events: [event(1)] });
    expect(html).toMatch(/<pre[^>]*>\{\n {2}&quot;id&quot;: &quot;evt_1&quot;,/);
    expect(html).toMatch(/<td[^>]*colSpan="5"|<td[^>]*colspan="5"/);
  });

  it("has a labelled event-type field and two labelled toggles in a GET form", () => {
    const html = render({ filters: { type: "invoice", errorsOnly: true } });
    expect(html).toMatch(/<form[^>]*method="get"/i);
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Event type<\/label>/);
    expect(html).toMatch(/<input[^>]*name="type"[^>]*value="invoice"/);
    const box = (name: string) => new RegExp(`<input[^>]*type="checkbox"[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(box("errors")).toMatch(/value="1"/);
    expect(box("errors")).toMatch(/\bchecked/);
    expect(box("pending")).toMatch(/value="1"/);
    expect(box("pending")).not.toMatch(/\bchecked/);
    expect(text(html)).toContain("Errors only");
    expect(text(html)).toContain("Pending only");
  });

  it("says the count in words", () => {
    expect(text(render({ total: 120, events: [event(1)], pageCount: 3 }))).toContain("120 events");
    expect(text(render({ total: 1, events: [event(1)] }))).toContain("1 event");
  });

  it("tells an empty log from a filter that matched nothing", () => {
    const empty = text(render({ events: [], total: 0 }));
    expect(empty).toContain("No webhook events recorded yet.");
    expect(empty).not.toContain("No events match this filter.");

    const noMatch = render({ events: [], total: 0, filters: { type: "nothing" } });
    expect(text(noMatch)).toContain("No events match this filter.");
    expect(noMatch).toMatch(/href="\/admin\/webhooks"[^>]*>[^<]*Clear/);
  });

  it("pages with links that keep the filters", () => {
    const html = render({ total: 120, page: 2, pageCount: 3, events: [event(1)], filters: { type: "invoice", page: 2 } });
    expect(html).toMatch(/<nav[^>]*aria-label="Webhook event pages"/);
    expect(html).toContain('href="/admin/webhooks?type=invoice"');
    expect(html).toContain('href="/admin/webhooks?type=invoice&amp;page=3"');
    expect(text(html)).toContain("Page 2 of 3");
  });

  it("has no pager for a single page", () => {
    expect(render()).not.toMatch(/aria-label="Webhook event pages"/);
  });
});

describe("the page source", () => {
  const source = readFileSync("app/routes/admin/webhooks.tsx", "utf8");

  it("has no amber, no hand-sized text and no heading of its own", () => {
    expect(source).not.toMatch(/amber|orange|warning-text|tone="warn"/);
    expect(source).not.toMatch(/text-\[/);
    expect(source).not.toMatch(/<h1\b/);
  });

  it("marks its lists busy while they are read again", () => {
    expect(source).toMatch(/pagePending\(/);
    expect(source).toMatch(/aria-busy=/);
  });

  it("reads through the data layer, never the webhook engine", () => {
    expect(source).not.toMatch(/~\/lib\/webhooks\//);
    expect(readFileSync("app/lib/admin/webhooks.server.ts", "utf8")).not.toMatch(/~\/lib\/webhooks\//);
  });
});

describe("the admin API's health read is unchanged", () => {
  it("getWebhookHealthSummary still counts the last day and the waiting events", async () => {
    const db = (await seed()) as Db;
    const summary = await (serverLib.getWebhookHealthSummary as (db: Db) => Promise<unknown>)(db);
    expect(summary).toEqual({ totalLast24h: 120, errorsLast24h: 40, unprocessedCount: 18 });
    await db.insert(webhookEvents).values({
      id: "we_old",
      stripeEventId: "evt_old",
      eventType: "invoice.paid",
      receivedAt: new Date(NOW - 2 * DAY),
      processed: true,
      errorMessage: "old",
      payload: {},
    });
    expect(await (serverLib.getWebhookHealthSummary as (db: Db) => Promise<unknown>)(db)).toEqual(summary);
  });

  it("the handler still imports it", () => {
    expect(readFileSync("app/lib/admin-api/handler.server.ts", "utf8")).toMatch(
      /import \{ getWebhookHealthSummary \} from "~\/lib\/admin\/webhooks.server";/,
    );
  });
});
