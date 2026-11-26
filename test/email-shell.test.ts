import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Every email is built on Capsomer's shared email component. Assertions read the message as it
// reaches env.EMAIL.send: an HTML part in the family frame, a plain-text part made from the same
// content, and the CAN-SPAM footer on customer mail only.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
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

const { sendJobEmail } = await import("~/lib/email/send");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { buildTemplateEmail } = await import("~/lib/recovery/email-template");
const { buildWinbackEmail, winbackSubject } = await import("~/lib/recovery/winback-email");
const { sendRecoveryNotification } = await import("~/lib/recovery/merchant-notification.server");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const FP = "fp_1";
// Capsomer's amber family, light theme, the body text color. Read from
// capsomer/email's generated colors.ts at v0.18.0; every mail has body text.
const BRAND_TEXT = "#211909";

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
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, 'evt', 'in_1', 'cus_1', 'buyer@acme.test', 'Jane Buyer', 9900, 'usd', 'soft', 'recovered', 1000)",
    )
    .run(FP, ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count) VALUES ('step_1', ?, ?, 'email_day1', 1, 1000, 0)",
    )
    .run(ACCOUNT, FP);
});

function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

/** The frame and both parts: what every send path owes. */
function expectBothParts(m: SentMessage, words: string[]): void {
  expect(typeof m.text).toBe("string");
  expect((m.text ?? "").trim().length).toBeGreaterThan(0);
  expect(m.html.startsWith("<!doctype html>")).toBe(true);
  expect(m.html).toContain(BRAND_TEXT);
  // The text part carries the wording, not markup.
  expect(m.text).not.toMatch(/<\/?(p|a|strong|br|table|tr|td|span|h\d)\b/i);
  for (const w of words) {
    expect(m.text).toContain(w);
    expect(m.html).toContain(w);
  }
}

function expectCustomerFooter(m: SentMessage): void {
  expect(m.html).toContain("Unsubscribe");
  expect(m.html).toContain(ADDRESS);
  expect(m.text).toContain("Unsubscribe");
  expect(m.text).toContain(ADDRESS);
  expect(m.text).toContain(`${BASE}/u/`);
  expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/foxhoundapp\.test\/u\//);
  expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
}

function expectNoCustomerFooter(m: SentMessage): void {
  for (const part of [m.html, m.text ?? ""]) {
    expect(part).not.toContain("Unsubscribe");
    expect(part).not.toContain(ADDRESS);
    expect(part).not.toContain("/u/");
  }
  expect(m.headers?.["List-Unsubscribe"]).toBeUndefined();
}

const customerJob = (bodyHtml: string, over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  to: "buyer@acme.test",
  fromName: "Acme",
  subject: "S",
  bodyHtml,
  template: "t",
  unsubscribeToken: "unsub_tok",
  physicalAddress: ADDRESS,
  idempotencyKey: "k",
  ...over,
});

describe("customer mail carries both parts and the CAN-SPAM footer", () => {
  const CLICK = `${BASE}/e/c/click_tok-123`;
  const OPEN = `${BASE}/e/o/open_tok`;
  const TRAP = `${BASE}/e/h/trap_tok`;

  it("dunning fallback through the recovery job", async () => {
    const category = "soft";
    const copy = buildTemplateEmail({
      merchantName: "Acme",
      declineCategory: category,
      amountFormatted: "$49.00",
      updateUrl: CLICK,
    });
    const job = buildRecoveryEmailJob(
      {
        stepId: "step_1",
        accountId: ACCOUNT,
        failedPaymentId: FP,
        stepType: "email_day1",
        attemptCount: 0,
        declineCategory: category,
        liveSendsEnabled: true,
        customerEmail: "buyer@acme.test",
        amountCents: 4900,
        currency: "usd",
        merchantName: "Acme",
        senderName: "Acme",
        voiceDescription: null,
        cached: { customBody: null, cachedSubject: null, cachedBodyHtml: null },
      },
      copy,
      {
        unsubscribeToken: "unsub_tok",
        physicalAddress: ADDRESS,
        openUrl: OPEN,
        honeypotUrl: TRAP,
      },
    );
    await sendJobEmail(env, job);
    const m = only();
    expectBothParts(m, ["$49.00", "Thanks,", "Acme"]);
    expectCustomerFooter(m);
    // The click-tracked card-update URL survives exactly, in both parts.
    expect(m.html).toContain(`href="${CLICK}"`);
    expect(m.text).toContain(CLICK);
    // The open pixel and the trap stay in the HTML, hidden, and never reach
    // the text part, where a reader would see them.
    expect(m.html).toContain(OPEN);
    expect(m.html).toContain(TRAP);
    expect(m.text).not.toContain(OPEN);
    expect(m.text).not.toContain(TRAP);
  });

  it("an AI-shaped body keeps its words and its link, and drops script", async () => {
    const body =
      `<p>Hi Jane,</p><p>Your payment of <strong>$12.00</strong> did not go through. ` +
      `You can <a href="${CLICK}">update your card here</a>.</p>` +
      `<script>alert(1)</script><ul><li>First point</li></ul><p>Thanks,<br />Acme</p>`;
    await sendJobEmail(env, customerJob(body));
    const m = only();
    expectBothParts(m, ["Hi Jane,", "$12.00", "update your card here", "First point", "Acme"]);
    expect(m.html).toContain(`href="${CLICK}"`);
    expect(m.html).not.toContain("<script");
    expect(m.text).not.toContain("alert(1)");
    expectCustomerFooter(m);
  });

  it("win-back mail written as blocks", async () => {
    const step = 1;
    const resubscribe = `${BASE}/p/resub_tok`;
    const blocks = buildWinbackEmail({
      stepNumber: step,
      customerName: "Jane",
      planName: "Pro",
      senderName: "Acme",
      resubscribeUrl: resubscribe,
    });
    await sendJobEmail(
      env,
      customerJob("", {
        bodyHtml: undefined,
        blocks,
        subject: winbackSubject({ stepNumber: step, planName: "Pro" }),
      }),
    );
    const m = only();
    expectBothParts(m, ["Hi Jane,", "Acme"]);
    expect(m.html).toContain(`href="${resubscribe}"`);
    expect(m.text).toContain(resubscribe);
    expectCustomerFooter(m);
  });

  it("a link the frame cannot carry is dropped to its words, and the send still goes", async () => {
    // A cached AI body is reused on every retry, so a throw here would fail the step every time.
    await sendJobEmail(env, customerJob(`<p><a href="javascript:alert(1)">Pay</a> today.</p>`));
    const m = only();
    expectBothParts(m, ["Pay today."]);
    for (const part of [m.html, m.text ?? ""]) {
      expect(part).not.toContain("javascript:");
      expect(part).not.toContain("alert(1)");
    }
    expectCustomerFooter(m);
  });
});

describe("merchant notices carry both parts and never the footer", () => {
  it("the recovery notification", async () => {
    const out = await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(out.kind).toBe("sent");
    const m = only();
    expectBothParts(m, ["Payment recovered.", "Jane Buyer just paid", "View payment"]);
    expect(m.html).toContain(`href="${BASE}/recovery/payments/${FP}"`);
    expectNoCustomerFooter(m);
  });
});
