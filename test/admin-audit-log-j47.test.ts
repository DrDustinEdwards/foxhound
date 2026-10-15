import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
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
const AuditLogPage = route.default as (props: unknown) => React.ReactNode;
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

function actor(email: string): string {
  expect(typeof describeLib.auditActor).toBe("function");
  return (describeLib.auditActor as (e: string) => string)(email);
}

const describeAction = (a: string) => (describeLib.describeAuditAction as (a: string) => string)(a);

describe("readable action labels", () => {
  it("says Recova's self-deletion label in Foxhound's words", () => {
    expect(describeAction("user_self_deleted_account")).toBe("Deleted their own account");
  });

  it("says every action Foxhound writes outside the admin routes as a sentence", () => {
    const constants = [
      ["app/lib/auth/delete-account.server.ts", /ACCOUNT_DELETION_AUDIT_ACTION = "([^"]+)"/],
      ["app/lib/auth/delete-account.server.ts", /ACCOUNT_DELETION_DEAUTHORIZE_FAILED_ACTION = "([^"]+)"/],
      ["app/lib/admin/email-send.server.ts", /ADMIN_EMAIL_AUDIT_ACTION = "([^"]+)"/],
    ] as const;
    for (const [file, pattern] of constants) {
      const action = pattern.exec(readFileSync(file, "utf8"))?.[1];
      expect(action, file).toBeTruthy();
      expect(describeAction(action!), action).not.toBe(action);
    }
  });
});

describe("the actor", () => {
  it("names the account owner in words and keeps an operator's email", () => {
    expect(actor("account-owner")).toBe("The account owner");
    expect(actor("ops@example.com")).toBe("ops@example.com");
  });
});

describe("the detail column", () => {
  it("says how an action was made when it came from somewhere other than its page", () => {
    expect(detail(entry("cron.disable", { cronName: "recovery-tick", via: "brake-panel" }))).toBe(
      "From the emergency brake page",
    );
    expect(detail(entry("merchant.processing.pause", { accountId: "a", via: "admin-api", keyId: "k1" }))).toBe(
      "Through the admin API",
    );
    expect(detail(entry("staged.create", { stagedId: "s", kind: "pause", via: "admin-api", summary: "x" }))).toBe(
      "Requested through the admin API",
    );
    expect(detail(entry("cron.disable", { cronName: "recovery-tick" }))).toBeNull();
  });

  it("counts what a cancellation disconnected and what it could not revoke", () => {
    expect(detail(entry("merchant.cancel", { accountId: "a", connectionsDisconnected: 1, deauthorizeErrors: [] }))).toBe(
      "1 Stripe connection disconnected",
    );
    expect(
      detail(entry("merchant.cancel", { accountId: "a", connectionsDisconnected: 2, deauthorizeErrors: ["x"] })),
    ).toBe("2 Stripe connections disconnected, 1 could not be revoked");
  });

  it("says when a grant or a revoke changed nothing", () => {
    expect(detail(entry("merchant.intelligence.grant", { accountId: "a", granted: false }))).toBe(
      "Already had Intelligence, nothing changed",
    );
    expect(detail(entry("merchant.intelligence.grant", { accountId: "a", granted: true }))).toBeNull();
    expect(detail(entry("merchant.intelligence.revoke", { accountId: "a", revoked: false }))).toBe(
      "Had no granted Intelligence, nothing changed",
    );
  });

  it("gives a billing adjustment's amount and description", () => {
    expect(
      detail(
        entry("billing.adjustment.create", { accountId: "a", amountCents: -2500, currency: "usd", description: "Goodwill" }),
      ),
    ).toBe("-$25.00: Goodwill");
  });

  it("counts a post's related links", () => {
    expect(detail(entry("blog.set-links", { postId: "p", slug: "s", targetIds: ["a", "b"] }))).toBe("2 related links");
    expect(detail(entry("blog.set-links", { postId: "p", slug: "s", targetIds: ["a"] }))).toBe("1 related link");
  });

  it("names who asked for a staged change and why one failed", () => {
    expect(detail(entry("staged.confirm", { stagedId: "s", requestedBy: "ops@example.com", summary: "x" }))).toBe(
      "Requested by ops@example.com",
    );
    expect(detail(entry("staged.failed", { stagedId: "s", kind: "pause", error: "No such account" }))).toBe(
      "No such account",
    );
  });

  it("says which test email went where", () => {
    expect(
      detail(entry("email.test_send", { type: "recovery_day1", accountId: "a", recipient: "self" }, "ops@example.com")),
    ).toBe("recovery_day1, sent to ops@example.com");
  });

  it("counts what an account deletion removed and kept", () => {
    expect(
      detail(
        entry("user_self_deleted_account", {
          initiated_at: "2026-10-01T00:00:00.000Z",
          account_ids: ["a", "b"],
          kept_recovered_payments: 3,
          stripe_connections_disconnected: 1,
        }),
      ),
    ).toBe("2 merchant accounts deleted, 1 Stripe connection disconnected, 3 recovered payments kept");
    expect(
      detail(entry("user_self_deleted_account_deauthorize_failed", { connection_id: "c", error: "Stripe said no" })),
    ).toBe("Stripe said no");
  });

  it("falls back to Recova's first key and value for an action it does not know, never JSON", () => {
    expect(detail(entry("something.new", { count: 4, nested: { a: 1 } }))).toBe("count: 4");
    expect(detail(entry("something.new", { nested: { a: 1 } }))).toBeNull();
    expect(detail(entry("something.new", null))).toBeNull();
    expect(detail(entry("something.new", {}))).toBeNull();
  });
});

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

// ---------------------------------------------------------------- the page

interface PageEntry {
  id: string;
  createdAt: Date;
  actor: string;
  action: string;
  target: { label: string; href?: string } | null;
  detail: string | null;
}

function pageEntry(i: number, over: Partial<PageEntry> = {}): PageEntry {
  return {
    id: `a${i}`,
    createdAt: new Date(Date.now() - i * 60 * 60 * 1000),
    actor: "ops@example.com",
    action: "Disabled a cron",
    target: { label: "recovery-tick", href: "/admin/platform/crons#cron-recovery-tick" },
    detail: "From the emergency brake page",
    ...over,
  };
}

function render(entries: PageEntry[]) {
  const Stub = createRoutesStub([
    {
      path: "/admin/platform/audit-log",
      Component: () => createElement(AuditLogPage as never, { loaderData: { entries } } as never),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/platform/audit-log"] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

describe("the Audit log page", () => {
  const three = [
    pageEntry(1),
    pageEntry(2, { actor: "The account owner", action: "Deleted their own account", target: { label: "u1" }, detail: null }),
    pageEntry(3, { target: null, detail: "count: 4" }),
  ];

  it("is a captioned Capsomer table with Recova's five columns in sentence case", () => {
    const html = render(three);
    expect(html).toMatch(/class="cap-table"/);
    expect(html).toMatch(/<caption[^>]*>[^<]*audit log/i);
    const headers = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(headers).toEqual(["Time", "Actor", "Action", "Target", "Detail"]);
    expect(html).not.toMatch(/\buppercase\b|\btracking-/);
  });

  it("scrolls the table in its own labelled region on a phone", () => {
    expect(render(three)).toMatch(/<div class="cap-table-wrap"[^>]*role="region"[^>]*aria-labelledby="[^"]+"[^>]*tabindex="0"/i);
  });

  it("shows the detail, the actor in words and None where there is nothing", () => {
    const t = text(render(three));
    expect(t).toContain("From the emergency brake page");
    expect(t).toContain("count: 4");
    expect(t).toContain("The account owner");
    expect(t).toContain("Deleted their own account");
    expect(t).toMatch(/None/);
  });

  it("links a target to its page with a 24 px target", () => {
    const html = render(three);
    const link = /<a [^>]*href="\/admin\/platform\/crons#cron-recovery-tick"[^>]*>/.exec(html)?.[0] ?? "";
    expect(link).toMatch(/class="[^"]*\bmin-h-6\b[^"]*"/);
  });

  it("gives each time its full form on hover and focus", () => {
    const html = render([pageEntry(1)]);
    expect(html).toMatch(/<span tabindex="0" aria-describedby="[^"]+">/);
    expect(html).toMatch(/role="tooltip"/);
  });

  it("says how many entries it shows, in words", () => {
    expect(text(render(three))).toContain("Showing the last 3 entries, newest first.");
    expect(text(render([pageEntry(1)]))).toContain("Showing the last 1 entry, newest first.");
  });

  it("has an empty state", () => {
    const t = text(render([]));
    expect(t).toContain("No audit log entries yet.");
    expect(render([])).not.toMatch(/<table/);
  });
});

describe("the page source", () => {
  const source = readFileSync("app/routes/admin/audit-log.tsx", "utf8");

  it("has no amber, no hand-sized text and no heading of its own", () => {
    expect(source).not.toMatch(/amber|orange|warning-text|tone="warn"/);
    expect(source).not.toMatch(/text-\[/);
    expect(source).not.toMatch(/<h1\b/);
  });

  it("marks its list busy while it is read again", () => {
    expect(source).toMatch(/pagePending\(/);
    expect(source).toMatch(/aria-busy=/);
  });

  it("is built from Capsomer's parts", () => {
    expect(source).toMatch(/from "capsomer\/react\/panel"/);
    expect(source).toMatch(/from "capsomer\/react\/empty"/);
    expect(source).toMatch(/"capsomer\/table\.css"/);
  });
});

// Review of #90: admin_audit_log is CARRY (docs/schema/legacy-map.md), so
// Recova's own rows arrive on this page. Its seven codes read as Foxhound's
// sentences, and its two detail cases (app/admin/platform/audit-log/page.tsx,
// blob 5003157c, metaDetail) carry over in plain words.
describe("rows carried from Recova", () => {
  it("says each of Recova's seven codes as a sentence", () => {
    const expected: Record<string, string> = {
      trigger_cron: "Triggered a cron",
      view_user_list: "Viewed the user list",
      view_cron_health: "Viewed cron health",
      impersonation_start: "Started impersonating a user",
      impersonation_stop: "Stopped impersonating a user",
      billing_exempt_toggle: "Toggled a merchant's billing exemption",
      processing_paused_toggle: "Toggled a merchant's processing pause",
    };
    for (const [code, sentence] of Object.entries(expected)) expect(describeAction(code), code).toBe(sentence);
  });

  it("keeps Recova's two detail cases", () => {
    expect(detail(entry("trigger_cron", { cron_path: "/api/cron/recovery", extra: 1 }))).toBe("/api/cron/recovery");
    expect(detail(entry("view_user_list", { user_count: 12 }))).toBe("12 users");
    expect(detail(entry("view_user_list", { user_count: 1 }))).toBe("1 user");
  });

  it("shows a carried toggle's first plain key and value, as Recova did", () => {
    expect(detail(entry("billing_exempt_toggle", { billing_exempt: true }, "m@example.com"))).toBe("billing_exempt: true");
    expect(detail(entry("processing_paused_toggle", { processing_paused: false }))).toBe("processing_paused: false");
    expect(detail(entry("view_cron_health", null))).toBeNull();
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
