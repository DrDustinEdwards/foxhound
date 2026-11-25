import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { authContext } from "~/lib/auth/context";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/disputes/index");
const { createInMemoryDb } = await import("./helpers/inmemory-db");

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("the loader", () => {
  const ACCOUNT = "acct_list";
  let env: Env;
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];

  function context() {
    return {
      get(key: unknown) {
        if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext };
        if (key === authContext)
          return { email: "owner@example.com", membership: { accountId: ACCOUNT }, isDemo: false };
        throw new Error("unexpected context key");
      },
    } as never;
  }

  function dispute(
    id: string,
    createdAt: number,
    deadline: number,
    currency = "usd",
    amount = 4_900,
  ) {
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, evidence_deadline, created_at) VALUES (?, ?, ?, ?, ?, 'Ada', ?, ?, 'fraudulent', 'needs_response', 'pending_review', ?, ?)",
      )
      .run(id, ACCOUNT, `dp_${id}`, `ch_${id}`, `cus_${id}`, amount, currency, deadline, createdAt);
  }

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    env = {} as Env;
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)")
      .run(ACCOUNT);
  });

  const load = () =>
    route.loader({
      context: context(),
      request: new Request("https://x.test/disputes"),
      params: {},
    } as never) as Promise<{
      disputes: { id: string }[];
      stats: {
        openCount: number;
        atStake: { currency: string; cents: number }[];
        submittedByFoxhoundCount: number;
        feesOwed: { currency: string; cents: number }[];
      };
      health: Record<string, number> | null;
      withEvidence: string[];
    }>;

  /** A won dispute Foxhound submitted, with its approval row, as billing sees it. */
  function wonBilled(id: string, account: string, feeCents: number, currency = "usd") {
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, submitted_at, submitted_by, resolved_at, resolved_fee_cents, resolved_fee_currency, created_at) VALUES (?, ?, ?, ?, ?, 'Ada', ?, ?, 'fraudulent', 'needs_response', 'resolved_won', 900, 'owner@example.com', 1000, ?, ?, 800)",
      )
      .run(
        id,
        account,
        `dp_${id}`,
        `ch_${id}`,
        `cus_${id}`,
        feeCents * 5,
        currency,
        feeCents,
        currency,
      );
    sqlite
      .prepare(
        "INSERT INTO dispute_approvals (id, dispute_id, account_id, approved_by_email, evidence_version_hash, approved_at) VALUES (?, ?, ?, 'owner@example.com', 'h', 900)",
      )
      .run(`appr_${id}`, id, account);
  }

  function invoice(id: string, account: string, status: string, currency = "usd") {
    sqlite
      .prepare(
        "INSERT INTO billing_invoices (id, account_id, currency, period_start, period_end, status, total_cents, idempotency_key, created_at) VALUES (?, ?, ?, 1, 2, ?, 0, ?, 3)",
      )
      .run(id, account, currency, status, `idem_${id}`);
  }

  function feeLine(
    id: string,
    invoiceId: string,
    account: string,
    disputeId: string,
    cents: number,
    currency = "usd",
  ) {
    sqlite
      .prepare(
        "INSERT INTO billing_line_items (id, invoice_id, account_id, type, currency, amount_cents, fee_cents, dispute_id, created_at) VALUES (?, ?, ?, 'dispute_fee', ?, ?, ?, ?, 4)",
      )
      .run(id, invoiceId, account, currency, cents, cents, disputeId);
  }

  function creditLine(
    id: string,
    invoiceId: string,
    account: string,
    feeLineId: string,
    cents: number,
  ) {
    sqlite
      .prepare(
        "INSERT INTO billing_line_items (id, invoice_id, account_id, type, currency, amount_cents, credits_line_item_id, created_at) VALUES (?, ?, ?, 'credit', 'usd', ?, ?, 5)",
      )
      .run(id, invoiceId, account, -cents, feeLineId);
  }

  const byCurrency = (rows: { currency: string; cents: number }[]) =>
    [...rows].sort((a, b) => a.currency.localeCompare(b.currency));

  it("counts the disputes Foxhound submitted", async () => {
    wonBilled("w1", ACCOUNT, 1_000);
    dispute("open", NOW - DAY, NOW + DAY);
    expect((await load()).stats.submittedByFoxhoundCount).toBe(1);
  });

  it("owes the fees still pending or invoiced, and none already paid, void or credited", async () => {
    // Pending: a billable win with no fee line yet, at the fee the next run bills.
    wonBilled("pending", ACCOUNT, 1_500);
    // Invoiced and not yet paid: owed.
    wonBilled("invoiced", ACCOUNT, 700, "eur");
    invoice("inv_open", ACCOUNT, "finalized", "eur");
    feeLine("li_open", "inv_open", ACCOUNT, "invoiced", 700, "eur");
    // A charge that failed is still owed: the retry sweep still chases it.
    wonBilled("failed", ACCOUNT, 300);
    invoice("inv_failed", ACCOUNT, "payment_failed");
    feeLine("li_failed", "inv_failed", ACCOUNT, "failed", 300);
    // Paid: drops off.
    wonBilled("paid", ACCOUNT, 900);
    invoice("inv_paid", ACCOUNT, "paid");
    feeLine("li_paid", "inv_paid", ACCOUNT, "paid", 900);
    // Void: never going to be collected.
    wonBilled("void", ACCOUNT, 400);
    invoice("inv_void", ACCOUNT, "void");
    feeLine("li_void", "inv_void", ACCOUNT, "void", 400);
    // Invoiced, then credited in full: nothing left owed.
    wonBilled("credited", ACCOUNT, 2_000);
    invoice("inv_cred", ACCOUNT, "finalized");
    feeLine("li_cred", "inv_cred", ACCOUNT, "credited", 2_000);
    invoice("inv_note", ACCOUNT, "finalized");
    creditLine("li_note", "inv_note", ACCOUNT, "li_cred", 2_000);

    expect(byCurrency((await load()).stats.feesOwed)).toEqual([
      { currency: "eur", cents: 700 },
      { currency: "usd", cents: 1_800 },
    ]);
  });

  it("reports which disputes hold drafted evidence, so a status says Evidence ready only then", async () => {
    dispute("drafted", NOW - DAY, NOW + DAY);
    dispute("blank", NOW - 2 * DAY, NOW + DAY);
    dispute("none", NOW - 3 * DAY, NOW + DAY);
    const evidence = sqlite.prepare(
      "INSERT INTO dispute_evidence (id, dispute_id, account_id, field_name, field_value, created_at) VALUES (?, ?, ?, ?, ?, 1)",
    );
    evidence.run(
      "e1",
      "drafted",
      ACCOUNT,
      "product_description",
      "Annual plan, delivered by email.",
    );
    evidence.run("e2", "blank", ACCOUNT, "product_description", "   ");
    expect((await load()).withEvidence).toEqual(["drafted"]);
  });
});
