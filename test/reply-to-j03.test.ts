
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J03: a customer who replies to a merchant's email reaches the merchant.
//
// Recova is the spec (lib/recovery-execution.ts, blob 3a8f8768): it reads the
// primary connection's `reply_to_email` and sends with
// `replyTo: merchant.reply_to_email || fromAddress`, so every recovery email
// carries a Reply-To, the merchant's address when set and the From otherwise.
// Foxhound sets it only when the merchant saved an address: a Reply-To equal to
// the From delivers a reply to the same place as none, and leaving it off keeps
// a "Name <addr>" string the binding has not been proven to accept off every
// customer email (review of PR #69, finding 4).
// Its win-back and expiring-card crons and its settings test email do the same
// (parity/ROWS-E.md). Its writer is the Email settings page's "Reply-to email"
// field (settings/update/route.ts:108, `|| null` on an empty box).
//
// RULES.md 3.18: the writer lands with the reader. Every assertion on a send
// reads the message as it reaches env.EMAIL.send, because the claim is about
// what leaves. Sign-in mail and merchant notices carry no Reply-To.

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

const { buildEmailMessage, sendEmail } = await import("~/lib/email/send");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { queryStepForManualTrigger, toEmailContext } = await import("~/lib/cron/due-steps");
const { buildTemplateEmail } = await import("~/lib/recovery/email-template");
const { runWinbackSends } = await import("~/lib/cron/winback");
const { sendExpiringCardAlerts } = await import("~/lib/cron/expiring-cards");
const { resendDepsFor } = await import("~/lib/recovery/manual-action-deps.server");
const { sendTestEmail } = await import("~/lib/settings/test-email.server");
const { sendAuthEmail, sendPasswordResetEmail } = await import("~/lib/auth/send-auth-email");
const { sendRecoveryNotification } = await import("~/lib/recovery/merchant-notification.server");
const { applySenderName } = await import("~/lib/settings/apply.server");
const { REPLY_TO_EMAIL_MAX_LENGTH, isValidReplyToEmail } = await import("~/lib/settings/reply-to");

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

// ============================================================================
// The send module: Recova's `replyTo ?? fromAddress`, customer mail only
// ============================================================================

describe("buildEmailMessage sets Reply-To on customer mail", () => {
  it("uses the merchant's reply-to address when the job carries one", () => {
    const m = buildEmailMessage(customerJob({ replyTo: REPLY }) as never, BASE);
    expect(m.replyTo).toBe(REPLY);
  });

  it("sets none when no address is saved, so replies go to the From as before", () => {
    for (const replyTo of [null, undefined, "", "   "]) {
      const m = buildEmailMessage(customerJob({ replyTo }) as never, BASE);
      expect(m.replyTo, String(replyTo)).toBeUndefined();
      expect("replyTo" in m, String(replyTo)).toBe(false);
    }
  });

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

  it("sets none on merchant mail", () => {
    const m = buildEmailMessage(
      { ...customerJob({ replyTo: REPLY }), audience: "merchant" } as never,
      BASE,
    );
    expect(m.replyTo).toBeUndefined();
  });
});

// ============================================================================
// Every merchant-customer send path reads the connection's reply_to_email
// ============================================================================

describe("Reply-To is the merchant's address on every merchant-customer send", () => {
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
    await sendEmail(env, job);
    expect(only().replyTo).toBe(REPLY);
  });

  it("recovery: the due-step query reads it too", async () => {
    seed(REPLY);
    const { queryDueRecoverySteps } = await import("~/lib/cron/due-steps");
    const rows = await queryDueRecoverySteps(env, new Date(5000));
    expect(rows.map((r) => r.stepId)).toContain("step_1");
    expect(toEmailContext(rows.find((r) => r.stepId === "step_1")!).replyTo).toBe(REPLY);
  });

  it("recovery: with none set, there is no Reply-To", async () => {
    seed(null);
    const row = await queryStepForManualTrigger(db as never, ACCOUNT, "step_1");
    const job = buildRecoveryEmailJob(
      toEmailContext(row!),
      { subject: "S", bodyHtml: "<p>x</p>" } as never,
      { unsubscribeToken: "u", physicalAddress: ADDRESS, openUrl: `${BASE}/e/o/o`, honeypotUrl: `${BASE}/e/h/h` },
    );
    await sendEmail(env, job);
    expect(only().replyTo).toBeUndefined();
  });

  it("win-back", async () => {
    seed(REPLY);
    sqlite
      .prepare(
        "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, customer_name, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES ('wb_1', ?, 'cus_wb', 'sub_1', 'buyer@acme.test', 'Jane', 'Pro', 4900, 'usd', 'active', 1000, 'c1')",
      )
      .run(ACCOUNT);
    sqlite
      .prepare(
        "INSERT INTO win_back_steps (id, win_back_sequence_id, account_id, step_number, scheduled_at, attempt_count) VALUES ('st_1', 'wb_1', ?, 1, 1000, 0)",
      )
      .run(ACCOUNT);
    const result = await runWinbackSends(env, new Date(5000));
    expect(result.sent).toBe(1);
    expect(only().replyTo).toBe(REPLY);
  });

  it("expiring card", async () => {
    seed(REPLY);
    sqlite
      .prepare(
        "INSERT INTO expiring_card_alerts (id, account_id, stripe_connection_id, stripe_customer_id, customer_email, customer_name, card_brand, card_last4, expires_month, expires_year, created_at) VALUES ('al_1', ?, 'c1', 'cus_1', 'buyer@acme.test', 'Jane Buyer', 'visa', '4242', 11, 2026, 1000)",
      )
      .run(ACCOUNT);
    const result = await sendExpiringCardAlerts(env, new Date(5000));
    expect(result.sent).toBe(1);
    expect(only().replyTo).toBe(REPLY);
  });

  it("the manual resend", async () => {
    seed(REPLY);
    const result = await resendDepsFor(env).send({
      accountId: ACCOUNT,
      recoveryStepId: "step_1",
      to: "buyer@acme.test",
      subject: "Your payment",
      bodyHtml: "<p>Your payment did not go through.</p>",
      now: new Date(2000),
    });
    expect(result.status).toBe("sent");
    expect(only().replyTo).toBe(REPLY);
  });

  it("the settings test email, as Recova's test-email route does", async () => {
    seed(REPLY);
    const { result } = await sendTestEmail(env, ACCOUNT, "owner@acme.test");
    expect(result.status).toBe("sent");
    expect(only().replyTo).toBe(REPLY);
  });
});

describe("no Reply-To on sign-in mail or merchant notices", () => {
  it("sign-in verification", async () => {
    seed(REPLY);
    await sendAuthEmail(env, "email-verification", "owner@acme.test", `${BASE}/verify?token=EXAMPLE`);
    expect(only().replyTo).toBeUndefined();
  });

  it("password reset", async () => {
    seed(REPLY);
    await sendPasswordResetEmail(env, { to: "owner@acme.test", url: `${BASE}/reset?token=EXAMPLE`, token: "EXAMPLE" });
    expect(only().replyTo).toBeUndefined();
  });

  it("the merchant's own recovered-payment notice", async () => {
    seed(REPLY);
    sqlite.prepare("UPDATE failed_payments SET status = 'recovered' WHERE id = ?").run(FP);
    const out = await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(out.kind).toBe("sent");
    const m = only();
    expect(m.to).toBe("ops@acme.test");
    expect(m.replyTo).toBeUndefined();
  });
});

// ============================================================================
// The writer: Recova's "Reply-to email" field on /settings/email
// ============================================================================

function replyToRow(): string | null {
  return (sqlite.prepare("SELECT reply_to_email AS r FROM stripe_connections WHERE id = 'c1'").get() as {
    r: string | null;
  }).r;
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

  it("an empty box saves null, as Recova's `|| null` does", async () => {
    seed(REPLY);
    const res = await applySenderName(db as never, ACCOUNT, { connectionId: "c1", senderName: "Acme", replyToEmail: "  " });
    expect(res.ok).toBe(true);
    expect(replyToRow()).toBeNull();
  });

  it("a caller that does not send the field leaves it alone", async () => {
    seed(REPLY);
    const res = await applySenderName(db as never, ACCOUNT, { connectionId: "c1", senderName: "New name" });
    expect(res.ok).toBe(true);
    expect(replyToRow()).toBe(REPLY);
  });

  it("refuses something that is not an email address, and writes nothing", async () => {
    seed(REPLY);
    for (const bad of [
      "not an email",
      "help@",
      "@acme.test",
      "help@acme",
      "a@b.test\r\nBcc: x@y.test",
      "a@b@c.test",
      // Control characters, which the validator's comment promises to refuse
      // (review of PR #69, finding 2): NUL, DEL, ESC and NEL, in each part.
      "a\u0000b@acme.test",
      "help@ac\u007fme.test",
      "help@acme.te\u001bst",
      "he\u0085lp@acme.test",
    ]) {
      const res = await applySenderName(db as never, ACCOUNT, { connectionId: "c1", senderName: "Acme", replyToEmail: bad });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (!res.ok) expect(res.error, JSON.stringify(bad)).toBe("Enter a valid reply-to email address.");
    }
    expect(replyToRow()).toBe(REPLY);
  });

  it("refuses an address over the bound", async () => {
    seed(REPLY);
    const over = `${"a".repeat(REPLY_TO_EMAIL_MAX_LENGTH)}@acme.test`;
    const res = await applySenderName(db as never, ACCOUNT, { connectionId: "c1", senderName: "Acme", replyToEmail: over });
    expect(res.ok).toBe(false);
    expect(replyToRow()).toBe(REPLY);
    expect(isValidReplyToEmail(REPLY)).toBe(true);
  });
});
