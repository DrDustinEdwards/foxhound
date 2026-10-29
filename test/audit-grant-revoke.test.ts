import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, stripeConnections } from "~/db";
import { AUDIT_QUEUE_NAME } from "~/lib/constants";
import { handleQueueBatch } from "~/lib/queue/consumer";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The anonymous audit's Stripe grant is read_write (Stripe gives read_only only
// to Extensions), so Foxhound revokes it when the window ends. The callback
// queues the revoke (test/audit-connect-j42.test.ts); this drives its delivery
// through the real queue consumer. oauth.deauthorize cuts the platform's whole
// connection to the Stripe account, so it must never run while any Foxhound
// account holds that Stripe account live.

const harness = vi.hoisted(() => ({ db: null as unknown, deauthorized: [] as string[], ok: true }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/stripe/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/connect")>()),
  deauthorizeConnectedAccount: async (_env: Env, stripeUserId: string) => {
    harness.deauthorized.push(stripeUserId);
    return harness.ok ? { ok: true } : { ok: false, error: "stripe unavailable" };
  },
}));

const ENV = {} as Env;
const CREATED = new Date("2026-10-01T00:00:00Z");
const STRIPE = "acct_1Audited";

let db: ReturnType<typeof createInMemoryDb>["db"];
beforeEach(async () => {
  db = createInMemoryDb().db;
  harness.db = db;
  harness.deauthorized = [];
  harness.ok = true;
  await db.insert(accounts).values({ id: "acct_a", name: "Sample A", createdAt: CREATED });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Deliver one revoke message; returns what the consumer did with it. */
async function deliver(attempts = 1): Promise<"ack" | "retry"> {
  let verdict: "ack" | "retry" | null = null;
  await handleQueueBatch(
    {
      queue: AUDIT_QUEUE_NAME,
      messages: [
        {
          id: "m1",
          attempts,
          body: { kind: "audit-grant-revoke", stripeAccountId: STRIPE },
          ack: () => (verdict = "ack"),
          retry: () => (verdict = "retry"),
        },
      ],
    } as unknown as MessageBatch<unknown>,
    ENV,
  );
  return verdict!;
}

describe("revoking the anonymous audit's Stripe grant", () => {
  it("revokes it when no Foxhound account holds the Stripe account, including a disconnected one", async () => {
    await db.insert(stripeConnections).values({
      id: "sc_old",
      accountId: "acct_a",
      stripeUserId: STRIPE,
      createdAt: CREATED,
      disconnectedAt: CREATED,
    });
    expect(await deliver()).toBe("ack");
    expect(harness.deauthorized).toEqual([STRIPE]);
  });

  it("skips it when any Foxhound account holds the Stripe account live", async () => {
    await db.insert(stripeConnections).values({ id: "sc_live", accountId: "acct_a", stripeUserId: STRIPE, createdAt: CREATED });
    expect(await deliver()).toBe("ack");
    expect(harness.deauthorized).toEqual([]);
  });

  it("retries a failed revoke once, then gives up", async () => {
    harness.ok = false;
    expect(await deliver(1)).toBe("retry");
    expect(await deliver(2)).toBe("ack");
    expect(harness.deauthorized).toEqual([STRIPE, STRIPE]);
  });
});
