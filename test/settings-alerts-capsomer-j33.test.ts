
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J33 (job_947a0b8bbe06), row S28, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/alerts is Recova's page
// (app/(app)/settings/alerts/page.tsx at blob 3c1d6bb0 and AlertsClient.tsx at
// blob ee8dac99, both read whole) built from Capsomer 0.9.0's components, teal
// throughout. Recova stays the spec for every section, column, control and
// label and their order, and for the page's width: the settings layout's 800px
// column, with no second wrapper of the page's own.
//
// Two differences from Recova stay, both kept from S28 under RULES.md 1.2 and
// 2.7 because Foxhound delivers no alert yet: no channel picker and no Channel
// columns, and no "Get notified" promise. The metric list is Foxhound's own
// evaluator's (test/settings-alerts-s28.test.ts holds those).
//
// Every assertion here was seen failing against the page before the rebuild
// (red output kept in the J33 pull request).

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/alerts");
const { ALERT_THRESHOLD_ERROR } = await import("~/lib/settings/apply.server");











// The loader, against the in-memory database.

const ACCOUNT = "acct_1";

let sqlite: Database.Database;

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
        membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
        activeAccountId: ACCOUNT,
      };
    }
    throw new Error("unexpected context key");
  },
};

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
});

async function load(): Promise<{ alerts: { id: string }[]; history: { id: string }[] }> {
  return (await route.loader({
    context: ctx,
    request: new Request("https://x/settings/alerts"),
    params: {},
  } as never)) as never;
}

describe("J33 alerts: the loader reads as Recova's page does", () => {
  it("lists alerts newest first", async () => {
    for (const [id, createdAt] of [
      ["a_old", 1000],
      ["a_new", 3000],
      ["a_mid", 2000],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES (?, ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, ?)",
        )
        .run(id, ACCOUNT, createdAt);
    }
    expect((await load()).alerts.map((a) => a.id)).toEqual(["a_new", "a_mid", "a_old"]);
  });

  it("breaks a tie on the same creation time by id, newest id first", async () => {
    for (const id of ["a_b", "a_c", "a_a"]) {
      sqlite
        .prepare(
          "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES (?, ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, 5000)",
        )
        .run(id, ACCOUNT);
    }
    expect((await load()).alerts.map((a) => a.id)).toEqual(["a_c", "a_b", "a_a"]);
  });

  it("shows Recova's twenty most recent triggers", async () => {
    sqlite
      .prepare(
        "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES ('a1', ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, 1000)",
      )
      .run(ACCOUNT);
    for (let i = 0; i < 25; i++) {
      sqlite
        .prepare(
          "INSERT INTO alert_history (id, alert_id, account_id, metric, threshold_value, direction, actual_value, channel, fired_at, notification_sent) VALUES (?, 'a1', ?, 'mrr_at_risk_cents', 100, 'above', 200, 'email', ?, 0)",
        )
        .run(`h${String(i).padStart(2, "0")}`, ACCOUNT, 1000 + i);
    }
    const { history } = await load();
    expect(history).toHaveLength(20);
    expect(history[0].id).toBe("h24");
  });
});

describe("J33 review: a successful create closes the form, as Recova's dismissPanel does", () => {
  async function post(fields: Record<string, string>, url = "https://x/settings/alerts?new=1"): Promise<unknown> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return route.action({
      context: ctx,
      request: new Request(url, { method: "POST", body: form }),
      params: {},
    } as never);
  }

  it("redirects to the page without ?new=1, and the new alert is listed", async () => {
    const res = await post({ _action: "create", metric: "mrr_at_risk_cents", direction: "below", threshold: "50", label: "Watch" });
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings/alerts");
    const { alerts } = await load();
    expect(alerts).toHaveLength(1);
  });

  it("keeps the form open with the refusal when the create is refused", async () => {
    const res = (await post({ _action: "create", metric: "mrr_at_risk_cents", direction: "below", threshold: "-1" })) as {
      data: { ok: boolean; error: string };
      init?: { status?: number };
    };
    expect(res).not.toBeInstanceOf(Response);
    expect(res.init?.status).toBe(400);
    expect(res.data.error).toBe(ALERT_THRESHOLD_ERROR);
    expect((await load()).alerts).toHaveLength(0);
  });
});
