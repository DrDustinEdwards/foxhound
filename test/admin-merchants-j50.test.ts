
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
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

  it("knows its list from its route, not its address: a revalidation reads /paused.data (seen in the browser)", async () => {
    const paused = await load(pausedRoute, "/admin/merchants/paused.data");
    expect(paused.view).toBe("paused");
    expect(ids(paused)).toEqual(["acct_both", "acct_brake", "acct_pets"]);
    const exempt = await load(exemptRoute, "/admin/merchants/billing-exempt.data?_routes=routes%2Fadmin%2Fmerchants%2Fbilling-exempt");
    expect(exempt.view).toBe("billing-exempt");
    expect((await load(indexRoute, "/admin/merchants/_.data")).view).toBe("all");
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







