import { describe, expect, it } from "vitest";

import { cardChangedSinceDecline } from "~/lib/engine/card-change";
import { executeRetryStep, type RetryStepContext } from "~/lib/engine/retry-step";
import { classifyDecline, isRetryable } from "~/lib/recovery/decline";

// An expired card is retried on day 21 only when the card has changed since the decline, and a
// hard decline (transaction_not_allowed) is never silently retried.

describe("transaction_not_allowed is a hard decline", () => {
  it("is never silently retried", () => {
    const category = classifyDecline("transaction_not_allowed");
    expect(category).toBe("fraud");
    expect(isRetryable(category)).toBe(false);
  });
});

describe("cardChangedSinceDecline", () => {
  const declined = { fingerprint: "fp_A", expMonth: 9, expYear: 2026 };
  it("changed for a new expiry (the card updater) or a new number; unchanged for the same card or when unreadable", () => {
    expect(cardChangedSinceDecline(declined, { ...declined })).toBe(false);
    expect(cardChangedSinceDecline(declined, { ...declined, expYear: 2030 })).toBe(true);
    expect(cardChangedSinceDecline(declined, { ...declined, fingerprint: "fp_B" })).toBe(true);
    expect(cardChangedSinceDecline(null, declined)).toBe(false);
    expect(cardChangedSinceDecline(declined, null)).toBe(false);
    expect(
      cardChangedSinceDecline(declined, { fingerprint: null, expMonth: null, expYear: null }),
    ).toBe(false);
  });
});

describe("the expired day 21 retry charges only a changed card", () => {
  const ctx = (declineCategory: string): RetryStepContext => ({
    stepId: "step_21",
    failedPaymentId: "fp_1",
    accountId: "acc_1",
    invoiceId: "in_1",
    amountCents: 4200,
    currency: "usd",
    connectionAccessToken: "iv:cipher",
    declineCategory,
  });

  async function run(declineCategory: string, verdict: "changed" | "unchanged" | "unverified") {
    let charged = 0;
    let checked = 0;
    const patches: string[] = [];
    const res = await executeRetryStep({} as Env, ctx(declineCategory), {
      checkCardChanged: async () => {
        checked += 1;
        return verdict;
      },
      payInvoice: async () => {
        charged += 1;
        return { invoiceStatus: "paid" };
      },
      persistPatch: async (_env, _id, patch) => {
        patches.push(patch.result as string);
        return true;
      },
      reconcileRecovery: async () => true,
    });
    return { res, charged, checked, patches };
  }

  it("skips the charge when the card has not changed", async () => {
    const r = await run("expired", "unchanged");
    expect(r.charged).toBe(0);
    expect(r.patches).toEqual(["retry_skipped_card_unchanged"]);
    expect(r.res.recovered).toBe(false);
  });

  it("skips the charge when the change cannot be checked", async () => {
    const r = await run("expired", "unverified");
    expect(r.charged).toBe(0);
    expect(r.patches).toEqual(["retry_skipped_unverified"]);
  });

  it("charges when the card has changed", async () => {
    const r = await run("expired", "changed");
    expect(r.charged).toBe(1);
    expect(r.res.recovered).toBe(true);
  });

  it("does not check a soft decline's retry", async () => {
    const r = await run("soft", "unchanged");
    expect(r.checked).toBe(0);
    expect(r.charged).toBe(1);
  });
});
