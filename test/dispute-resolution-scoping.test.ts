import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts, disputes } from "~/db/schema";
import { buildDisputeResolutionBatch, type WebhookClaimInput } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Cross-tenant regression for account-scoping audit HIGH #3: the dispute
// win/loss resolution UPDATE keys off the globally-unique Stripe dispute id, so
// it MUST also pin account_id in its own WHERE. Proven against a REAL in-memory
// SQLite: an attacker passing a foreign accountId with a victim's dispute id
// changes zero rows, so tenant isolation is database-enforced, not dependent on
// the caller's pre-check.

const now = new Date("2026-07-20T00:00:00.000Z");

const claim: WebhookClaimInput = {
  stripeEventId: "evt_1",
  eventType: "charge.dispute.closed",
  accountId: "acc_B",
  receivedAt: now,
  payload: {},
};

function seedDisputeForB() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_A", name: "Merchant A" }));
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_B", name: "Merchant B" }));
  runStatement(
    sqlite,
    db.insert(disputes).values({
      id: "dsp_B",
      accountId: "acc_B",
      stripeDisputeId: "dp_shared",
      stripeChargeId: "ch_B",
      amountCents: 50_000,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      state: "pending_review",
      submittedAt: now, // submitted, so a same-account win WOULD snapshot a fee
      createdAt: now,
    }),
  );
  return { sqlite, db };
}

async function disputeState(db: ReturnType<typeof createInMemoryDb>["db"]) {
  const rows = await db
    .select({ state: disputes.state, fee: disputes.resolvedFeeCents })
    .from(disputes)
    .where(and(eq(disputes.id, "dsp_B"), eq(disputes.accountId, "acc_B")));
  return rows[0];
}

describe("HIGH #3: dispute resolution UPDATE cannot cross tenants", () => {
  it("account A resolving B's dispute by its (global) Stripe dispute id writes ZERO rows", async () => {
    const { sqlite, db } = seedDisputeForB();

    // The attacker passes acc_A but the same globally-unique stripeDisputeId.
    const batch = buildDisputeResolutionBatch(db, {
      claim: { ...claim, accountId: "acc_A" },
      accountId: "acc_A",
      stripeDisputeId: "dp_shared",
      won: true,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion (377(7)).
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    const changed = runStatement(sqlite, batch[1]); // batch[1] is the disputes UPDATE

    expect(changed).toBe(0);
    const after = await disputeState(db);
    expect(after?.state).toBe("pending_review"); // untouched
    expect(after?.fee).toBeNull();
  });

  it("the owning account (acc_B) resolves the same dispute correctly (one row, fee snapshotted)", async () => {
    const { sqlite, db } = seedDisputeForB();

    const batch = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_B",
      stripeDisputeId: "dp_shared",
      won: true,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion (377(7)).
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    const changed = runStatement(sqlite, batch[1]);

    expect(changed).toBe(1);
    const after = await disputeState(db);
    expect(after?.state).toBe("resolved_won");
    expect(after?.fee).toBe(10_000); // 20% of $500
  });
});
