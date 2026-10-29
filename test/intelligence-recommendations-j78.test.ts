import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J78 (row S20): the nightly scoring batch writes each customer's recommended
// action to customer_context.recommended_action, logs it with an empty outcome
// slot, and /intelligence/recommendations reads that column. Before this, the
// page's Recova original read a field nothing ever wrote (RULES.md 3.18).

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { runIntelligenceAiForAccount } = await import("~/lib/intelligence/ai-run.server");
const route = await import("~/routes/app/intelligence/recommendations");

const ACCOUNT = "acct_rec";
const NOW = Date.parse("2026-10-25T03:00:00.000Z");
const DAY = 86_400_000;

let sqlite: Database.Database;

const env = { BETTER_AUTH_URL: "https://foxhound.example.com" } as unknown as Env;

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {}, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          email: "owner@acme.test",
          isDemo: false,
          membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          memberships: [],
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO account_subscriptions (id, account_id, product, status, created_at) VALUES ('sub_i', ?, 'intelligence', 'active', 1000)",
    )
    .run(ACCOUNT);
  const customer = sqlite.prepare(
    "INSERT INTO customer_context (id, account_id, stripe_customer_id, customer_name, current_plan_name, mrr_contribution_cents, currency, recovery_signals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'usd', ?, 1000, 1000)",
  );
  const oneFailure = JSON.stringify({ failedPaymentCount: 1, recoveredCount: 0, avgDaysToRecover: null });
  // cus_big: the top of the account by MRR, three recovery emails this month
  // and no tracked open, so Recova's table says reach out personally.
  customer.run("cc_big", ACCOUNT, "cus_big", "Big Co", "Scale plan", 50_000, oneFailure);
  // cus_mid: 75th percentile with no email history: watch closely.
  customer.run("cc_mid", ACCOUNT, "cus_mid", "Mid Co", "Growth plan", 3_000, null);
  // cus_small: low value, no history: the automated flow, not on the page.
  customer.run("cc_small", ACCOUNT, "cus_small", "Small Co", null, 1_000, null);
  customer.run("cc_two", ACCOUNT, "cus_two", "Two Co", null, 2_000, null);

  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) VALUES ('fp_big', ?, 'evt_1', 'in_1', 'cus_big', 'buyer@example.com', 50000, 'usd', 'soft', 'active', ?)",
    )
    .run(ACCOUNT, NOW - 20 * DAY);
  const step = sqlite.prepare(
    "INSERT INTO recovery_steps (id, failed_payment_id, step_type, step_number, scheduled_at, executed_at, result, account_id) VALUES (?, 'fp_big', 'email', ?, ?, ?, 'email_sent', ?)",
  );
  [1, 2, 3].forEach((n) => step.run(`rs_${n}`, n, NOW - n * DAY, NOW - n * DAY, ACCOUNT));
});

describe("recommendations, from the nightly batch to the page", () => {
  it("the batch writes the action and logs it with an empty outcome slot", async () => {
    await runIntelligenceAiForAccount(env, ACCOUNT, NOW);

    const actions = sqlite
      .prepare("SELECT stripe_customer_id, recommended_action FROM customer_context ORDER BY stripe_customer_id")
      .all();
    expect(actions).toEqual([
      { stripe_customer_id: "cus_big", recommended_action: "personal_outreach" },
      { stripe_customer_id: "cus_mid", recommended_action: "continue_automated_priority" },
      { stripe_customer_id: "cus_small", recommended_action: "continue_automated" },
      { stripe_customer_id: "cus_two", recommended_action: "continue_automated" },
    ]);

    const log = sqlite
      .prepare(
        "SELECT action, engagement_band, recovery_band, value_band, outcome, outcome_at FROM recommendation_log WHERE stripe_customer_id = 'cus_big'",
      )
      .all();
    expect(log).toEqual([
      {
        action: "personal_outreach",
        engagement_band: "red",
        recovery_band: "unknown",
        value_band: "high",
        outcome: null,
        outcome_at: null,
      },
    ]);
  });

  it("the page reads the action the batch wrote, highest MRR first", async () => {
    await runIntelligenceAiForAccount(env, ACCOUNT, NOW);

    const data = (await route.loader({
      context: ctx(),
      request: new Request("https://foxhound.example.com/intelligence/recommendations"),
      params: {},
    } as never)) as {
      rows: { stripeCustomerId: string; recommendedAction: string; planName: string | null }[];
      totalCount: number;
    };

    expect(data.totalCount).toBe(2);
    expect(data.rows.map((r) => [r.stripeCustomerId, r.recommendedAction, r.planName])).toEqual([
      ["cus_big", "personal_outreach", "Scale plan"],
      ["cus_mid", "continue_automated_priority", "Growth plan"],
    ]);
  });
});
