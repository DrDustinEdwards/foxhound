
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminAuditLog } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J47 (job_60dcf0c5f687): /admin/platform/audit-log on the family admin pattern
// (Capsomer's parts, Dustin's Q9 of 2026-10-14) and his 2026-10-11 admin
// review, with Recova's audit log (app/admin/platform/audit-log/page.tsx, blob
// 5003157c) read as the inventory: the Time, Actor, Action, Target and Detail
// columns, readable action labels (its "Account deleted (self)" among them),
// a relative time with the full time on hover, the count of entries shown and
// an empty state. Foxhound's linked targets and its 200 entries stay.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route: Record<string, unknown> = await import("~/routes/admin/audit-log");
// Looked up so a missing export fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const describeLib: Record<string, unknown> = await import("~/lib/admin/audit-describe");

interface Entry {
  action: string;
  metadata: unknown;
  targetEmail: string | null;
  targetUserId: string | null;
}

const entry = (action: string, metadata: unknown, targetEmail: string | null = null): Entry => ({
  action,
  metadata,
  targetEmail,
  targetUserId: null,
});

function detail(e: Entry): string | null {
  expect(typeof describeLib.auditDetail).toBe("function");
  return (describeLib.auditDetail as (e: Entry) => string | null)(e);
}



// ---------------------------------------------------------------- the loader

describe("the loader", () => {
  beforeEach(async () => {
    const { db } = createInMemoryDb();
    const at = (min: number) => new Date(Date.now() - min * 60 * 1000);
    await db.insert(adminAuditLog).values([
      { id: "a1", actorEmail: "ops@example.com", action: "cron.disable", metadata: { cronName: "recovery-tick", via: "brake-panel" }, createdAt: at(5) },
      { id: "a2", actorEmail: "account-owner", action: "user_self_deleted_account", targetUserId: "u1", metadata: { account_ids: ["x"], kept_recovered_payments: 0, stripe_connections_disconnected: 0 }, createdAt: at(1) },
    ]);
    harness.db = db;
  });

  it("serves each entry's actor, action, target and detail in words, newest first", async () => {
    expect(typeof route.loader).toBe("function");
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
    const loader = route.loader as (args: unknown) => Promise<{ entries: Array<Record<string, unknown>> }>;
    const { entries } = await loader({
      request: new Request("https://foxhoundapp.com/admin/platform/audit-log"),
      context,
      params: {},
    });
    expect(entries.map((e) => e.id)).toEqual(["a2", "a1"]);
    expect(entries[0]).toMatchObject({ actor: "The account owner", action: "Deleted their own account" });
    expect(entries[0].detail).toBe("1 merchant account deleted, 0 Stripe connections disconnected, 0 recovered payments kept");
    expect(entries[1]).toMatchObject({ actor: "ops@example.com", action: "Disabled a cron", detail: "From the emergency brake page" });
  });
});





describe("the fallback never shows a secret or a long value", () => {
  it("skips keys that may hold a credential, an address or a Stripe user", () => {
    expect(
      detail(
        entry("something.new", {
          api_token: "t",
          client_secret: "s",
          keyId: "k",
          password: "p",
          stripe_user_id: "acct_1",
          email: "a@example.com",
          recipient: "self",
          stage: "two",
        }),
      ),
    ).toBe("stage: two");
    expect(detail(entry("impersonation_start", { target_email: "a@example.com" }))).toBeNull();
  });

  it("cuts a long value at 80 characters with an ellipsis", () => {
    const long = "x".repeat(200);
    expect(detail(entry("something.new", { note: long }))).toBe(`note: ${"x".repeat(80)}…`);
    expect(detail(entry("something.new", { note: "x".repeat(80) }))).toBe(`note: ${"x".repeat(80)}`);
  });
});
