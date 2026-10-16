import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, adminAuditLog } from "~/db";
import { PAUSE_REASON_BRAKE, PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J50 (job_53a17d86a49e, rows D5 and D6): Recova's two merchant lists,
// app/admin/merchants/billing-exempt/page.tsx (blob a0c4f9da) and
// app/admin/merchants/paused/page.tsx (blob 43b1cf35), with their one action
// each through MerchantToggle.tsx (blob 48c57535): "Remove exemption" and
// "Resume". Built on the family admin pattern (Dustin's Q9 of 2026-10-14) as
// filters of the Merchants page: Capsomer's links form of tabs ("the better
// default for admin filters", tabs.md), each filter its own address, at
// Recova's own addresses. Every write goes through the Merchants page's own
// action and writers (PRs 140 and 142), so Undo, the brake guard and the
// audit row come with them.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Looked up so a missing export fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const pageLib: Record<string, unknown> = await import("~/lib/admin/merchants");
const pausedRoute: Record<string, unknown> = await import("~/routes/admin/merchants/paused").catch(() => ({}));
const exemptRoute: Record<string, unknown> = await import("~/routes/admin/merchants/billing-exempt").catch(() => ({}));
const indexRoute: Record<string, unknown> = await import("~/routes/admin/merchants/index");

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo);
const ACTOR = "admin@example.com";

type Seeded = ReturnType<typeof createInMemoryDb>;

async function seed(): Promise<Seeded> {
  const made = createInMemoryDb();
  await made.db.insert(accounts).values([
    { id: "acct_north", name: "Northwind Coffee", createdAt: at(40 * DAY) },
    { id: "acct_lumen", name: "Lumen Studio", createdAt: at(30 * DAY), billingExempt: true },
    { id: "acct_pets", name: "Paused Pets", createdAt: at(20 * DAY), processingPaused: true, pauseReason: PAUSE_REASON_MANUAL },
    { id: "acct_brake", name: "Brake Bikes", createdAt: at(10 * DAY), processingPaused: true, pauseReason: PAUSE_REASON_BRAKE },
    { id: "acct_both", name: "Both Books", createdAt: at(5 * DAY), processingPaused: true, pauseReason: PAUSE_REASON_MANUAL, billingExempt: true },
  ]);
  return made;
}

function context() {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
  c.set(adminContext, { email: ACTOR });
  return c;
}

type Loader = (args: unknown) => Promise<Record<string, unknown>>;
type Action = (args: unknown) => Promise<{ data: Record<string, unknown>; init?: { status?: number } }>;

async function load(route: Record<string, unknown>, path: string) {
  expect(typeof route.loader).toBe("function");
  return (route.loader as Loader)({ request: new Request(`https://foxhoundapp.com${path}`), context: context(), params: {} });
}

async function post(route: Record<string, unknown>, path: string, fields: Record<string, string>) {
  expect(typeof route.action).toBe("function");
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return (route.action as Action)({
    request: new Request(`https://foxhoundapp.com${path}`, { method: "POST", body }),
    context: context(),
    params: {},
  });
}

const ids = (data: Record<string, unknown>) => (data.merchants as Array<{ id: string }>).map((m) => m.id);

// ---------------------------------------------------------------- pure helpers

describe("the lists' addresses and filters", () => {
  it("are Recova's three Merchants entries, at Recova's addresses (admin-nav.ts, blob c5df324c)", () => {
    expect(pageLib.MERCHANT_VIEWS).toEqual([
      { view: "all", label: "All merchants", path: "/admin/merchants" },
      { view: "paused", label: "Paused", path: "/admin/merchants/paused" },
      { view: "billing-exempt", label: "Billing exempt", path: "/admin/merchants/billing-exempt" },
    ]);
  });

  it("keeps exactly the rows whose flag is set, as Recova's .eq() reads did, cancelled ones included", () => {
    expect(typeof pageLib.merchantsInView).toBe("function");
    const inView = pageLib.merchantsInView as (rows: unknown[], view: string) => Array<{ id: string }>;
    const rows = [
      { id: "a", processingPaused: false, billingExempt: false },
      { id: "b", processingPaused: true, billingExempt: false },
      { id: "c", processingPaused: false, billingExempt: true },
      { id: "d", processingPaused: true, billingExempt: true },
    ];
    expect(inView(rows, "all").map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(inView(rows, "paused").map((r) => r.id)).toEqual(["b", "d"]);
    expect(inView(rows, "billing-exempt").map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("posts each list's forms to its own address, so a post made without script lands back on the same list", () => {
    expect(typeof pageLib.merchantsActionFor).toBe("function");
    const actionFor = pageLib.merchantsActionFor as (view: string) => string;
    expect(actionFor("all")).toBe("/admin/merchants?index");
    expect(actionFor("paused")).toBe("/admin/merchants/paused");
    expect(actionFor("billing-exempt")).toBe("/admin/merchants/billing-exempt");
  });

  it("opens a cancel confirmation on the list it was asked from, and posts it there", () => {
    const cancelHref = pageLib.merchantCancelHref as (id: string, view?: string) => string;
    expect(cancelHref("acct_north")).toBe("/admin/merchants?cancel=acct_north");
    expect(cancelHref("acct_north", "paused")).toBe("/admin/merchants/paused?cancel=acct_north");
    expect(typeof pageLib.merchantCancelAction).toBe("function");
    const cancelAction = pageLib.merchantCancelAction as (id: string, view: string) => string;
    expect(cancelAction("acct_north", "all")).toBe("/admin/merchants?index&cancel=acct_north");
    expect(cancelAction("acct_north", "billing-exempt")).toBe("/admin/merchants/billing-exempt?cancel=acct_north");
  });
});

describe("the routes", () => {
  const routes = readFileSync(fileURLToPath(new URL("../app/routes.ts", import.meta.url)), "utf8");

  it("serves the two lists at Recova's addresses, ahead of a merchant's own page", () => {
    const paused = routes.indexOf('route("paused", "./routes/admin/merchants/paused.tsx")');
    const exempt = routes.indexOf('route("billing-exempt", "./routes/admin/merchants/billing-exempt.tsx")');
    const detail = routes.indexOf('route(":id", "./routes/admin/merchants/detail.tsx")');
    expect(paused).toBeGreaterThan(-1);
    expect(exempt).toBeGreaterThan(-1);
    expect(paused).toBeLessThan(detail);
    expect(exempt).toBeLessThan(detail);
  });

  it("are the Merchants page's own module, so one action, one set of writers and one Undo serve all three", () => {
    for (const route of [pausedRoute, exemptRoute]) {
      expect(route.loader).toBe(indexRoute.loader);
      expect(route.action).toBe(indexRoute.action);
      expect(route.default).toBe(indexRoute.default);
      expect(route.handle).toEqual(indexRoute.handle);
    }
  });
});

// ---------------------------------------------------------------- the loader

describe("the loader, by address", () => {
  beforeEach(async () => {
    harness.db = (await seed()).db;
  });

  it("lists only paused merchants on the Paused list, newest first, the brake's included", async () => {
    const data = await load(pausedRoute, "/admin/merchants/paused");
    expect(data.view).toBe("paused");
    expect(ids(data)).toEqual(["acct_both", "acct_brake", "acct_pets"]);
  });

  it("lists only billing exempt merchants on the Billing exempt list", async () => {
    const data = await load(exemptRoute, "/admin/merchants/billing-exempt");
    expect(data.view).toBe("billing-exempt");
    expect(ids(data)).toEqual(["acct_both", "acct_lumen"]);
  });

  it("counts every list for its tab, whichever list is shown", async () => {
    const counts = { all: 5, paused: 3, "billing-exempt": 2 };
    expect((await load(pausedRoute, "/admin/merchants/paused")).counts).toEqual(counts);
    expect((await load(indexRoute, "/admin/merchants")).counts).toEqual(counts);
  });

  it("counts the brake's share of the Paused list, which the brake's Release would resume", async () => {
    expect((await load(pausedRoute, "/admin/merchants/paused")).brakePaused).toBe(1);
  });

  it("reads the platform figures for All merchants only, as Recova's two lists had none", async () => {
    expect((await load(pausedRoute, "/admin/merchants/paused")).figures).toBeNull();
    expect((await load(indexRoute, "/admin/merchants")).figures).toMatchObject({ merchantCount: 5 });
    expect((await load(indexRoute, "/admin/merchants")).view).toBe("all");
  });

  it("opens the cancel confirmation from a list too", async () => {
    expect(await load(pausedRoute, "/admin/merchants/paused?cancel=acct_pets")).toMatchObject({
      confirmCancel: { id: "acct_pets", name: "Paused Pets" },
    });
  });
});

// ---------------------------------------------------------------- the action

describe("the action from a list: the Merchants page's writers and audit rows", () => {
  let seeded: Seeded;
  beforeEach(async () => {
    seeded = await seed();
    harness.db = seeded.db;
  });

  const account = async (id: string) => (await seeded.db.select().from(accounts).where(eq(accounts.id, id)))[0];
  const audit = async () => (await seeded.db.select({ action: adminAuditLog.action }).from(adminAuditLog)).map((r) => r.action);

  it("resumes a paused merchant (Recova's Resume), with its audit row, and the row leaves the list", async () => {
    const answer = await post(pausedRoute, "/admin/merchants/paused", { intent: "processing-paused", accountId: "acct_pets", value: "false" });
    expect(answer.data).toMatchObject({ ok: true, intent: "processing-paused", value: false, changed: true });
    expect(await account("acct_pets")).toMatchObject({ processingPaused: false, pauseReason: null });
    expect(await audit()).toEqual(["merchant.processing.resume"]);
    expect(ids(await load(pausedRoute, "/admin/merchants/paused"))).not.toContain("acct_pets");
  });

  it("puts it back with Undo, which re-pauses it as a person's pause", async () => {
    await post(pausedRoute, "/admin/merchants/paused", { intent: "processing-paused", accountId: "acct_pets", value: "false" });
    const undone = await post(pausedRoute, "/admin/merchants/paused", { intent: "processing-paused", accountId: "acct_pets", value: "true", undo: "1" });
    expect(undone.data).toMatchObject({ ok: true, changed: true });
    expect(await account("acct_pets")).toMatchObject({ processingPaused: true, pauseReason: PAUSE_REASON_MANUAL });
  });

  it("ends an exemption (Recova's Remove exemption), so the billing run bills the merchant again", async () => {
    const answer = await post(exemptRoute, "/admin/merchants/billing-exempt", { intent: "billing-exempt", accountId: "acct_lumen", value: "false" });
    expect(answer.data).toMatchObject({ ok: true, intent: "billing-exempt", value: false, changed: true });
    expect((await account("acct_lumen")).billingExempt).toBe(false);
    expect(await audit()).toEqual(["merchant.billing_exempt.disable"]);
    expect(ids(await load(exemptRoute, "/admin/merchants/billing-exempt"))).toEqual(["acct_both"]);
  });

  it("says a resume of the brake's pause has no Undo, as the Merchants page does", async () => {
    const answer = await post(pausedRoute, "/admin/merchants/paused", { intent: "processing-paused", accountId: "acct_brake", value: "false" });
    expect(answer.data).toMatchObject({ ok: true, changed: true, wasBrakePause: true });
  });
});

// ---------------------------------------------------------------- the page

const Page = indexRoute.default as (props: unknown) => React.ReactNode;
const T = Date.now();

function row(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    ownerEmail: `${id}@example.com`,
    createdAt: new Date(T - 20 * DAY),
    billingExempt: false,
    processingPaused: false,
    pauseReason: null,
    cancelledAt: null,
    connectionStatus: "connected",
    stripeUserId: null,
    lastWebhookAt: null,
    activeRecoveriesCount: 0,
    recoveryRatePct: null,
    recovered: [],
    ...over,
  };
}

const PAUSED = [
  row("acct_pets", "Paused Pets", { processingPaused: true, pauseReason: PAUSE_REASON_MANUAL }),
  row("acct_brake", "Brake Bikes", { processingPaused: true, pauseReason: PAUSE_REASON_BRAKE }),
];
const EXEMPT = [row("acct_lumen", "Lumen Studio", { billingExempt: true })];
const COUNTS = { all: 5, paused: 2, "billing-exempt": 1 };

function render(view: "all" | "paused" | "billing-exempt", over: Record<string, unknown> = {}) {
  const path = { all: "/admin/merchants", paused: "/admin/merchants/paused", "billing-exempt": "/admin/merchants/billing-exempt" }[view];
  const data = {
    view,
    merchants: view === "paused" ? PAUSED : view === "billing-exempt" ? EXEMPT : [...PAUSED, ...EXEMPT],
    counts: COUNTS,
    brakePaused: view === "paused" ? 1 : 0,
    figures:
      view === "all"
        ? { merchantCount: 5, mrrByCurrency: [], connectedCount: 0, totalRecovered: [], recoveryFeesThisMonth: [], paymentsInQueue: 0 }
        : null,
    confirmCancel: null,
    ...over,
  };
  const Stub = createRoutesStub([{ path, Component: () => createElement(Page as never, { loaderData: data } as never) }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [path] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const tabs = (html: string) => /<nav class="cap-tabs-list"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";

describe("the lists on the page", () => {
  it("are Capsomer's links form of tabs, each with its count, the current one marked", () => {
    const nav = tabs(render("paused"));
    expect(nav).toMatch(/aria-label="Filter merchants"/);
    expect(text(nav)).toMatch(/All merchants\s*5\s+Paused\s*2\s+Billing exempt\s*1/);
    expect(nav).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/admin\/merchants\/paused"|<a[^>]*href="\/admin\/merchants\/paused"[^>]*aria-current="page"/);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toMatch(/href="\/admin\/merchants"/);
    expect(nav).toMatch(/href="\/admin\/merchants\/billing-exempt"/);
  });

  it("marks All merchants on the Merchants page", () => {
    const nav = tabs(render("all"));
    expect(nav).toMatch(/<a[^>]*href="\/admin\/merchants"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/admin\/merchants"/);
  });

  it("shows only the list's own rows, in the same table and with the same actions", () => {
    const html = render("paused");
    expect(text(html)).toContain("Paused Pets");
    expect(text(html)).toContain("Brake Bikes");
    expect(text(html)).not.toContain("Lumen Studio");
    expect(html).toMatch(/<table class="cap-table"/);
    // Recova's one action on this list, Resume, is the row's pause button.
    expect(text(html)).toMatch(/Resume processing for Paused Pets/);
  });

  it("says how many are on the list and what the flag does in Foxhound's engine", () => {
    const paused = text(render("paused"));
    expect(paused).toMatch(/2 merchants are paused/);
    expect(paused).toMatch(/neither processed nor billed/);
    expect(paused).toMatch(/1 of them is held by the emergency brake/);
    const exempt = text(render("billing-exempt"));
    expect(exempt).toMatch(/1 merchant is billing exempt/);
    expect(exempt).toMatch(/processed as usual and never billed/);
  });

  it("links the brake's share to the brake, in the sentence, not as a button", () => {
    const html = render("paused");
    expect(html).toMatch(/<a[^>]*href="\/admin\/brake"[^>]*>emergency brake<\/a>/);
  });

  it("has no platform figures on a list, as Recova's lists had none", () => {
    expect(text(render("paused"))).not.toContain("Estimated MRR");
    expect(text(render("all"))).toContain("Estimated MRR");
  });

  it("posts each row's actions to the list it is on", () => {
    const html = render("paused");
    expect(html).toMatch(/<form[^>]*action="\/admin\/merchants\/paused"/);
    expect(html).not.toMatch(/action="\/admin\/merchants\?index"/);
    expect(html).toMatch(/href="\/admin\/merchants\/paused\?cancel=acct_pets"/);
  });

  it("names the table for its list", () => {
    expect(render("billing-exempt")).toMatch(/<caption[^>]*>Every billing exempt merchant/);
    expect(render("paused")).toMatch(/<caption[^>]*>Every paused merchant/);
  });

  it("says an empty list plainly, with a way back to every merchant", () => {
    const paused = render("paused", { merchants: [], counts: { ...COUNTS, paused: 0 }, brakePaused: 0 });
    expect(paused).toMatch(/data-kind="no-match"/);
    expect(text(paused)).toContain("No merchants are paused.");
    expect(paused).toMatch(/<a[^>]*href="\/admin\/merchants"[^>]*>Show all merchants<\/a>/);
    const exempt = render("billing-exempt", { merchants: [], counts: { ...COUNTS, "billing-exempt": 0 } });
    expect(text(exempt)).toContain("No merchants are billing exempt.");
  });

  it("posts a result made without script back to the list, with its Undo", () => {
    const html = renderWithResult();
    expect(text(html)).toContain("Resumed processing for Paused Pets.");
    const undo = /<form[^>]*>(?:(?!<\/form>)[\s\S])*Undo[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(undo).toMatch(/action="\/admin\/merchants\/paused"/);
    expect(undo).toMatch(/name="value" value="true"/);
  });

  it("asks for the typed word on the list it came from, and goes back there", () => {
    const html = render("paused", { confirmCancel: { id: "acct_pets", name: "Paused Pets" } });
    expect(text(html)).toContain("Cancel Paused Pets?");
    expect(html).toMatch(/<form[^>]*action="\/admin\/merchants\/paused\?cancel=acct_pets"/);
    expect(html).toMatch(/<a class="cap-btn" href="\/admin\/merchants\/paused">Go back<\/a>/);
  });
});

function renderWithResult() {
  const path = "/admin/merchants/paused";
  const data = { view: "paused", merchants: PAUSED.slice(1), counts: COUNTS, brakePaused: 1, figures: null, confirmCancel: null };
  const actionData = { ok: true, intent: "processing-paused", accountId: "acct_pets", name: "Paused Pets", value: false, changed: true, wasBrakePause: false };
  const Stub = createRoutesStub([{ path, Component: () => createElement(Page as never, { loaderData: data, actionData } as never) }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [path] }));
}
