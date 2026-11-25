import { type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts } from "~/db";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { accountProcessingEligible } from "~/lib/intelligence/sync.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The demo account never appears in an account enumeration leading to a Stripe or AI call; the id prefix alone excludes it.

const now = new Date("2026-07-21T00:00:00.000Z");

async function ids(
  db: ReturnType<typeof createInMemoryDb>["db"],
  condition: SQL | undefined,
): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(condition);
  return rows.map((r) => r.id);
}

describe("demo account is firewalled out of every Stripe/AI account enumeration", () => {
  async function setup() {
    const { db } = createInMemoryDb();
    // The real seeded demo account (exempt + paused + demo_ id).
    await seedDemoAccount(db, now);
    // A normal, fully-eligible real account.
    await db
      .insert(accounts)
      .values({ id: "acc_real", name: "Real", billingExempt: false, processingPaused: false });
    // A demo-PREFIXED account with NO pause/exempt flags: proves the prefix itself
    // is the firewall, independent of the flags.
    await db
      .insert(accounts)
      .values({ id: "demo_probe", name: "Probe", billingExempt: false, processingPaused: false });
    return db;
  }

  it("intelligence sync + AI (accountProcessingEligible) excludes both demo accounts", async () => {
    const db = await setup();
    const eligible = await ids(db, accountProcessingEligible());
    expect(eligible).toContain("acc_real");
    expect(eligible).not.toContain(DEMO_ACCOUNT_ID);
    expect(eligible).not.toContain("demo_probe");
  });
});
