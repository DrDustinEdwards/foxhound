import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The daily dispute-fee pricing cron checks each fee priced in the last day
// against what Stripe actually withdrew (charge.dispute.funds_withdrawn, stored
// in dispute_balance_transactions). A fee priced on a different amount than
// Stripe took is logged as a structured warning; nothing about the fee changes.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { checkPricedFeesAgainstStripe } = await import("~/lib/disputes/fee-pricing.server");

const ACCOUNT = "acct_check";
const NOW = new Date("2026-10-15T03:00:00.000Z");
const RESOLVED = NOW.getTime() - 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function seed() {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  const dispute = sqlite.prepare(
    "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, resolved_at, resolved_fee_cents, resolved_fee_currency, created_at) VALUES (?, ?, ?, 'ch_1', ?, 'usd', 'fraudulent', 'won', 'resolved_won', ?, ?, 'usd', 1000)",
  );
  const withdrawn = sqlite.prepare(
    "INSERT INTO dispute_balance_transactions (id, account_id, stripe_dispute_id, stripe_balance_transaction_id, kind, amount_cents, fee_cents, currency, occurred_at, created_at) VALUES (?, ?, ?, ?, 'withdrawn', ?, 1500, ?, 1000, 1000)",
  );
  // Priced on what Stripe withdrew: no warning.
  dispute.run("d_ok", ACCOUNT, "dp_ok", 10_000, RESOLVED, 2_000);
  withdrawn.run("b_ok", ACCOUNT, "dp_ok", "txn_ok", -10_000, "usd");
  // Priced on 10,000 but Stripe withdrew 8,000: a warning.
  dispute.run("d_off", ACCOUNT, "dp_off", 10_000, RESOLVED, 2_000);
  withdrawn.run("b_off", ACCOUNT, "dp_off", "txn_off", -8_000, "usd");
  // Withdrawn in another currency: cannot be compared, skipped.
  dispute.run("d_fx", ACCOUNT, "dp_fx", 10_000, RESOLVED, 2_000);
  withdrawn.run("b_fx", ACCOUNT, "dp_fx", "txn_fx", -7_900, "gbp");
  return sqlite;
}

describe("the pricing cron checks priced fees against Stripe's withdrawal", () => {
  it("warns once for the fee priced on a different amount and changes nothing", async () => {
    const sqlite = seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await checkPricedFeesAgainstStripe({} as Env, NOW)).toBe(1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      event: "dispute_fee_stripe_mismatch",
      accountId: ACCOUNT,
      disputeId: "d_off",
      stripeDisputeId: "dp_off",
      currency: "usd",
      pricedFeeCents: 2_000,
      pricedOnCents: 10_000,
      stripeWithdrawnCents: 8_000,
      stripeDisputeFeeCents: 1_500,
    });
    expect(sqlite.prepare("SELECT resolved_fee_cents AS fee FROM disputes ORDER BY id").all()).toEqual([
      { fee: 2_000 },
      { fee: 2_000 },
      { fee: 2_000 },
    ]);
  });
});
