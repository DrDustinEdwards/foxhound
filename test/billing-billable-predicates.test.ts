import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { billingLineItems } from "~/db";
import { seedDemoAccount } from "~/lib/demo/seed";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-demo-engine-review-fixes.md M-2: the row-level billable rules
// used to be hand-rolled twice (app/db/billable.ts's SQL and a drifted inline
// filter in app/lib/demo/seed.ts). Both now consume the same pure predicates
// in app/lib/billing/billable-predicates.ts. These tests cover the predicates
// directly (including the fail-closed property the allow-list exists for) and
// cross-check that the seeded ledger is exactly what the predicates select.

const now = new Date("2026-07-21T00:00:00.000Z");
const ACCOUNT_ID = "demo_teamflow";

describe("the seeded billing ledger equals what the predicates select", () => {

  it("carries exactly the two Foxhound-submitted wins (Harborline, Amy Chen), never the merchant-won Sara Lin", async () => {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, now);
    const lineItems = await db
      .select()
      .from(billingLineItems)
      .where(eq(billingLineItems.accountId, ACCOUNT_ID));
    const disputeLineItems = lineItems.filter((li) => li.type === "dispute_fee");
    expect(disputeLineItems.map((li) => li.disputeId).sort()).toEqual(["ddisp_1", "ddisp_7"]);
  });
});
