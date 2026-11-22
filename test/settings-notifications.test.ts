import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { SLACK_WEBHOOK_ERROR } from "~/lib/settings/slack-webhook";

import { createInMemoryDb } from "./helpers/inmemory-db";

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

const ACCOUNT = "acct_1";
const OTHER = "acct_other";
let sqlite: Database.Database;

/** The caller holds two accounts and is switched to the later one, so a reader
 *  that took the earliest membership fails instead of coincidentally agreeing. */
const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
    if (key === authContext) {
      return {
        userId: "user_1",
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        memberships: [
          { memberId: "m1", accountId: OTHER, accountName: "Other", role: "owner" },
          { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        ],
        activeAccountId: ACCOUNT,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
} as never;

async function post(
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await route.action({
    context: ctx,
    request: new Request("https://x/settings/notifications", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as
    | Response
    | { data: Record<string, unknown>; init?: { status?: number } };
  // A successful alert create redirects back to the page; every other answer is
  // data with a status.
  if (res instanceof Response)
    return { status: res.status, body: { location: res.headers.get("Location") } };
  return { status: res.init?.status ?? 200, body: res.data };
}

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.customerUpdate = vi.fn(async () => ({}));
  for (const [id, name] of [
    [ACCOUNT, "Acme"],
    [OTHER, "Other"],
  ]) {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, name);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notification settings", () => {
  it("refuses a webhook off Slack's host and names the field", async () => {
    const res = await post({
      notificationEmail: "ops@acme.test",
      slackWebhookUrl: "https://evil.test/x",
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: SLACK_WEBHOOK_ERROR, field: "slackWebhookUrl" });
  });

  it("pushes a changed notification email to the billing customer, and only a changed one", async () => {
    sqlite
      .prepare(
        "UPDATE accounts SET notification_email = ?, platform_stripe_customer_id = ? WHERE id = ?",
      )
      .run("old@acme.test", "cus_platform_1", ACCOUNT);

    expect((await post({ notificationEmail: "new@acme.test" })).body).toEqual({ ok: true });
    expect(harness.customerUpdate).toHaveBeenCalledTimes(1);
    expect(harness.customerUpdate).toHaveBeenCalledWith("cus_platform_1", {
      email: "new@acme.test",
    });

    // Unchanged, and cleared: neither is pushed.
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

    expect((await post({ notificationEmail: "new@acme.test" })).body).toEqual({ ok: true });
    const saved = sqlite
      .prepare("SELECT notification_email FROM accounts WHERE id = ?")
      .get(ACCOUNT);
    expect(saved).toEqual({ notification_email: "new@acme.test" });
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("new@acme.test");
  });
});

describe("alerts", () => {
  function alertRows(accountId: string) {
    return sqlite
      .prepare(
        "SELECT id, threshold_value AS threshold, label, enabled FROM alerts WHERE account_id = ? ORDER BY id",
      )
      .all(accountId) as { id: string; threshold: number; label: string | null; enabled: number }[];
  }

  function seedAlert(id: string): void {
    sqlite
      .prepare(
        "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES (?, ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, 1000)",
      )
      .run(id, ACCOUNT);
  }

  it("create stores the alert on the active account, dollars as cents, enabled, and redirects", async () => {
    const res = await post({
      _action: "create",
      metric: "mrr_at_risk_cents",
      direction: "above",
      threshold: "50",
      label: "Churn watch",
    });
    expect(res).toEqual({ status: 302, body: { location: "/settings/notifications" } });
    expect(alertRows(ACCOUNT)).toEqual([
      { id: expect.any(String), threshold: 5000, label: "Churn watch", enabled: 1 },
    ]);
    expect(alertRows(OTHER)).toEqual([]);
  });

  it("400 and no write for a bad direction, a negative threshold, or no threshold", async () => {
    for (const [direction, threshold] of [
      ["sideways", "5"],
      ["below", "-1"],
      ["below", ""],
      ["below", "abc"],
    ]) {
      const res = await post({
        _action: "create",
        metric: "high_risk_customers_count",
        direction,
        threshold,
      });
      expect(res.status).toBe(400);
    }
    expect(alertRows(ACCOUNT)).toHaveLength(0);
  });

  it("toggle flips enabled", async () => {
    seedAlert("a1");
    await post({ _action: "toggle", alertId: "a1", enabled: "false" });
    expect(alertRows(ACCOUNT)[0].enabled).toBe(0);
  });

  it("delete removes the alert and its own firing history, and nobody else's", async () => {
    seedAlert("a1");
    seedAlert("a2");
    for (const [id, alertId] of [
      ["h1", "a1"],
      ["h2", "a2"],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO alert_history (id, alert_id, account_id, metric, threshold_value, direction, actual_value, channel, fired_at, notification_sent) VALUES (?, ?, ?, 'mrr_at_risk_cents', 100, 'above', 200, 'email', 1000, 0)",
        )
        .run(id, alertId, ACCOUNT);
    }

    const res = await post({ _action: "delete", alertId: "a1" });

    expect(res.status).toBe(200);
    expect(alertRows(ACCOUNT).map((r) => r.id)).toEqual(["a2"]);
    const remaining = sqlite.prepare("SELECT id FROM alert_history ORDER BY id").all();
    expect(remaining).toEqual([{ id: "h2" }]);
  });

  it("toggle and delete with no alert id are 400 and write nothing", async () => {
    seedAlert("a1");
    expect((await post({ _action: "toggle", enabled: "false" })).status).toBe(400);
    expect((await post({ _action: "delete" })).status).toBe(400);
    expect(alertRows(ACCOUNT)[0].enabled).toBe(1);
  });
});
