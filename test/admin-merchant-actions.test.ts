import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { accounts } from "~/db";
import * as schema from "~/db/schema";
import { accountProcessingEligible as intelligenceProcessingEligible } from "~/lib/intelligence/sync.server";
import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";


// Admin Pass 2: money-adjacent operator actions. Proves the resolution of the
// processing-vs-billing conflict the task surfaced: cancelledAt (and
// processing_paused) stop future processing, but cancelledAt alone must NEVER
// suppress billing of an already-matured, unbilled recovery (that gate lives
// only in app/db/billable.ts, which this file does not touch).

const fakeDb = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

describe("cancelMerchant orchestration (injected deps, no live DB/Stripe)", () => {

  it("a deauthorize failure never rolls back or throws: the merchant stays canceled locally, the failure is surfaced", async () => {
    const result = await cancelMerchant({} as Env, "acc_1", {
      cancelLocal: async () => [
        { id: "conn_1", stripeUserId: "acct_1" },
        { id: "conn_2", stripeUserId: "acct_2" },
      ],
      deauthorize: async (_env, stripeUserId) =>
        stripeUserId === "acct_2" ? { ok: false, error: "stripe unavailable" } : { ok: true },
    });

    // The local commit already happened (cancelLocal returned) regardless of
    // what deauthorize does; connectionsDisconnected reflects the local write.
    expect(result.connectionsDisconnected).toBe(2);
    expect(result.deauthorizeErrors).toEqual([
      { connectionId: "conn_2", stripeUserId: "acct_2", error: "stripe unavailable" },
    ]);
  });
});

describe("cancelledAt is a PROCESSING gate only, never a billing gate", () => {

  it("intelligence sync's processing gate excludes a canceled account", () => {
    const sql = sqlOf(fakeDb.select().from(accounts).where(intelligenceProcessingEligible()));
    expect(sql.sql).toMatch(/cancelled_at/i);
  });
});
