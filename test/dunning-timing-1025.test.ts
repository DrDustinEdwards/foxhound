import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cardChangedSinceDecline } from "~/lib/engine/card-change";
import { executeRetryStep, type RetryStepContext } from "~/lib/engine/retry-step";
import { classifyDecline, isRetryable } from "~/lib/recovery/decline";
import { planRecoverySteps } from "~/lib/recovery/schedule";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Dustin's 2026-10-25 decision card, "Yes, all three", on the October dunning
// research (research/dunning-wording-and-timing-2026-10-15.md).

const HOUR = 3_600_000;
const anchor = new Date("2026-10-01T00:00:00.000Z");

function plan(declineCategory: "soft" | "expired") {
  return planRecoverySteps({ failedPaymentId: "fp", accountId: "acc", declineCategory, detectedAt: anchor });
}

describe("soft decline: the day 1 email goes 1 hour after the 4 hour silent retry", () => {
  it("plans email_day1 at 5 hours, after retry_early", () => {
    const steps = plan("soft");
    const at = (type: string) => steps.find((s) => s.stepType === type)!.scheduledAt.getTime() - anchor.getTime();
    expect(at("retry_early")).toBe(4 * HOUR);
    expect(at("email_day1")).toBe(5 * HOUR);
  });
});

describe("expired card: Recova's day 21 retry is back", () => {
  it("plans Recova's expired row", () => {
    expect(plan("expired").map((s) => [s.stepType, (s.scheduledAt.getTime() - anchor.getTime()) / HOUR])).toEqual([
      ["email_day1", 1],
      ["email_day3", 72],
      ["email_day7", 168],
      ["email_day14", 336],
      ["retry_day21", 504],
      ["email_day30", 720],
    ]);
  });
});

describe("transaction_not_allowed is a hard decline", () => {
  it("is never silently retried", () => {
    const category = classifyDecline("transaction_not_allowed");
    expect(category).toBe("fraud");
    expect(isRetryable(category)).toBe(false);
  });
});

describe("cardChangedSinceDecline: Mastercard's same number and expiry rule", () => {
  const declined = { fingerprint: "fp_A", expMonth: 9, expYear: 2026 };
  it("is unchanged for the same card number and expiry", () => {
    expect(cardChangedSinceDecline(declined, { ...declined })).toBe(false);
  });
  it("is changed for a new expiry on the same card (the card updater)", () => {
    expect(cardChangedSinceDecline(declined, { ...declined, expYear: 2030 })).toBe(true);
  });
  it("is changed for a different card number", () => {
    expect(cardChangedSinceDecline(declined, { ...declined, fingerprint: "fp_B" })).toBe(true);
  });
  it("is unchanged when either side cannot be read", () => {
    expect(cardChangedSinceDecline(null, declined)).toBe(false);
    expect(cardChangedSinceDecline(declined, null)).toBe(false);
    expect(cardChangedSinceDecline(declined, { fingerprint: null, expMonth: null, expYear: null })).toBe(false);
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

describe("migration 0040: sequences already scheduled", () => {
  it("moves unsent soft day 1 emails to 5 hours, adds the expired day 21 retry, refiles live transaction_not_allowed payments, leaves sent steps, and is idempotent", () => {
    const migration = readFileSync(
      new URL("../drizzle/migrations/0040_dunning_timing.sql", import.meta.url),
      "utf8",
    );
    const { sqlite } = createInMemoryDb();
    const t = anchor.getTime();
    sqlite.prepare("insert into accounts (id, name) values ('acc', 'acc')").run();
    const payment = (id: string, category: string) =>
      sqlite
        .prepare(
          "insert into failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) values (?, 'acc', ?, ?, 'c', 'x@example.com', 4200, 'usd', ?, 'active', 0)",
        )
        .run(id, `e_${id}`, `i_${id}`, category);
    const step = (fp: string, type: string, n: number, hours: number, executed = false) =>
      sqlite
        .prepare(
          "insert into recovery_steps (id, failed_payment_id, account_id, step_type, step_number, scheduled_at, executed_at, result) values (?, ?, 'acc', ?, ?, ?, ?, ?)",
        )
        .run(`${fp}_${type}`, fp, type, n, t + hours * HOUR, executed ? t : null, executed ? "email_sent" : null);

    payment("soft_pending", "soft");
    step("soft_pending", "retry_early", 1, 4);
    step("soft_pending", "email_day1", 2, 24);
    payment("soft_sent", "soft");
    step("soft_sent", "retry_early", 1, 4, true);
    step("soft_sent", "email_day1", 2, 24, true);

    const expiredRow = [["email_day1", 1], ["email_day3", 72], ["email_day7", 168], ["email_day14", 336], ["email_day30", 720]] as const;
    payment("exp_live", "expired");
    expiredRow.forEach(([type, hours], i) => step("exp_live", type, i + 1, hours));
    payment("exp_done", "expired");
    expiredRow.forEach(([type, hours], i) => step("exp_done", type, i + 1, hours, true));

    // Filed as soft before transaction_not_allowed became a hard decline.
    payment("tna_live", "soft");
    sqlite.prepare("update failed_payments set decline_code = 'transaction_not_allowed' where id = 'tna_live'").run();
    step("tna_live", "retry_early", 1, 4, true);
    step("tna_live", "email_day1", 2, 24);
    step("tna_live", "retry_day2", 3, 48);

    sqlite.exec(migration);
    sqlite.exec(migration);

    const rows = (fp: string) =>
      sqlite
        .prepare("select step_type as type, step_number as n, scheduled_at as at from recovery_steps where failed_payment_id = ? order by scheduled_at")
        .all(fp) as { type: string; n: number; at: number }[];
    const offsets = (fp: string) => rows(fp).map((r) => [r.type, r.n, (r.at - t) / HOUR]);

    expect(offsets("soft_pending")).toEqual([["retry_early", 1, 4], ["email_day1", 2, 5]]);
    expect(offsets("soft_sent")).toEqual([["retry_early", 1, 4], ["email_day1", 2, 24]]);
    expect(offsets("exp_live")).toEqual([
      ["email_day1", 1, 1],
      ["email_day3", 2, 72],
      ["email_day7", 3, 168],
      ["email_day14", 4, 336],
      ["retry_day21", 5, 504],
      ["email_day30", 6, 720],
    ]);
    expect(rows("exp_done").some((r) => r.type === "retry_day21")).toBe(false);

    // A live transaction_not_allowed payment is refiled as fraud and its unsent
    // retry is cancelled, so it is never silently retried; its email keeps its time.
    const tna = sqlite
      .prepare("select step_type as type, result, scheduled_at as at from recovery_steps where failed_payment_id = 'tna_live' order by step_number")
      .all() as { type: string; result: string | null; at: number }[];
    expect(tna.map((r) => [r.type, r.result, (r.at - t) / HOUR])).toEqual([
      ["retry_early", "email_sent", 4],
      ["email_day1", null, 24],
      ["retry_day2", "cancelled", 48],
    ]);
    expect(
      (sqlite.prepare("select decline_category as c from failed_payments where id = 'tna_live'").get() as { c: string }).c,
    ).toBe("fraud");
  });
});
