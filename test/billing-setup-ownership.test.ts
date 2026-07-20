import { describe, expect, it } from "vitest";

import {
  assertSessionBelongsToAccount,
  finalizeBillingSetupSession,
} from "~/lib/billing/platform-customer";

// Cross-tenant regression for account-scoping audit HIGH #2: the return-leg
// session_id is an unauthenticated URL param, so finalize must verify the
// session's customer belongs to the calling account before any
// stripe.customers.update. A foreign session must reject with zero writes.

describe("HIGH #2: billing-setup finalize rejects a session it does not own", () => {
  it("assertSessionBelongsToAccount rejects a foreign customer and a null expected id", () => {
    expect(assertSessionBelongsToAccount({ customer: "cus_B" }, "cus_A").ok).toBe(false);
    expect(assertSessionBelongsToAccount({ customer: "cus_B" }, null).ok).toBe(false);
    expect(assertSessionBelongsToAccount({ customer: null }, "cus_A").ok).toBe(false);
    const owned = assertSessionBelongsToAccount({ customer: "cus_A" }, "cus_A");
    expect(owned).toEqual({ ok: true, customerId: "cus_A" });
    // Expanded-object customer is handled too.
    expect(assertSessionBelongsToAccount({ customer: { id: "cus_A" } }, "cus_A").ok).toBe(true);
  });

  it("finalize NEVER calls stripe.customers.update when the session belongs to another account", async () => {
    let updateCalls = 0;
    const result = await finalizeBillingSetupSession(
      {} as Env,
      { sessionId: "cs_B", expectedCustomerId: "cus_A" }, // I am acc_A (cus_A)...
      {
        // ...but the retrieved session is merchant B's completed session (cus_B).
        retrieveSession: async () =>
          ({
            status: "complete",
            customer: "cus_B",
            setup_intent: { payment_method: "pm_B" },
          }) as never,
        setDefaultPaymentMethod: async () => {
          updateCalls += 1;
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(updateCalls).toBe(0); // the mutation gate held: zero writes to B's customer
  });

  it("finalize DOES set the default payment method for a session the account owns", async () => {
    const calls: { customerId: string; paymentMethodId: string }[] = [];
    const result = await finalizeBillingSetupSession(
      {} as Env,
      { sessionId: "cs_A", expectedCustomerId: "cus_A" },
      {
        retrieveSession: async () =>
          ({
            status: "complete",
            customer: "cus_A",
            setup_intent: { payment_method: "pm_A" },
          }) as never,
        setDefaultPaymentMethod: async (customerId, paymentMethodId) => {
          calls.push({ customerId, paymentMethodId });
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ customerId: "cus_A", paymentMethodId: "pm_A" }]);
  });
});
