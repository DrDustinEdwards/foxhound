import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts, stripeConnections } from "~/db/schema";
import { buildBrandVoiceUpdate } from "~/lib/settings/persist.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Cross-tenant regression for account-scoping audit CRITICAL #1: a merchant must
// not be able to overwrite another merchant's brand_voice (which feeds their
// live dunning-email tone) by POSTing a foreign connectionId. Proven against a
// REAL in-memory SQLite with the committed schema, so the guard is
// database-enforced, not chain-dependent.

const now = new Date("2026-07-20T00:00:00.000Z");

function seedTwoMerchants() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_A", name: "Merchant A" }));
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_B", name: "Merchant B" }));
  runStatement(
    sqlite,
    db.insert(stripeConnections).values({
      id: "conn_A",
      accountId: "acc_A",
      stripeUserId: "acct_A",
      brandVoice: "A original voice",
      createdAt: now,
    }),
  );
  runStatement(
    sqlite,
    db.insert(stripeConnections).values({
      id: "conn_B",
      accountId: "acc_B",
      stripeUserId: "acct_B",
      brandVoice: "B original voice",
      createdAt: now,
    }),
  );
  return { sqlite, db };
}

async function brandVoiceOf(db: ReturnType<typeof createInMemoryDb>["db"], connectionId: string) {
  const rows = await db
    .select({ brandVoice: stripeConnections.brandVoice })
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId));
  return rows[0]?.brandVoice ?? null;
}

describe("CRITICAL #1: brand-voice update cannot cross tenants", () => {
  it("merchant A targeting merchant B's connection id writes ZERO rows and leaves B's voice intact", async () => {
    const { sqlite, db } = seedTwoMerchants();

    // A authenticated (accountId acc_A) POSTs B's connectionId.
    const changed = runStatement(sqlite, buildBrandVoiceUpdate(db, "acc_A", "conn_B", "HACKED BY A"));

    expect(changed).toBe(0);
    expect(await brandVoiceOf(db, "conn_B")).toBe("B original voice");
  });

  it("a merchant updating their OWN connection still works (one row changed)", async () => {
    const { sqlite, db } = seedTwoMerchants();

    const changed = runStatement(sqlite, buildBrandVoiceUpdate(db, "acc_A", "conn_A", "A new voice"));

    expect(changed).toBe(1);
    expect(await brandVoiceOf(db, "conn_A")).toBe("A new voice");
  });
});
