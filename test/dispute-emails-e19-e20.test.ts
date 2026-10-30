import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J93, parity rows E19 and E20: the dispute won and lost
// notices say and carry what Recova's say, on Capsomer's `notice` template, as
// E16 and E17 do (PR 162). Recova's spec, read whole at HEAD:
//   lib/disputes-email.ts     blob 156719f1 (sendDisputeOutcomeEmail, lines 196 to 245)
//   lib/email.ts              blob 3f882729 (wrapEmailHtml, the footer)
//   lib/dispute-handlers.ts   blob e2bb8de8 (handleDisputeClosed, the trigger)
//   lib/constants.ts          blob a21b32b8 (DISPUTES_FEE_PCT 20, FROM_DISPUTES)
//
// J06 built the trigger, the skips and the once-only claim, and its own tests
// (dispute-notices-j06) hold them; this file holds what each mail SAYS and
// CARRIES, read from the message the binding is handed, and that it is sent on
// Recova's trigger (charge.dispute.closed, won or lost) and not otherwise.
//
// THE FEE SENTENCE. Recova: "Recova fee: <fee> (20% of the saved amount). This
// will be invoiced on <the first of next month>." PRICING.md agrees on 20% and
// on the next monthly run (04:00 UTC on the 1st), and adds the $500 cap, which
// Recova did not have (lib/dispute-fees.ts, blob 00b58c14). The sentence is
// Recova's while the percentage governs, and names the cap only when the cap
// is what set the fee, so it is never untrue.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  seen: new Set<string>(),
  sent: [] as SentMessage[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { idempotencyKey: string; build: (db: unknown) => unknown[] },
  ) => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(
        write.build(harness.db),
      );
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      if (/UNIQUE constraint failed/.test(String(err)))
        return { applied: false };
      throw err;
    }
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

// A lost close looks for a billed fee line to credit; there is none here.
vi.mock("~/lib/billing/credit-note", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/billing/credit-note")>()),
  issueCreditNoteForEvidence: async () => ({
    credited: false,
    reason: "no_charged_fee_line",
  }),
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { outcomeNotice, DISPUTE_OUTCOME_TEMPLATE } =
  await import("~/lib/disputes/notices");

const ACCOUNT = "acct_1";
const BASE = "https://foxhoundapp.test";
const LIST = `${BASE}/disputes/dashboard`;
const RECEIVED = new Date("2026-11-10T12:00:00Z");
const YEAR = new Date().getUTCFullYear();

/** Recova's wrapEmailHtml footer sentence, for a given sender name. */
const footerNote = (sender: string) =>
  `You're receiving this from ${sender} about a recent payment. © ${YEAR}`;

function makeEnv(baseUrl = BASE): Env {
  return {
    ENCRYPTION_KEY: "ab".repeat(32),
    BETTER_AUTH_URL: baseUrl,
    EMAIL: {
      send: async (m: SentMessage) => {
        harness.sent.push(m);
        return { id: `msg_${harness.sent.length}` };
      },
    },
  } as unknown as Env;
}
const env = makeEnv();

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  harness.seen = new Set();
  harness.sent = [];
});

function seedAccount(
  opts: { senderName?: string | null; paused?: boolean; exempt?: boolean } = {},
) {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, processing_paused, billing_exempt, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', ?, ?, 1)",
    )
    .run(ACCOUNT, opts.paused ? 1 : 0, opts.exempt ? 1 : 0);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at, sender_name) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000, ?)",
    )
    .run(
      ACCOUNT,
      opts.senderName === undefined ? "Acme Billing" : opts.senderName,
    );
}

/** A dispute still open, for the webhook to close. */
function seedOpenDispute(
  opts: { submitted?: boolean; amountCents?: number } = {},
) {
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, customer_name, customer_email, amount_cents, currency, reason, status, state, submitted_at, created_at, stripe_connection_id) VALUES ('d1', ?, 'dp_1', 'ch_1', 'Jane Buyer', 'buyer@acme.test', ?, 'usd', 'product_not_received', 'under_review', 'submitted', ?, 1000, 'c1')",
    )
    .run(
      ACCOUNT,
      opts.amountCents ?? 5000,
      opts.submitted === false ? null : 2000,
    );
}


function closedEvent(status: string, id = "evt_x1", amount = 5000) {
  return {
    id,
    type: "charge.dispute.closed",
    account: "acct_stripe",
    data: {
      object: {
        id: "dp_1",
        object: "dispute",
        charge: "ch_1",
        amount,
        currency: "usd",
        status,
      },
    },
  } as never;
}

function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

const base = {
  amountCents: 5000,
  currency: "usd",
  reason: "product_not_received",
  feeCurrency: "usd",
  listUrl: LIST,
};

// ============================================================================
// E19: what it says
// ============================================================================

describe("E19 says what Recova's won notice says, as a Capsomer notice", () => {

  it("the cap set the fee: the sentence names the cap, so it is not untrue", () => {
    const made = outcomeNotice({
      ...base,
      amountCents: 300_000,
      won: true,
      foxhoundSubmitted: true,
      feeCents: 50_000,
      invoiceDate: new Date("2026-12-01T04:00:00Z"),
    });
    expect(made).toMatchObject({
      notice: {
        body: [
          "$3,000.00 stays in your account. Reason: Product Not Received.",
          "Foxhound fee: $500.00 (20% of the saved amount, capped at $500). This will be invoiced on 2026-12-01.",
        ],
      },
    });
  });

  it("no fee to invoice (billing exempt, or the cap not yet priced): no fee sentence", () => {
    const made = outcomeNotice({
      ...base,
      won: true,
      foxhoundSubmitted: true,
      feeCents: null,
      invoiceDate: new Date("2026-12-01T04:00:00Z"),
    });
    expect(made).toEqual({
      subject: "Dispute won: $50.00 recovered",
      notice: {
        title: "You won the dispute.",
        body: ["$50.00 stays in your account. Reason: Product Not Received."],
        action: { label: "View dispute", url: LIST },
      },
    });
  });

  it("a reason is a plain value, never markup: Capsomer escapes it once", () => {
    const lost = outcomeNotice({
      ...base,
      reason: "a<b>&c",
      won: false,
      foxhoundSubmitted: false,
      feeCents: null,
      invoiceDate: null,
    });
    expect(lost).toMatchObject({
      notice: {
        body: [
          "$50.00 was deducted from your account by the cardholder bank. Reason: A<B>&C.",
          "No Foxhound fee. We only charge when we win.",
        ],
      },
    });
  });
});

// ============================================================================
// When they send: Recova's trigger, charge.dispute.closed won or lost
// ============================================================================

describe("E19 and E20 send on charge.dispute.closed, and not otherwise", () => {
  it("won, Foxhound submitted: one mail, the fee the resolution snapshotted, the next run's date", async () => {
    seedAccount();
    seedOpenDispute();
    expect(
      await processConnectedWebhook(env, closedEvent("won"), RECEIVED),
    ).toEqual({ status: "applied" });
    const m = only();
    expect(m.to).toBe("ops@acme.test");
    expect(m.subject).toBe("Dispute won: $50.00 recovered");
    const fee = sqlite
      .prepare("SELECT resolved_fee_cents AS fee FROM disputes WHERE id = 'd1'")
      .get() as { fee: number };
    expect(fee.fee).toBe(1000);
    expect(m.text).toContain(
      "Foxhound fee: $10.00 (20% of the saved amount). This will be invoiced on 2026-12-01.",
    );
    expect(m.text).toContain(`View dispute:\n${LIST}`);
    expect(m.text).toContain(
      `${footerNote("Acme Billing")}\nManage email settings: ${BASE}/settings`,
    );
    const sends = sqlite
      .prepare("SELECT status, template FROM email_sends")
      .all();
    expect(sends).toEqual([
      { status: "sent", template: DISPUTE_OUTCOME_TEMPLATE },
    ]);
  });

  it("won, not submitted by Foxhound: Recova's no-fee variant", async () => {
    seedAccount();
    seedOpenDispute({ submitted: false });
    await processConnectedWebhook(env, closedEvent("won"), RECEIVED);
    const m = only();
    expect(m.subject).toBe("Dispute won: $50.00 (no Foxhound fee)");
    expect(m.text).toContain(
      "Stripe Smart Disputes or your team submitted this response, not Foxhound. No Foxhound fee applies.",
    );
    expect(m.text).not.toContain("Foxhound fee:");
  });

  it("won on a paused account: the fee, with no date the billing run will not keep", async () => {
    seedAccount({ paused: true });
    seedOpenDispute();
    await processConnectedWebhook(env, closedEvent("won"), RECEIVED);
    expect(only().text).toContain(
      "Foxhound fee: $10.00 (20% of the saved amount). It will be invoiced at the first monthly billing run after processing resumes.",
    );
  });
});
