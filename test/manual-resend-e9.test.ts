import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// E9 (job J87): the merchant's Resend sends the customer the last recovery
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
// claim is about what leaves (RULES.md 6.1).

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

const { dispatchManualAction, resendDepsFor, resendFooterNote } = await import(
  "~/lib/recovery/manual-actions.server"
);
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

describe("E9: when it sends and to whom (Recova's trigger)", () => {
  it("sends once, on the merchant's Resend, to the payment's customer", async () => {
    seed();
    expect(await resend()).toEqual({ ok: true, intent: "resend", subject: SUBJECT });
    expect(only().to).toBe(CUSTOMER);
  });

  it("sends nothing when the payment has no executed email with stored copy", async () => {
    seed();
    sqlite.prepare("UPDATE recovery_steps SET ai_body_html = NULL").run();
    expect(await resend()).toEqual({ ok: false, reason: "no_email_to_resend" });
    expect(harness.sent).toHaveLength(0);
  });

  it("a suppressed customer is a named refusal, and nothing leaves", async () => {
    seed();
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('sup_e9', ?, 'tok', 'unsubscribed', 1000)")
      .run(CUSTOMER);
    expect(await resend()).toEqual({ ok: false, reason: "customer_unsubscribed" });
    expect(harness.sent).toHaveLength(0);
  });

  it("records the resend as its own email_resend step, as Recova's route does", async () => {
    seed();
    await resend();
    const rows = sqlite
      .prepare("SELECT step_type, step_number, result, ai_subject, ai_body_html FROM recovery_steps WHERE step_type = 'email_resend'")
      .all();
    expect(rows).toEqual([
      { step_type: "email_resend", step_number: null, result: "email_sent", ai_subject: SUBJECT, ai_body_html: BODY },
    ]);
  });
});

describe("E9: what it says (the stored copy, resent as it was)", () => {
  it("the subject is the stored subject, unchanged", async () => {
    seed();
    await resend();
    expect(only().subject).toBe(SUBJECT);
  });

  it("every sentence and the button of the stored body are resent, with no regeneration", async () => {
    // The timing-word gate (J01) and the update-link check (J04) ran when this
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
  it("From is the merchant's sender name, as Recova's `sender_name || 'Support'`", async () => {
    seed({ senderName: "Acme" });
    await resend();
    expect(only().from).toMatch(/^Acme </);
  });

  it("From falls back to Support when the merchant set no sender name", async () => {
    seed({ senderName: null });
    await resend();
    expect(only().from).toMatch(/^Support </);
  });

  it("the footer carries Recova's line, the year and the sender name, in both parts", async () => {
    seed({ senderName: "Acme" });
    await resend();
    const m = only();
    expect(m.text).toContain("© 2026 Acme");
    expect(m.html).toMatch(/(&copy;|©|&#169;|&#xa9;) 2026 Acme/i);
  });

  it("the footer line names Support when no sender name is set", async () => {
    seed({ senderName: null });
    await resend();
    expect(only().text).toContain("© 2026 Support");
  });

  it("Recova's footer line, pure", () => {
    expect(resendFooterNote("Acme", 2026)).toBe("© 2026 Acme");
    expect(resendFooterNote("  Acme  ", 2026)).toBe("© 2026 Acme");
    expect(resendFooterNote(null, 2026)).toBe("© 2026 Support");
    expect(resendFooterNote("   ", 2026)).toBe("© 2026 Support");
  });

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

  it("keeps the approved customer footer: unsubscribe link, postal address, List-Unsubscribe", async () => {
    seed();
    await resend();
    const m = only();
    expect(m.text).toContain(ADDRESS);
    expect(m.html).toContain(`${BASE}/u/`);
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/foxhound\.example\.com\/u\//);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("carries an HTML part and a plain-text part (J02)", async () => {
    seed();
    await resend();
    const m = only();
    expect(m.html).toMatch(/^<!doctype html>/i);
    expect(m.text?.length ?? 0).toBeGreaterThan(0);
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

  it("a step id from another account never reads that account's sender", async () => {
    seed({ senderName: "Acme", replyTo: "help@example.com" });
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES ('acct_other', 'Other', 1000, 1)")
      .run();
    await resendDepsFor(env).send({
      accountId: "acct_other",
      recoveryStepId: "step_d3",
      to: CUSTOMER,
      subject: SUBJECT,
      bodyHtml: BODY,
      now: NOW,
    });
    // A loop over no sends proves nothing (RULES.md 6.2).
    expect(harness.sent).toHaveLength(1);
    for (const m of harness.sent) {
      expect(m.from).toMatch(/^Support </);
      expect(m.replyTo).toBeUndefined();
    }
  });
});
