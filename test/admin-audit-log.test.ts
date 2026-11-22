import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminAuditLog } from "~/db";
import { auditDetail, auditLookupIds, auditTarget } from "~/lib/admin/audit-describe";
import * as route from "~/routes/admin/audit-log";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

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

const detail = auditDetail;

describe("the loader", () => {
  beforeEach(async () => {
    const { db } = createInMemoryDb();
    const at = (min: number) => new Date(Date.now() - min * 60 * 1000);
    await db.insert(adminAuditLog).values([
      {
        id: "a1",
        actorEmail: "ops@example.com",
        action: "cron.disable",
        metadata: { cronName: "recovery-tick", via: "brake-panel" },
        createdAt: at(5),
      },
      {
        id: "a2",
        actorEmail: "account-owner",
        action: "user_self_deleted_account",
        targetUserId: "u1",
        metadata: {
          account_ids: ["x"],
          kept_recovered_payments: 0,
          stripe_connections_disconnected: 0,
        },
        createdAt: at(1),
      },
    ]);
    harness.db = db;
  });

  it("serves each entry's actor, action, target and detail in words, newest first", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext });
    const loader = route.loader as (
      args: unknown,
    ) => Promise<{ entries: Array<Record<string, unknown>> }>;
    const { entries } = await loader({
      request: new Request("https://foxhoundapp.com/admin/platform/audit-log"),
      context,
      params: {},
    });
    expect(entries.map((e) => e.id)).toEqual(["a2", "a1"]);
    expect(entries[0]).toMatchObject({
      actor: "The account owner",
      action: "Deleted their own account",
    });
    expect(entries[0].detail).toBe(
      "1 merchant account deleted, 0 Stripe connections disconnected, 0 recovered payments kept",
    );
    expect(entries[1]).toMatchObject({
      actor: "ops@example.com",
      action: "Disabled a cron",
      detail: "From the emergency brake page",
    });
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
    expect(detail(entry("something.new", { note: "x".repeat(80) }))).toBe(
      `note: ${"x".repeat(80)}`,
    );
  });
});

describe("the audit log in plain English", () => {
  const lookups = {
    merchantNames: new Map([["acct_b", "Northwind Coffee"]]),
    postTitles: new Map([["post_1", "Why cards fail"]]),
  };
  it("names real targets, never raw JSON", () => {
    expect(auditTarget(entry("cron.disable", { cronName: "recovery-tick" }), lookups)).toEqual({
      label: "recovery-tick",
      href: "/admin/platform/crons#cron-recovery-tick",
    });
    expect(
      auditTarget(
        entry("merchant.cancel", { accountId: "acct_b", deauthorizeErrors: [] }),
        lookups,
      ),
    ).toEqual({
      label: "Northwind Coffee",
      href: "/admin/merchants/acct_b",
    });
    expect(auditTarget(entry("merchant.cancel", { accountId: "acct_gone" }), lookups)?.label).toBe(
      "acct_gone",
    );
    expect(auditTarget(entry("blog.publish", { postId: "post_1", slug: "why" }), lookups)).toEqual({
      label: "Why cards fail",
    });
    expect(
      auditTarget(entry("brake.engage", { intendedCount: 3, sample: ["a"] }), lookups),
    ).toEqual({
      label: "All merchants (3)",
      href: "/admin/brake",
    });
    expect(
      auditTarget(
        entry("staged.confirm", { stagedId: "s1", summary: "Resume processing for acct_b" }),
        lookups,
      ),
    ).toEqual({
      label: "Resume processing for acct_b",
      href: "/admin/staged",
    });
    expect(auditTarget(entry("something.new", { anything: 1 }), lookups)).toBeNull();
    expect(auditTarget(entry("something.new", null, "a@b.c"), lookups)).toEqual({ label: "a@b.c" });
  });

  it("collects the ids the loader looks names up for", () => {
    expect(
      auditLookupIds([
        entry("merchant.cancel", { accountId: "acct_b" }),
        entry("blog.update", { postId: "post_1" }),
        entry("merchant.cancel", { accountId: "acct_b" }),
        entry("cron.disable", { cronName: "x" }),
      ]),
    ).toEqual({ accountIds: ["acct_b"], postIds: ["post_1"] });
  });
});
