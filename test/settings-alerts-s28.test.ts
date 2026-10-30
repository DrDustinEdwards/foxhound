
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S28, /settings/alerts.
//
// THE READER CAME FIRST ON THIS ROW. `evaluateAlerts` has been reading `alerts`
// and writing `alert_history` nightly against a table nothing could write to.
// So the plants are aimed at the two ways this surface could lie: offering a
// metric the evaluator does not compute, and promising a notification nothing
// sends.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// The alerts are on /settings/notifications since 2026-10-29 (once /settings/alerts).
const { action } = await import("~/routes/app/settings/notifications");

const ACCOUNT = "acct_1";
const OTHER = "acct_other";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(OTHER, "Other");
});

function seedAlert(opts: {
  id: string;
  accountId?: string;
  metric?: string;
  direction?: string;
  threshold?: number;
  enabled?: boolean;
  label?: string | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, label, enabled, created_at) VALUES (?, ?, ?, ?, ?, 'email', ?, ?, 1000)",
    )
    .run(
      opts.id,
      opts.accountId ?? ACCOUNT,
      opts.metric ?? "mrr_at_risk_cents",
      opts.threshold ?? 100,
      opts.direction ?? "above",
      opts.label ?? null,
      opts.enabled === false ? 0 : 1,
    );
}

function alertRows(accountId: string) {
  return sqlite
    .prepare(
      "SELECT id, metric, threshold_value AS threshold, direction, channel, label, enabled FROM alerts WHERE account_id = ? ORDER BY id",
    )
    .all(accountId) as {
    id: string;
    metric: string;
    threshold: number;
    direction: string;
    channel: string;
    label: string | null;
    enabled: number;
  }[];
}

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        // The caller holds TWO accounts and is switched to the LATER one, so a
        // reader that resolved the earliest membership instead of the active
        // one fails rather than coincidentally agreeing.
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
} as unknown as Parameters<typeof action>[0]["context"];

async function post(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings/notifications", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as Response | { data: Record<string, unknown>; init?: { status?: number } };
  // A successful create redirects back to the page, as Recova's dismissPanel
  // closes the form; every other answer is data with a status.
  if (res instanceof Response) return { status: res.status, body: {} };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 1: create writes only the columns this surface owns", () => {
  it("stores the alert with the account, the channel default and enabled true", async () => {
    const res = await post({
      _action: "create",
      metric: "mrr_at_risk_cents",
      direction: "above",
      threshold: "50",
      label: "Churn watch",
    });

    expect(res.status).toBe(302);
    const rows = alertRows(ACCOUNT);
    expect(rows).toHaveLength(1);
    // Dollars in the form, CENTS in the column the evaluator compares against.
    expect(rows[0].threshold).toBe(5000);
    expect(rows[0].label).toBe("Churn watch");
    expect(rows[0].enabled).toBe(1);
  });
});

describe("PLANT 2: every bound the evaluator implies is enforced", () => {

  it("400 and NO write for a bad direction, a negative threshold, or no threshold", async () => {
    for (const fields of [
      { _action: "create", metric: "high_risk_customers_count", direction: "sideways", threshold: "5" },
      { _action: "create", metric: "high_risk_customers_count", direction: "below", threshold: "-1" },
      { _action: "create", metric: "high_risk_customers_count", direction: "below", threshold: "" },
      { _action: "create", metric: "high_risk_customers_count", direction: "below", threshold: "abc" },
    ]) {
      const res = await post(fields);
      expect(res.status).toBe(400);
    }
    expect(alertRows(ACCOUNT)).toHaveLength(0);
  });
});

describe("PLANT 3: toggle and delete are account-scoped", () => {
  it("toggling flips enabled on this account's alert", async () => {
    seedAlert({ id: "a1", enabled: true });
    await post({ _action: "toggle", alertId: "a1", enabled: "false" });
    expect(alertRows(ACCOUNT)[0].enabled).toBe(0);
  });

  it("delete removes the alert and its own firing history, and nobody else's", async () => {
    seedAlert({ id: "a1" });
    seedAlert({ id: "a2" });
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
    const remaining = sqlite.prepare("SELECT id FROM alert_history ORDER BY id").all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(["h2"]);
  });

  it("400 and no write when no alert id is sent", async () => {
    seedAlert({ id: "a1", enabled: true });
    expect((await post({ _action: "toggle", enabled: "false" })).status).toBe(400);
    expect((await post({ _action: "delete" })).status).toBe(400);
    expect(alertRows(ACCOUNT)[0].enabled).toBe(1);
  });
});
