import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J32 (job_54cb0e7420dc), row S27, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/account is Recova's signed-in page, read whole at HEAD:
//   settings/account/page.tsx               blob b42f9159  1,661 bytes
//   settings/account/AccountProfileForm.tsx blob 85bd1a33    863 bytes
//   settings/components/AccountNameSection.tsx    blob bb58b169    875 bytes
//   settings/components/AccountProfileSection.tsx blob 13a68d29  3,318 bytes
//   settings/components/AppearanceSection.tsx     blob a687d482    503 bytes
//   settings/components/AccountSection.tsx        blob a154ac8f  3,839 bytes
// with SaveBar.tsx (blob f1d6eb23), ThemeToggle.tsx (blob 8f32b6c7) and
// settings/update/route.ts (blob 878c0637), built from Capsomer 0.9.0's
// components, teal throughout. Recova is the spec for every field, label,
// help line and their order. The approved differences stay: Cancel account
// keeps billing records (APPROVED-DIFFERENCES 2026-09-19), Delete account keeps
// the fee evidence (Q14, S40), and Sign out is a button that posts (2026-09-19).
//
// Every assertion here was seen failing against the page before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Cancel account's Stripe revoke and session move, neither of which this file
// is about: the revoke always succeeds and there is no session to move.
vi.mock("~/lib/stripe/connect", () => ({ deauthorizeConnectedAccount: async () => ({ ok: true }) }));
vi.mock("~/lib/auth/session", () => ({ getSession: async () => null }));

const route = await import("~/routes/app/settings/account");
const { MRR_ERROR } = await import("~/lib/settings/apply.server");
/** Loaded per test, so a missing module fails these tests and not the file. */
const loadChooseTheme = async () => (await import("~/lib/settings/theme-choice")).chooseTheme;


const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

interface RenderOpts {
  name?: string | null;
  industry?: string | null;
  customerType?: string | null;
  mrrCents?: number | null;
  cancelledAt?: Date | null;
  theme?: "dark" | "light";
  isOwner?: boolean;
  actionData?: Record<string, unknown>;
}

function render(opts: RenderOpts = {}): string {
  const loaderData = {
    account: {
      name: opts.name === undefined ? "Acme Inc" : opts.name,
      merchantIndustry: opts.industry ?? null,
      primaryCustomerType: opts.customerType ?? null,
      merchantMrrSelfReported: opts.mrrCents ?? null,
    },
    cancelledAt: opts.cancelledAt ?? null,
    userEmail: "owner@acme.test",
    ownedAccountNames: ["Acme Inc"],
    theme: opts.theme ?? "dark",
    isOwner: opts.isOwner ?? true,
    isDemo: false,
    signIn: { passkeys: [], providers: [] },
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/account",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/account"] }));
}







describe("J32 account: the profile form", () => {

  it("keeps an industry stored outside Recova's list, so a save does not erase it", () => {
    // The merchant's agent tool takes free text through the same apply layer.
    const html = render({ industry: "Veterinary" });
    const select = html.match(/<select[^>]*name="merchantIndustry"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(select).toMatch(/<option value="Veterinary" selected="">Veterinary<\/option>/);
    expect(render({ industry: "SaaS" })).not.toContain("Veterinary");
  });
});

// ---------------------------------------------------------------------------
// The action: Recova's one profile save, through Foxhound's engine.
// ---------------------------------------------------------------------------

function ctx(role: "owner" | "member" = "owner") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          email: "owner@acme.test",
          membership: { memberId: "m1", accountId: "acct_1", accountName: "Acme Inc", role },
          memberships: [{ memberId: "m1", accountId: "acct_1", accountName: "Acme Inc", role }],
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

type Result = { data: Record<string, unknown>; init?: { status?: number } };

async function post(fields: Record<string, string>, role: "owner" | "member" = "owner"): Promise<Result> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return (await route.action({
    context: ctx(role),
    request: new Request("https://foxhoundapp.test/settings/account", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as Result;
}

describe("J32 account: one save writes the name and the three context fields", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite
      .prepare(
        "INSERT INTO accounts (id, name, merchant_industry, primary_customer_type, merchant_mrr_self_reported, created_at, billing_exempt) VALUES (?, ?, ?, ?, ?, 0, 0)",
      )
      .run("acct_1", "Old Name", "Finance", "B2C", 100);
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 0, 0)")
      .run("acct_other", "Other Co");
  });

  const row = (id = "acct_1") =>
    sqlite
      .prepare(
        "SELECT name, merchant_industry AS industry, primary_customer_type AS type, merchant_mrr_self_reported AS mrr FROM accounts WHERE id = ?",
      )
      .get(id) as { name: string; industry: string | null; type: string | null; mrr: number | null };

  it("writes all four from one post, MRR in cents, and touches no other account", async () => {
    const res = await post({
      _action: "profile",
      name: "Acme Inc",
      merchantIndustry: "SaaS",
      primaryCustomerType: "B2B",
      merchantMrrSelfReported: "5000",
    });
    expect(res.data).toEqual({ action: "profile", ok: true });
    expect(row()).toEqual({ name: "Acme Inc", industry: "SaaS", type: "B2B", mrr: 500_000 });
    expect(row("acct_other").name).toBe("Other Co");
  });

  it("refuses a bad MRR beside the field and writes nothing at all", async () => {
    const res = await post({
      _action: "profile",
      name: "New Name",
      merchantIndustry: "SaaS",
      primaryCustomerType: "B2B",
      merchantMrrSelfReported: "-5",
    });
    expect(res.init?.status).toBe(400);
    expect(res.data).toEqual({ action: "profile", ok: false, error: MRR_ERROR, field: "merchantMrrSelfReported" });
    expect(row()).toEqual({ name: "Old Name", industry: "Finance", type: "B2C", mrr: 100 });
  });

  it("refuses an empty name beside the field and writes nothing at all", async () => {
    const res = await post({ _action: "profile", name: "  ", merchantIndustry: "SaaS", merchantMrrSelfReported: "1" });
    expect(res.init?.status).toBe(400);
    expect(res.data).toMatchObject({ action: "profile", ok: false, field: "name" });
    expect(row()).toEqual({ name: "Old Name", industry: "Finance", type: "B2C", mrr: 100 });
  });
});

describe("J32 account: a failed save", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Recova's failure state rather than throwing, and logs the thrown error whole", async () => {
    const thrown = new Error("D1 unavailable");
    harness.db = new Proxy(
      {},
      {
        get() {
          throw thrown;
        },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({
      _action: "profile",
      name: "Acme Inc",
      merchantIndustry: "SaaS",
      merchantMrrSelfReported: "10",
    });
    expect(res.data).toEqual({ action: "profile", ok: false });
    expect(res.init?.status).toBe(500);
    // The error object itself, so its stack reaches the log, not only its message.
    expect(logged).toHaveBeenCalledWith("account settings write failed:", thrown);
  });
});

describe("J32 review: only the owner can cancel the account", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 0, 0)")
      .run("acct_1", "Acme Inc");
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 1, 1000, NULL, 1000)",
      )
      .run("conn_1", "acct_1", "acct_stripe_1");
  });

  const state = () => ({
    cancelledAt: (sqlite.prepare("SELECT cancelled_at AS c FROM accounts WHERE id = 'acct_1'").get() as { c: unknown }).c,
    disconnectedAt: (
      sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections WHERE id = 'conn_1'").get() as { d: unknown }
    ).d,
  });

  it("refuses a member with a 403 and writes nothing", async () => {
    const res = await post({ _action: "cancel-account" }, "member");
    expect(res.init?.status).toBe(403);
    expect(res.data).toEqual({
      action: "cancel-account",
      ok: false,
      error: "Only the account owner can cancel the account.",
    });
    expect(state()).toEqual({ cancelledAt: null, disconnectedAt: null });
  });

  it("still lets the owner cancel", async () => {
    const res = await post({ _action: "cancel-account" }, "owner");
    expect(res.data).toMatchObject({ action: "cancel-account", ok: true });
    const after = state();
    expect(after.cancelledAt).not.toBeNull();
    expect(after.disconnectedAt).not.toBeNull();
  });
});

describe("J32 review: the theme choice in the demo", () => {
  it("refuses in the demo without saving anything, as DemoGuardedForm refuses other writes", async () => {
    const chooseTheme = await loadChooseTheme();
    const fetcher = vi.fn();
    expect(await chooseTheme("light", { isDemo: true, fetcher })).toBe("demo");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("saves through /api/theme otherwise, and reports a refused or lost save as failed", async () => {
    const chooseTheme = await loadChooseTheme();
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await chooseTheme("light", { isDemo: false, fetcher: ok })).toBe("saved");
    expect(ok).toHaveBeenCalledWith("/api/theme", expect.objectContaining({ method: "POST", body: JSON.stringify({ theme: "light" }) }));
    expect(await chooseTheme("dark", { isDemo: false, fetcher: async () => new Response("", { status: 500 }) })).toBe("failed");
    expect(
      await chooseTheme("dark", {
        isDemo: false,
        fetcher: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe("failed");
  });
});
