import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { SLACK_WEBHOOK_ERROR } from "~/lib/settings/slack-webhook";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J39, row S36, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/notifications is Recova's page
// (app/(app)/settings/notifications/page.tsx at blob 93126fd2,
// NotificationsForm.tsx at blob 316c15cf and
// settings/components/NotificationsSection.tsx at blob 494c6dfa, with the
// SaveBar at app/(app)/settings/SaveBar.tsx blob f1d6eb23 and the Toggle at
// components/Toggle.tsx blob 0ebdd395) built from Capsomer 0.9.0's components,
// amber throughout. Recova stays the spec for every field, toggle and label and
// their order; the page keeps the settings layout's 800px column.
//
// The webhook host rule (hooks.slack.com) stays pinned where it was; the
// NULL map and the six columns stay in settings-digest-email-removed and the
// MCP write tests. Every assertion here was seen failing before the rebuild.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  customerUpdate: null as unknown as ReturnType<typeof vi.fn>,
}));

// The platform Stripe client, faked at its one factory: only the customer
// email push reads it.
vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({ customers: { update: harness.customerUpdate } }),
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/notifications");










// ---------------------------------------------------------------------------
// The loader and the action.
// ---------------------------------------------------------------------------

const ACCOUNT = "acct_1";
let sqlite: Database.Database;

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
          activeAccountId: ACCOUNT,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return (await route.action({
    context: ctx(),
    request: new Request("https://x/settings/notifications", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
}

describe("J39 notifications: the loader and the action", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    harness.customerUpdate = vi.fn(async () => ({}));
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the webhook field on a refused webhook, so the page can put the error beside it", async () => {
    const res = await post({ notificationEmail: "ops@acme.test", slackWebhookUrl: "https://evil.test/x" });
    expect(res.init?.status).toBe(400);
    expect(res.data).toEqual({ ok: false, error: SLACK_WEBHOOK_ERROR, field: "slackWebhookUrl" });
  });

  it("answers a failed write with Recova's failure state rather than an error page", async () => {
    harness.db = new Proxy(
      {},
      {
        get() {
          throw new Error("D1 unavailable");
        },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ notificationEmail: "ops@acme.test", digestEnabled: "on" });
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({ ok: false, failed: true });
    // The whole error, stack included, so a D1 failure can be traced in tail.
    const err = logged.mock.calls[0]?.[1];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 unavailable");
  });

  // Recova's settings/update/route.ts (blob 878c0637, lines 167 to 196) pushes
  // a changed notification email to the billing customer so Stripe's invoices
  // and portal follow it.
  it("pushes a changed notification email to the billing customer, and only a changed one", async () => {
    sqlite
      .prepare("UPDATE accounts SET notification_email = ?, platform_stripe_customer_id = ? WHERE id = ?")
      .run("old@acme.test", "cus_platform_1", ACCOUNT);

    expect((await post({ notificationEmail: "new@acme.test" })).data).toEqual({ ok: true });
    expect(harness.customerUpdate).toHaveBeenCalledTimes(1);
    expect(harness.customerUpdate).toHaveBeenCalledWith("cus_platform_1", { email: "new@acme.test" });

    // Unchanged, and cleared: Recova pushes neither.
    await post({ notificationEmail: "new@acme.test" });
    await post({ notificationEmail: "" });
    expect(harness.customerUpdate).toHaveBeenCalledTimes(1);
  });

  it("saves the settings when the Stripe push fails, and keeps the email out of the log", async () => {
    sqlite
      .prepare("UPDATE accounts SET platform_stripe_customer_id = ? WHERE id = ?")
      .run("cus_platform_1", ACCOUNT);
    harness.customerUpdate = vi.fn(async () => {
      throw Object.assign(new Error("No such customer, email new@acme.test"), {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
      });
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await post({ notificationEmail: "new@acme.test" })).data).toEqual({ ok: true });
    const saved = sqlite.prepare("SELECT notification_email FROM accounts WHERE id = ?").get(ACCOUNT);
    expect(saved).toEqual({ notification_email: "new@acme.test" });
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("new@acme.test");
  });
});
