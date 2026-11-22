import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Customer mail carries the merchant's Reply-To when one is saved, and only then. Assertions read
// the message as it reaches env.EMAIL.send.

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

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
}));

const { buildEmailMessage, sendJobEmail } = await import("~/lib/email/send");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { queryStepForManualTrigger, toEmailContext } = await import("~/lib/cron/due-steps");
const { buildTemplateEmail } = await import("~/lib/recovery/email-template");
const { applySenderName } = await import("~/lib/settings/apply.server");
const { REPLY_TO_EMAIL_MAX_LENGTH } = await import("~/lib/settings/reply-to");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const FP = "fp_1";
const REPLY = "help@acme.test";

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
let db: ReturnType<typeof createInMemoryDb>["db"];

function seed(replyTo: string | null): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, reply_to_email, connected_at, created_at) VALUES ('c1', ?, 'acct_s_1', 1, 'cipher', 'Acme', ?, 1000, 1000)",
    )
    .run(ACCOUNT, replyTo);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at, stripe_connection_id) VALUES (?, ?, 'evt', 'in_1', 'cus_1', 'buyer@acme.test', 'Jane Buyer', 9900, 'usd', 'soft', 'active', 1000, 'c1')",
    )
    .run(FP, ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count) VALUES ('step_1', ?, ?, 'email_day1', 1, 1000, 0)",
    )
    .run(ACCOUNT, FP);
}

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
});

function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

const customerJob = (over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  to: "buyer@acme.test",
  fromName: "Acme",
  subject: "S",
  bodyHtml: "<p>Hello</p>",
  template: "t",
  unsubscribeToken: "unsub_tok",
  physicalAddress: ADDRESS,
  idempotencyKey: "k",
  ...over,
});

describe("buildEmailMessage Reply-To", () => {
  it("drops a stored value that is not a single address, so it can never reach the binding", () => {
    for (const bad of [
      "help@acme.test\r\nBcc: victim@example.com",
      "he\u0000lp@acme.test",
      "he\u007flp@acme.test",
      "he\u001blp@acme.test",
      "he\u0085lp@acme.test",
    ]) {
      const m = buildEmailMessage(customerJob({ replyTo: bad }) as never, BASE);
      expect(m.replyTo, JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("Reply-To is the merchant's address on a recovery send", () => {
  it("recovery: both step queries read reply_to_email from the payment's connection", async () => {
    seed(REPLY);
    const row = await queryStepForManualTrigger(db as never, ACCOUNT, "step_1");
    expect(row).not.toBeNull();
    const ctx = toEmailContext(row!);
    expect(ctx.replyTo).toBe(REPLY);

    const job = buildRecoveryEmailJob(
      ctx,
      buildTemplateEmail({
        merchantName: "Acme",
        declineCategory: "soft",
        amountFormatted: "$99.00",
        updateUrl: `${BASE}/e/c/click`,
      }),
      {
        unsubscribeToken: "unsub_tok",
        physicalAddress: ADDRESS,
        openUrl: `${BASE}/e/o/open`,
        honeypotUrl: `${BASE}/e/h/trap`,
      },
    );
    await sendJobEmail(env, job);
    expect(only().replyTo).toBe(REPLY);
  });
});

// The writer: Recova's "Reply-to email" field on /settings/email

function replyToRow(): string | null {
  return (
    sqlite.prepare("SELECT reply_to_email AS r FROM stripe_connections WHERE id = 'c1'").get() as {
      r: string | null;
    }
  ).r;
}

describe("the settings writer", () => {
  it("saves the reply-to address on the connection", async () => {
    seed(null);
    const res = await applySenderName(db as never, ACCOUNT, {
      connectionId: "c1",
      senderName: "Acme",
      replyToEmail: "  help@acme.test ",
    });
    expect(res.ok).toBe(true);
    expect(replyToRow()).toBe(REPLY);
  });

  it("refuses an address over the bound", async () => {
    seed(REPLY);
    const over = `${"a".repeat(REPLY_TO_EMAIL_MAX_LENGTH)}@acme.test`;
    const res = await applySenderName(db as never, ACCOUNT, {
      connectionId: "c1",
      senderName: "Acme",
      replyToEmail: over,
    });
    expect(res.ok).toBe(false);
    expect(replyToRow()).toBe(REPLY);
  });
});
