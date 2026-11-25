import { describe, expect, it, vi } from "vitest";

import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

describe("cancelMerchant orchestration (injected deps, no live DB/Stripe)", () => {
  it("a deauthorize failure never rolls back or throws: the merchant stays canceled locally, the failure is surfaced", async () => {
    // The connection rows the retry stamp lands on.
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acc_1', 'A', 1000)").run();
    for (const [id, user] of [
      ["conn_1", "acct_1"],
      ["conn_2", "acct_2"],
    ]) {
      sqlite
        .prepare(
          "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, 'acc_1', ?, 1, 1000, 2000, 1000)",
        )
        .run(id, user);
    }
    const result = await cancelMerchant({} as Env, "acc_1", {
      cancelLocal: async () => [
        { id: "conn_1", stripeUserId: "acct_1" },
        { id: "conn_2", stripeUserId: "acct_2" },
      ],
      deauthorize: async (_env, stripeUserId) =>
        stripeUserId === "acct_2" ? { ok: false, error: "stripe unavailable" } : { ok: true },
    });

    expect(result.connectionsDisconnected).toBe(2);
    expect(result.deauthorizeErrors).toEqual([
      { connectionId: "conn_2", stripeUserId: "acct_2", error: "stripe unavailable", queued: true },
    ]);
  });
});

describe("cancelMerchant against the real schema", () => {
  it("an unknown account id fails and disconnects nothing (zero-row UPDATE is not a cancel)", async () => {
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acc_real', 'Real', 1000)")
      .run();
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, created_at) VALUES ('conn_1', 'acc_real', 'acct_1', 1, 1000, 1000)",
      )
      .run();
    // A stale id whose read still finds the live connection (as a race would).
    sqlite.prepare("PRAGMA foreign_keys = OFF").run();
    sqlite.prepare("UPDATE stripe_connections SET account_id = 'acc_gone'").run();
    const deauthorize = vi.fn(async () => ({ ok: true }));

    await expect(cancelMerchant({} as Env, "acc_gone", { deauthorize })).rejects.toThrow(
      /no account/,
    );

    const row = sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections").get() as {
      d: number | null;
    };
    expect(row.d).toBeNull();
    expect(deauthorize).not.toHaveBeenCalled();
  });
});
