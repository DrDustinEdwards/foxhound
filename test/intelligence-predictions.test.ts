import { describe, expect, it } from "vitest";

import { gradeDuePredictions } from "~/lib/intelligence/predictions";

import { createInMemoryDb } from "./helpers/inmemory-db";

describe("gradeDuePredictions", () => {
  const ACCOUNT = "acct_grade";
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-11-26T03:00:00.000Z");

  function seed() {
    const { sqlite, db } = createInMemoryDb();
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)")
      .run(ACCOUNT);
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_other', 'Other', 1000)")
      .run();
    const customer = sqlite.prepare(
      "INSERT INTO customer_context (id, account_id, stripe_customer_id, mrr_contribution_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 1000)",
    );
    customer.run("cc_kept", ACCOUNT, "cus_kept", 5000);
    customer.run("cc_lost", ACCOUNT, "cus_lost", 0);
    // Same customer id in another account still pays; it must not make cus_lost look retained.
    customer.run("cc_other", "acct_other", "cus_lost", 9000);
    const prediction = sqlite.prepare(
      "INSERT INTO predictions (id, account_id, stripe_customer_id, score, horizon_days, predicted_at) VALUES (?, ?, ?, ?, 30, ?)",
    );
    prediction.run("p_kept", ACCOUNT, "cus_kept", 80, NOW - 31 * DAY);
    prediction.run("p_lost", ACCOUNT, "cus_lost", 20, NOW - 30 * DAY);
    prediction.run("p_gone", ACCOUNT, "cus_deleted", 35, NOW - 40 * DAY);
    prediction.run("p_young", ACCOUNT, "cus_kept", 75, NOW - 29 * DAY);
    prediction.run("p_other", "acct_other", "cus_lost", 50, NOW - 31 * DAY);
    return { sqlite, db };
  }

  it("grades only this account's due rows by whether the customer still pays", async () => {
    const { sqlite, db } = seed();

    expect(await gradeDuePredictions(db, ACCOUNT, NOW)).toBe(3);

    const rows = sqlite
      .prepare("SELECT id, realized_outcome, graded_at FROM predictions ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "p_gone", realized_outcome: "churned", graded_at: NOW },
      { id: "p_kept", realized_outcome: "retained", graded_at: NOW },
      { id: "p_lost", realized_outcome: "churned", graded_at: NOW },
      { id: "p_other", realized_outcome: null, graded_at: null },
      { id: "p_young", realized_outcome: null, graded_at: null },
    ]);
  });

  it("never regrades a graded row", async () => {
    const { db } = seed();
    await gradeDuePredictions(db, ACCOUNT, NOW);
    expect(await gradeDuePredictions(db, ACCOUNT, NOW)).toBe(0);
    // A day later only the young row has come due.
    expect(await gradeDuePredictions(db, ACCOUNT, NOW + DAY)).toBe(1);
  });
});
