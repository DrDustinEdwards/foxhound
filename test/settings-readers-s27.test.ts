
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S27's READER. The three merchant-context fields had a writer on /settings and
// no reader anywhere, under legacy's own help string "Used to personalize
// recovery emails". 336 binding 4 ruled the fix is the reader, not removing the
// fields.
//
// EVERY PLANT HERE CHANGES A COLUMN AND OBSERVES THE PROMPT, which is this
// reader's output. Asserting that a helper returns a string would not prove the
// value reaches the model; the path under test is
//   accounts row -> queryDueRecoverySteps -> toEmailContext -> buildUserPrompt.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { queryDueRecoverySteps, toEmailContext } = await import("~/lib/cron/due-steps");
const { buildUserPrompt } = await import("~/lib/recovery/email-generation");
const { buildGenerateEmailInput } = await import("~/lib/engine/execute-step");

const ACCOUNT = "acct_1";
const NOW = new Date(10_000_000);

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
});

function seedAccount(opts: {
  industry?: string | null;
  customerType?: string | null;
  mrrCents?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, merchant_industry, primary_customer_type, merchant_mrr_self_reported) VALUES (?, 'Acme', 1000, ?, ?, ?)",
    )
    .run(ACCOUNT, opts.industry ?? null, opts.customerType ?? null, opts.mrrCents ?? null);

  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, sender_name, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'Alex from Acme', 1000, 1000)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at, stripe_connection_id) VALUES ('fp1', ?, 'evt', 'in_1', 'cus_1', 'c@acme.test', 9900, 'usd', 'soft', 'active', 1000, 'c1')",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count) VALUES ('s1', ?, 'fp1', 'email', 1, 1000, 0)",
    )
    .run(ACCOUNT);
}

/** The whole path, from the stored row to the text the model receives. */
async function promptForAccount(): Promise<string> {
  const rows = await queryDueRecoverySteps({} as Env, NOW);
  expect(rows).toHaveLength(1);
  const ctx = toEmailContext(rows[0]);
  // buildGenerateEmailInput is the PRODUCTION assembly, not a hand-built
  // object. Hand-building it here left the link where the context is actually
  // attached uncovered, and a mutation that deleted those three lines went
  // green until this call replaced it.
  return buildUserPrompt(buildGenerateEmailInput("https://foxhoundapp.test/u/1", ctx));
}

describe("PLANT 1: each column reaches the prompt, observed at the output", () => {

  it("all three together, in legacy's order and joined by a space", async () => {
    seedAccount({ industry: "SaaS", customerType: "B2B", mrrCents: 500_000 });
    const prompt = await promptForAccount();
    expect(prompt).toContain(
      "Merchant context: SaaS business serving B2B customers with ~$5000/month MRR",
    );
  });
});

describe("PLANT 2: absent context produces NO line, never a placeholder", () => {
  it("a merchant who filled nothing gets no context line at all", async () => {
    seedAccount({});
    const prompt = await promptForAccount();
    expect(prompt).not.toContain("Merchant context");
    // And no empty artifact where the line would have been.
    expect(prompt).not.toContain("null");
    expect(prompt).not.toContain("undefined");
  });
});
