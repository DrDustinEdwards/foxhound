import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// account.application.deauthorized: the merchant revoked Foxhound's grant from
// their Stripe dashboard. The live connection is marked disconnected through
// the local disconnect, Stripe is not called again, and an event for a Stripe
// account Foxhound does not hold live is claimed and ignored.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
    return { applied: true };
  },
}));

const deauthorize = vi.hoisted(() => vi.fn());
vi.mock("~/lib/stripe/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/connect")>()),
  deauthorizeConnectedAccount: deauthorize,
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");

const env = {} as Env;
let sqlite: Database.Database;

beforeEach(() => {
  let db;
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  deauthorize.mockReset();
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'Acme', 1000)").run();
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, created_at) VALUES ('c1', 'a1', 'acct_s', 1, 1000, 1000)",
    )
    .run();
});

function deauthorized(id: string, account: string) {
  return {
    id,
    type: "account.application.deauthorized",
    account,
    livemode: true,
    created: 2000,
    data: { object: { id: "ca_foxhound", object: "application" } },
  } as never;
}

describe("account.application.deauthorized", () => {
  it("disconnects the live connection without calling Stripe, and ignores an unknown account", async () => {
    const received = new Date("2026-11-01T00:00:00Z");

    expect(await processConnectedWebhook(env, deauthorized("evt_1", "acct_s"), received)).toEqual({ status: "applied" });
    expect(sqlite.prepare("SELECT disconnected_at AS at FROM stripe_connections WHERE id = 'c1'").get()).toEqual({
      at: received.getTime(),
    });
    expect(deauthorize).not.toHaveBeenCalled();

    // A redelivery finds no live connection: claimed as unknown, nothing written.
    expect(await processConnectedWebhook(env, deauthorized("evt_1", "acct_s"), received)).toEqual({
      status: "ignored",
      reason: "unknown_account",
    });

    // A Stripe account Foxhound never held live (an audit grant is never stored).
    expect(await processConnectedWebhook(env, deauthorized("evt_2", "acct_audit"), received)).toEqual({
      status: "ignored",
      reason: "unknown_account",
    });
    const claimed = sqlite.prepare("SELECT stripe_event_id AS id, account_id AS account FROM webhook_events ORDER BY id").all();
    expect(claimed).toEqual([
      { id: "evt_1", account: "a1" },
      { id: "evt_2", account: null },
    ]);
  });
});
