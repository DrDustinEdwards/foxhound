import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SKIP UNTIL PRICED (Dustin, 2026-10-25).
//
// A won dispute whose $500 cap could not be converted at resolution has no
// stored fee, and its won notice carried no fee sentence. The
// billing run used to bill it anyway at disputeFeeCents(amount, 50,000): the
// flat cap in the dispute's own minor units, which 377(7) says is never used,
// and a fee the merchant was never told. Now the run leaves it out, the daily
// pricing retry stores the fee and tells the merchant, and the next run bills
// exactly the stored amount.
//
// The rate is fake and chosen so the converted cap (60,000 pence) differs from
// the old flat fallback (50,000 pence).

interface SentMessage {
  to: string;
  subject: string;
  text?: string;
}

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  seen: new Set<string>(),
  sent: [] as SentMessage[],
  failQuote: true,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { idempotencyKey: string; build: (db: unknown) => unknown[] }) => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      if (/UNIQUE constraint failed/.test(String(err))) return { applied: false };
      throw err;
    }
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({
    rawRequest: async (_method: string, path: string, params: Record<string, unknown>) => {
      if (path !== "/v1/fx_quotes") throw new Error(`unexpected stripe call ${path}`);
      if (harness.failQuote) throw new Error("stripe unavailable");
      return { id: "fxq_late", rates: { [String(params["from_currencies[0]"])]: { exchange_rate: 1.2 } } };
    },
  }),
  getConnectedStripe: () => {
    throw new Error("connected stripe must not be used here");
  },
}));

const { runAccountBilling } = await import("~/lib/billing/run");
const { priceUnpricedDisputeFees } = await import("~/lib/disputes/fee-pricing.server");

const ACCOUNT = "acct_unpriced";
const RESOLVED = new Date("2026-09-10T12:00:00.000Z");
const OCT_RUN = new Date("2026-10-01T04:00:00.000Z");
const PRICED = new Date("2026-10-15T03:00:00.000Z");
const NOV_RUN = new Date("2026-11-01T04:00:00.000Z");

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: `msg_${harness.sent.length}` };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  harness.seen = new Set();
  harness.sent = [];
  harness.failQuote = true;

  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', 1)",
    )
    .run(ACCOUNT);
  // Won, Foxhound-submitted and approved, but the quote failed at resolution.
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, submitted_at, resolved_at, resolved_fee_error, created_at) VALUES ('d1', ?, 'dp_1', 'ch_1', 1000000, 'gbp', 'fraudulent', 'won', 'resolved_won', 1000, ?, 'fx quote for usd->gbp failed: stripe unavailable', 1000)",
    )
    .run(ACCOUNT, RESOLVED.getTime());
  sqlite
    .prepare(
      "INSERT INTO dispute_approvals (id, dispute_id, account_id, evidence_version_hash, approved_at) VALUES ('a1', 'd1', ?, 'h1', 1000)",
    )
    .run(ACCOUNT);
});

function disputeLines() {
  return sqlite.prepare("SELECT amount_cents AS amount FROM billing_line_items WHERE dispute_id = 'd1'").all();
}

describe("an unpriced won dispute is skipped until priced, then billed at the stored fee", () => {
  it("skips the win, retries pricing, tells the merchant, then bills exactly the stored fee", async () => {
    // The run before pricing bills nothing for it, and marks nothing billed.
    await runAccountBilling(env, { accountId: ACCOUNT, nowMs: OCT_RUN.getTime() });
    expect(disputeLines()).toEqual([]);

    // A retry that still cannot get a quote leaves it unpriced and silent.
    const failed = await priceUnpricedDisputeFees(env, new Date(OCT_RUN.getTime() + 86_400_000));
    expect(failed).toMatchObject({ priced: 0, failed: 1 });
    expect(harness.sent).toEqual([]);

    // A retry that gets a quote stores the converted fee and tells the merchant.
    harness.failQuote = false;
    const priced = await priceUnpricedDisputeFees(env, PRICED);
    expect(priced).toMatchObject({ priced: 1, failed: 0 });
    const row = sqlite
      .prepare(
        "SELECT resolved_fee_cents AS fee, resolved_fee_currency AS cur, resolved_fee_quote_id AS quote, resolved_fee_error AS err FROM disputes WHERE id = 'd1'",
      )
      .get();
    expect(row).toEqual({ fee: 60_000, cur: "gbp", quote: "fxq_late", err: null });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].to).toBe("ops@acme.test");
    expect(harness.sent[0].text).toContain("Foxhound fee: £600.00");
    expect(harness.sent[0].text).toContain("This will be invoiced on 2026-11-01.");

    // A second retry finds nothing left to price and sends nothing more.
    expect(await priceUnpricedDisputeFees(env, PRICED)).toMatchObject({ priced: 0, failed: 0 });
    expect(harness.sent).toHaveLength(1);

    // The next run bills the stored fee, never the flat 50,000 fallback.
    await runAccountBilling(env, { accountId: ACCOUNT, nowMs: NOV_RUN.getTime() });
    expect(disputeLines()).toEqual([{ amount: 60_000 }]);
  });
});
