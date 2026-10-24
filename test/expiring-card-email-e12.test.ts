import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J90, row E12 (parity/ROWS-E.md): the expiring card alert a merchant's
// customer gets. Recova is the spec for what it says, carries and when it
// sends (RULES.md 1.1). The layout is Capsomer's email component (Q3), so
// nothing here asserts Recova's layout.
//
// Recova read whole, at HEAD, through Capsid repo "legacy":
//   app/api/cron/expiring-cards/route.ts (blob 717f6bbe): the cron, the send,
//     buildExpiringCardEmail
//   lib/email.ts (blob 3f882729): wrapEmailHtml, the footer
//   lib/email-utils.ts (blob 9f0e7a8c): checkAndRegisterUnsubscribe
//   lib/constants.ts (blob a21b32b8): EXPIRING_CARD_DAYS_AHEAD, SENDER_EMAIL
//   lib/resend-retry.ts (blob adcda147): sendEmailWithRetry
//
// Approved difference: the button links to Foxhound's own card-update page
// (APPROVED-DIFFERENCES, "yes", 2026-09-19), not a Stripe billing portal.

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
  sent: [] as SentMessage[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// recordOutcome goes through the money-write Durable Object, which has no
// binding in a unit test; run its batch on the harness database instead.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
    return { applied: true };
  },
}));

const { sendExpiringCardAlerts } = await import("~/lib/cron/expiring-cards");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_e12";
const NOW = new Date("2026-11-01T00:00:00Z");

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: BASE,
  PHYSICAL_ADDRESS: ADDRESS,
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: "msg_1" };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sent = [];
});

function seedMerchant(
  opts: { enabled?: number | null; senderName?: string | null; replyTo?: string | null } = {},
): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, expiring_card_notifications_enabled, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, 1)",
    )
    .run(ACCOUNT, opts.enabled === undefined ? null : opts.enabled);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, reply_to_email, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'cipher', ?, ?, 1000, 1000)",
    )
    .run(
      ACCOUNT,
      opts.senderName === undefined ? "Acme Billing" : opts.senderName,
      opts.replyTo === undefined ? null : opts.replyTo,
    );
}

function seedAlert(opts: { customerName?: string | null; email?: string } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO expiring_card_alerts (id, account_id, stripe_connection_id, stripe_customer_id, customer_email, customer_name, card_brand, card_last4, expires_month, expires_year, created_at) VALUES ('al_1', ?, 'c1', 'cus_1', ?, ?, 'visa', '4242', 11, 2026, 1000)",
    )
    .run(ACCOUNT, opts.email ?? "buyer@acme.test", opts.customerName === undefined ? "Jane Buyer" : opts.customerName);
}

function sendRows() {
  return sqlite.prepare("SELECT status FROM email_sends WHERE account_id = ?").all(ACCOUNT) as { status: string }[];
}


// ---- when it sends ----------------------------------------------------------------

describe("E12 sends on Recova's trigger, to Recova's recipient, and not otherwise", () => {

  it("a refused send returns its named outcome: a suppressed address is logged as suppressed, not sent", async () => {
    seedMerchant();
    seedAlert();
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, suppressed_at) VALUES ('s1', 'buyer@acme.test', 'tok', 2000)")
      .run();

    await sendExpiringCardAlerts(env, NOW);

    expect(harness.sent).toHaveLength(0);
    expect(sendRows()).toEqual([{ status: "suppressed" }]);
  });
});

