import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { grantIntelligence, revokeIntelligence } from "~/lib/admin/merchants.server";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Admin Intelligence grant path (audit #C: the paid tier was INERT for every
// account because nothing wrote account_subscriptions). Proves the grant flips
// the SAME gate the /intelligence/* loaders read (isIntelligenceEntitled), that
// revoke closes it again, and that granting is idempotent. Real migrated schema
// via in-memory sqlite, so the row shape (admin_granted, no stripe fields) is
// exercised, not just SQL text.

const now = new Date("2026-07-21T00:00:00.000Z");

async function seedAccount(db: ReturnType<typeof createInMemoryDb>["db"]) {
  await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme" });
}

describe("intelligence entitlement grant/revoke", () => {

  it("revoke closes the gate again", async () => {
    const { db } = createInMemoryDb();
    await seedAccount(db);

    await grantIntelligence(db, "acc_1", now);
    const revoke = await revokeIntelligence(db, "acc_1", now);
    expect(revoke.revoked).toBe(true);
    expect(await isIntelligenceEntitled(db, "acc_1")).toBe(false);
  });

  it("double grant is a no-op, not a duplicate row", async () => {
    const { db } = createInMemoryDb();
    await seedAccount(db);

    const first = await grantIntelligence(db, "acc_1", now);
    const second = await grantIntelligence(db, "acc_1", now);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);

    const rows = await db
      .select({ id: schema.accountSubscriptions.id })
      .from(schema.accountSubscriptions)
      .where(eq(schema.accountSubscriptions.accountId, "acc_1"));
    expect(rows).toHaveLength(1);
  });

  it("revoke with no active subscription is a no-op, not an error", async () => {
    const { db } = createInMemoryDb();
    await seedAccount(db);
    const result = await revokeIntelligence(db, "acc_1", now);
    expect(result.revoked).toBe(false);
    expect(await isIntelligenceEntitled(db, "acc_1")).toBe(false);
  });
});
