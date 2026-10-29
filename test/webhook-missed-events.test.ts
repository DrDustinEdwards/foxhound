import type Stripe from "stripe";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// The missed-event sweep replays, through the webhook route's own processor,
// every recent event webhook_events never claimed, and nothing it already did.
// Real processConnectedWebhook and claim rows; only Stripe and the money DO are
// stubbed (the DO as one in-memory transaction).

const harness = vi.hoisted(() => ({
  db: null as unknown,
  events: [] as Stripe.Event[],
  listArgs: [] as unknown[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/money/execute", () => ({ executeMoneyWrite: vi.fn() }));
vi.mock("~/lib/stripe/encryption", () => ({ decryptToken: async () => "sk_connected" }));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    events: {
      list: (args: unknown) => {
        harness.listArgs.push(args);
        return (async function* () {
          yield* harness.events;
        })();
      },
    },
  }),
}));

const { executeMoneyWrite } = await import("~/lib/money/execute");
const { sweepMissedStripeEvents } = await import("~/lib/webhooks/missed-events.server");

const STRIPE_X = "acct_stripe_x";
const ACCOUNT_A = "acct_a";
const NOW = new Date("2026-10-29T03:00:00.000Z");

let sqlite: Database.Database;

/** Ignored-type events with no `account`, as a list read with the merchant's own token returns them. */
function event(id: string, created: number): Stripe.Event {
  return { id, type: "customer.created", created, livemode: true, data: { object: { id: "cus_1" } } } as unknown as Stripe.Event;
}

function claims(): { id: string; account: string | null }[] {
  return sqlite
    .prepare("SELECT stripe_event_id AS id, account_id AS account FROM webhook_events ORDER BY rowid")
    .all() as { id: string; account: string | null }[];
}

beforeEach(() => {
  const mem = createInMemoryDb();
  sqlite = mem.sqlite;
  harness.db = mem.db;
  harness.listArgs = [];
  vi.mocked(executeMoneyWrite).mockImplementation(async (_env, write) => {
    const statements = write.build(mem.db);
    try {
      sqlite.transaction(() => {
        for (const stmt of statements) runStatement(sqlite, stmt);
      })();
    } catch (err) {
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
    return { applied: true };
  });
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)").run(ACCOUNT_A, "Acme", 1_000);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, is_primary, connected_at, created_at) VALUES (?, ?, ?, ?, 1, 1000, 1000)",
    )
    .run("conn_a", ACCOUNT_A, STRIPE_X, "encrypted");
  sqlite
    .prepare(
      "INSERT INTO webhook_events (id, stripe_event_id, event_type, received_at, account_id, processed, payload) VALUES (?, ?, ?, ?, ?, 1, '{}')",
    )
    .run("we_1", "evt_delivered", "customer.created", 1_000, ACCOUNT_A);
});

describe("missed-event sweep", () => {
  it("replays only unclaimed events, oldest first, on the connected account, and is idempotent", async () => {
    // Stripe lists newest first.
    harness.events = [event("evt_missed_new", 300), event("evt_delivered", 200), event("evt_missed_old", 100)];

    const first = await sweepMissedStripeEvents({} as Env, NOW);

    expect(harness.listArgs[0]).toMatchObject({ created: { gte: Math.floor(NOW.getTime() / 1000) - 4 * 86_400 } });
    expect(first).toMatchObject({ accounts: 1, listed: 3, replayed: 2, failed: 0, accountErrors: 0 });
    expect(claims()).toEqual([
      { id: "evt_delivered", account: ACCOUNT_A },
      { id: "evt_missed_old", account: ACCOUNT_A },
      { id: "evt_missed_new", account: ACCOUNT_A },
    ]);

    const second = await sweepMissedStripeEvents({} as Env, NOW);
    expect(second).toMatchObject({ listed: 3, replayed: 0 });
    expect(claims()).toHaveLength(3);
  });
});
