import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// E9: the merchant's Resend sends the customer the last recovery
// email again, as Recova's resend route does.
//
// Recova is the spec: app/api/payments/[id]/resend/route.ts (blob 35132cb6),
// read whole. It resends the newest executed email step's stored ai_subject and
// ai_body_html to failed_payments.customer_email with
//
//   from:    `${senderName} <${SENDER_EMAIL}>`, senderName = sender_name || 'Support'
//   replyTo: reply_to_email || undefined
//   footer:  `&copy; ${year} ${senderName}`
//
// and records a new email_resend step. Foxhound keeps its approved suppression
// check (APPROVED-DIFFERENCES, 2026-08-11), so the resend also carries the
// customer footer (unsubscribe link, postal address, List-Unsubscribe).
//
// Every assertion reads the message as it reaches env.EMAIL.send, because the
// claim is about what leaves.

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

const { dispatchManualAction } = await import("~/lib/recovery/manual-actions.server");
const { resendDepsFor } = await import("~/lib/recovery/manual-action-deps.server");
type ManualActionCommit = import("~/lib/recovery/manual-actions.server").ManualActionCommit;

const BASE = "https://foxhound.example.com";
const ADDRESS = "1 Example Street, Example City, EX 00000";
const ACCOUNT = "acct_e9";
const FP = "fp_e9";
const CUSTOMER = "buyer@example.com";
const SUBJECT = "Quick note about your Acme payment";
const BODY =
  '<p>Hi Jane,</p><p>Your last payment of $99.00 did not go through.</p>' +
  '<p><a href="https://foxhound.example.com/e/c/stored-click-token">Update payment method</a></p>' +
  "<p>Thanks,<br>Acme</p>";

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: BASE,
  PHYSICAL_ADDRESS: ADDRESS,
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: "msg_e9" };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

function seed(opts: { senderName?: string | null; replyTo?: string | null; status?: string } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@example.com', 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, reply_to_email, connected_at, created_at) VALUES ('c_e9', ?, 'acct_s_e9', 1, 'cipher', ?, ?, 1000, 1000)",
    )
    .run(ACCOUNT, opts.senderName === undefined ? "Acme" : opts.senderName, opts.replyTo ?? null);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at, stripe_connection_id) VALUES (?, ?, 'evt_e9', 'in_e9', 'cus_e9', ?, 'Jane Buyer', 9900, 'usd', 'soft', ?, 1000, 'c_e9')",
    )
    .run(FP, ACCOUNT, CUSTOMER, opts.status ?? "active");
  // Two executed email steps: the newer one (day 3) is the one to resend.
  const step = sqlite.prepare(
    "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, executed_at, result, ai_subject, ai_body_html, attempt_count) VALUES (?, ?, ?, ?, ?, 1000, ?, 'email_sent', ?, ?, 1)",
  );
  step.run("step_d1", ACCOUNT, FP, "email_day1", 1, 2000, "Older subject", "<p>Older body.</p>");
  step.run("step_d3", ACCOUNT, FP, "email_day3", 2, 3000, SUBJECT, BODY);
}

const commit: ManualActionCommit = async (_accountId, _key, build) => {
  const batch = build(db);
  sqlite.transaction(() => {
    for (const statement of batch) runStatement(sqlite, statement);
  })();
  return { applied: true };
};

const unusedTrigger = {
  loadStep: async () => {
    throw new Error("trigger called");
  },
  runRetry: async () => {
    throw new Error("trigger called");
  },
  runEmail: async () => {
    throw new Error("trigger called");
  },
};

const NOW = new Date("2026-10-16T12:00:00.000Z");

function resend() {
  return dispatchManualAction({
    db,
    accountId: ACCOUNT,
    failedPaymentId: FP,
    intent: "resend",
    commit,
    trigger: unusedTrigger,
    resend: resendDepsFor(env),
    now: NOW,
  });
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

describe("E9: what it says (the stored copy, resent as it was)", () => {

  it("every sentence and the button of the stored body are resent, with no regeneration", async () => {
    // The timing-word gate and the update-link check ran when this
    // copy was generated and first sent. Recova resends the stored copy as it
    // is, and so does Foxhound: nothing here regenerates it.
    seed();
    await resend();
    const m = only();
    for (const sentence of ["Hi Jane,", "Your last payment of $99.00 did not go through.", "Thanks,", "Acme"]) {
      expect(m.text).toContain(sentence);
      expect(m.html).toContain(sentence);
    }
    expect(m.html).toContain('href="https://foxhound.example.com/e/c/stored-click-token"');
    expect(m.html).toContain("Update payment method");
  });
});

describe("E9: what it carries", () => {

  it("Reply-To is the merchant's reply-to address (J03), none when unset", async () => {
    seed({ replyTo: "help@example.com" });
    await resend();
    expect(only().replyTo).toBe("help@example.com");

    ({ sqlite, db } = createInMemoryDb());
    harness.db = db;
    harness.sent = [];
    seed({ replyTo: null });
    await resend();
    expect(only().replyTo).toBeUndefined();
  });

  it("reads the payment's own connection, not another connection on the same account", async () => {
    seed({ senderName: "Acme" });
    sqlite.prepare("UPDATE stripe_connections SET is_primary = 0 WHERE id = 'c_e9'").run();
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, reply_to_email, connected_at, created_at) VALUES ('c_e9_primary', ?, 'acct_s_e9b', 1, 'cipher', 'Primary Co', 'primary@example.com', 1000, 1000)",
      )
      .run(ACCOUNT);
    await resend();
    expect(only().from).toMatch(/^Acme </);
    expect(only().replyTo).toBeUndefined();
  });
});
