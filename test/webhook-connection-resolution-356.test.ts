import type Stripe from "stripe";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// RULING 356 BINDING 3, DEFECT 4, LAYER 2 OF TWO: the reader that routes money
// only looks at LIVE connections.
//
// WHY THIS IS ITS OWN LAYER (340 binding 3). The unique index shipped in the
// same session stops a SECOND live row being written. It does nothing about a
// row that is already DISCONNECTED, and S37's disconnect leaves exactly those
// behind by design. So a Stripe account disconnected from account A and then
// connected to account B leaves two rows, one dead and one live, and the
// pre-fix `resolveConnection` matched on `stripe_user_id` alone with no
// ordering: the dead row could answer, and every failed payment, recovered
// payment and billing line item for that Stripe account would land on A.
//
// Each layer is therefore reached ALONE here. The fixture in this file never
// violates the index (one live row at most), so nothing it proves is borrowed
// from the constraint.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  writes: [] as { accountId: string }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({ executeMoneyWrite: vi.fn() }));

const { executeMoneyWrite } = await import("~/lib/money/execute");
const { processConnectedWebhook } = await import("~/lib/webhooks/process");

const STRIPE_X = "acct_stripe_x";
const ACCOUNT_A = "acct_a";
const ACCOUNT_B = "acct_b";
const RECEIVED_AT = new Date("2026-08-23T12:00:00.000Z");

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.writes = [];

  vi.mocked(executeMoneyWrite).mockImplementation(async (_env, write) => {
    const statements = write.build(db);
    harness.writes.push({ accountId: write.accountId });
    sqlite.transaction(() => {
      for (const stmt of statements) runStatement(sqlite, stmt);
    })();
    return { applied: true };
  });

  seedAccount(ACCOUNT_A, "Acme");
  seedAccount(ACCOUNT_B, "Globex");
});

function seedAccount(id: string, name: string): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, name, 1_000);
}

function seedConnection(opts: {
  id: string;
  accountId: string;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 1, 1000, ?, 1000)",
    )
    .run(opts.id, opts.accountId, STRIPE_X, opts.disconnectedAt ?? null);
}

/** An event that classifies as "ignore", so the only thing under test is WHICH
 *  account the claim is keyed on. A processing-heavy type would drag intake and
 *  attribution into a test about one WHERE clause. */
function event(id: string): Stripe.Event {
  return {
    id,
    type: "customer.created",
    account: STRIPE_X,
    data: { object: { id: "cus_1" } },
  } as unknown as Stripe.Event;
}

function claimedAccountIds(): (string | null)[] {
  return (
    sqlite
      .prepare("SELECT account_id AS a FROM webhook_events ORDER BY rowid")
      .all() as { a: string | null }[]
  ).map((r) => r.a);
}

describe("PLANT 2: every row disconnected takes the EXISTING no-connection path", () => {
  it("claims the event with a null account and reports unknown_account", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, disconnectedAt: 2_000 });

    const outcome = await processConnectedWebhook({} as Env, event("evt_3"), RECEIVED_AT);

    // PINNED AS READ, NOT INVENTED. `processConnectedWebhook` already had this
    // branch for a Stripe account Foxhound has never seen: claim through a
    // PLAIN insert rather than a money write, so replays short-circuit on the
    // unique index, then ignore. A fully disconnected merchant now arrives at
    // the same place, which is the correct answer and needed no new handling.
    expect(outcome).toEqual({ status: "ignored", reason: "unknown_account" });
    expect(harness.writes).toEqual([]);
    expect(claimedAccountIds()).toEqual([null]);

    const row = sqlite
      .prepare("SELECT processed AS p, event_type AS t, payload FROM webhook_events WHERE stripe_event_id = ?")
      .get("evt_3") as { p: number; t: string; payload: string };
    // Not our merchant's event, so its customer data is not kept.
    expect(row).toEqual({ p: 1, t: "customer.created", payload: "{}" });
  });

  it("is idempotent on a replay, as the pre-existing path already was", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, disconnectedAt: 2_000 });

    await processConnectedWebhook({} as Env, event("evt_4"), RECEIVED_AT);
    await processConnectedWebhook({} as Env, event("evt_4"), RECEIVED_AT);

    expect(claimedAccountIds()).toEqual([null]);
  });

  it("PLANT: a claim that fails for any reason but the unique index is an error, so Stripe retries", async () => {
    // Grok audit 2026-10-21, FH-1: the catch used to swallow every failure into
    // "ignored", a 200, and Stripe never sent the event again.
    sqlite.exec("DROP TABLE webhook_events");
    const outcome = await processConnectedWebhook({} as Env, event("evt_6"), RECEIVED_AT);
    expect(outcome.status).toBe("error");
  });
});
