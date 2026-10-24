import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, stripeConnections } from "~/db";
import { disconnectConnection } from "~/lib/admin/merchant-cancel.server";
import { retryFailedDeauthorizations } from "~/lib/stripe/deauthorize-retry.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Grok audit FH-7: a Stripe grant whose revoke failed after a disconnect is
// queued on its connection row and retried until Stripe accepts, and never
// revoked once the same Stripe account is live on Foxhound again.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const ENV = {} as Env;
const CREATED = new Date("2026-10-01T00:00:00Z");
const failing = async () => ({ ok: false, error: "stripe unavailable" });

let db: ReturnType<typeof createInMemoryDb>["db"];
beforeEach(async () => {
  db = createInMemoryDb().db;
  harness.db = db;
  await db.insert(accounts).values([
    { id: "acct_a", name: "Sample A", createdAt: CREATED },
    { id: "acct_b", name: "Sample B", createdAt: CREATED },
  ]);
  await db.insert(stripeConnections).values({ id: "sc_a", accountId: "acct_a", stripeUserId: "acct_1Sample", createdAt: CREATED });
});

const pendingOf = async (id: string) =>
  (await db.select().from(stripeConnections).where(eq(stripeConnections.id, id)))[0].deauthorizeFailedAt;

describe("the Stripe deauthorize retry", () => {
  it("queues a failed revoke, keeps it while Stripe fails, and clears it once Stripe accepts", async () => {
    const out = await disconnectConnection(ENV, { id: "sc_a", stripeUserId: "acct_1Sample" }, { deauthorize: failing });
    expect(out.deauthorizeError).toBe("stripe unavailable");
    expect(await pendingOf("sc_a")).not.toBeNull();

    const again = await retryFailedDeauthorizations(ENV, db, failing);
    expect(again.failed.map((f) => f.connectionId)).toEqual(["sc_a"]);
    expect(await pendingOf("sc_a")).not.toBeNull();

    const calls: string[] = [];
    const ok = await retryFailedDeauthorizations(ENV, db, async (_env, stripeUserId) => {
      calls.push(stripeUserId);
      return { ok: true };
    });
    expect(calls).toEqual(["acct_1Sample"]);
    expect(ok).toMatchObject({ revoked: 1, failed: [] });
    expect(await pendingOf("sc_a")).toBeNull();
  });

  it("never revokes a Stripe account that is live on a Foxhound account again", async () => {
    await disconnectConnection(ENV, { id: "sc_a", stripeUserId: "acct_1Sample" }, { deauthorize: failing });
    await db.insert(stripeConnections).values({ id: "sc_b", accountId: "acct_b", stripeUserId: "acct_1Sample", createdAt: CREATED });

    const calls: string[] = [];
    const result = await retryFailedDeauthorizations(ENV, db, async (_env, stripeUserId) => {
      calls.push(stripeUserId);
      return { ok: true };
    });
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ revoked: 0, superseded: 1 });
    expect(await pendingOf("sc_a")).toBeNull();
  });
});
