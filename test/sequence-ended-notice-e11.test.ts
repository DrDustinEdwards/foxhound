import type Database from "better-sqlite3";
import { escapeHtml } from "capsomer/email";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E11 (job J89, job_1e3cc5f3efa7): the Recovery sequence ended notice to the
// merchant, on Capsomer's `notice` template with Recova's words, recipient and
// footer, the same way E10 (PR 152) moved the Payment recovered notice.
//
// Recova is the spec, read whole at the blobs parity/ROWS-E.md names:
//   app/api/cron/process-recovery/route.ts  blob 7015998c, 19,935 bytes (lines 381 to 412)
//   lib/email.ts                            blob 3f882729,  2,035 bytes (wrapEmailHtml)
//   lib/constants.ts                        blob a21b32b8, 14,977 bytes (FROM_HELLO, APP_URL)
//   lib/resend-retry.ts                     blob adcda147,  4,766 bytes (sendEmailWithRetry)
//
// Every assertion on the mail reads the message as it reaches env.EMAIL.send,
// or the email_sends row: the claim is about what leaves.

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

const { sendSequenceCompleteNotification, sequenceCompleteBody, SEQUENCE_COMPLETE_TEMPLATE } =
  await import("~/lib/recovery/sequence-complete-notification.server");
const { findAdminEmailType, prepareAdminEmail, previewAdminEmail } =
  await import("~/lib/admin/email-send.server");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const FP = "fp_1";
const YEAR = new Date().getUTCFullYear();
// Recova's footer sentence, wrapEmailHtml(notifyBody, 'Recova', undefined), with
// Foxhound's name: "You're receiving this from ${senderName} about a recent
// payment. &copy; ${year}".
const FOOTER_NOTE = `You're receiving this from Foxhound about a recent payment. © ${YEAR}`;
// Recova's sentence (route.ts line 398), less the false "7-day".
const SENTENCE =
  "The recovery sequence for Jane Buyer ($99.00) has ended without a successful payment. " +
  "You may want to manually reach out or write off this balance.";

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
});

function seed(opts: { customerName?: string | null; enabled?: number | null } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, sequence_complete_notifications_enabled, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', ?, 1)",
    )
    .run(ACCOUNT, opts.enabled === undefined ? null : opts.enabled);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, 'evt', 'in_1', 'cus_1', 'buyer@acme.test', ?, 9900, 'usd', 'soft', 'failed_unrecovered', 1000)",
    )
    .run(FP, ACCOUNT, opts.customerName === undefined ? "Jane Buyer" : opts.customerName);
}

async function sendOne(): Promise<SentMessage> {
  const out = await sendSequenceCompleteNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
  expect(out.kind).toBe("sent");
  expect(out.kind === "sent" && out.result.status).toBe("sent");
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

// ============================================================================
// What it says: Recova's words on Capsomer's notice template
// ============================================================================

describe("E11 says Recova's words, as a title, one sentence and a View payment button", () => {
  it("sequenceCompleteBody is the notice template's content: title, sentence, button", () => {
    // DO step 4. Recova's notifyBody (route.ts line 397 to 399) is three
    // paragraphs: the bold title, the sentence, the button. On Capsomer's
    // notice they are its title, its one body paragraph and its action.
    const notice = sequenceCompleteBody({
      amountCents: 9900,
      currency: "usd",
      customerLabel: "Jane Buyer",
      paymentUrl: `${BASE}/recovery/payments/${FP}`,
    });
    expect(notice).toEqual({
      title: "Recovery sequence complete.",
      body: [SENTENCE],
      action: { label: "View payment", url: `${BASE}/recovery/payments/${FP}` },
    });
  });

  it("the sent mail carries exactly the title as its one heading, the sentence, and the button", async () => {
    seed();
    const m = await sendOne();
    expect(m.html.match(/<h1\b/g)).toHaveLength(1);
    expect(m.html).toMatch(/<h1[^>]*>Recovery sequence complete\.<\/h1>/);
    expect(m.html).toContain(`>${SENTENCE}</td>`);
    expect(m.html).toMatch(
      new RegExp(`<a class="e-btn" href="${BASE}/recovery/payments/${FP}"[^>]*>View payment</a>`),
    );
    // The plain-text part, from the same blocks.
    expect(m.text).toContain("Recovery sequence complete.\n\n");
    expect(m.text).toContain(SENTENCE);
    expect(m.text).toContain(`View payment:\n${BASE}/recovery/payments/${FP}`);
  });

  it("the subject is Recova's, not the title", async () => {
    seed();
    const m = await sendOne();
    expect(m.subject).toBe("Recovery sequence ended: $99.00 from Jane Buyer was not recovered");
    expect(m.html).toContain("<title>Recovery sequence ended: $99.00 from Jane Buyer was not recovered</title>");
  });

  it("never says 7-day, the one word of Recova's not kept (truthfulness, ENGINE-SEQUENCE-COMPLETE reversal 6)", async () => {
    seed();
    const m = await sendOne();
    for (const part of [m.html, m.text ?? "", m.subject]) {
      expect(part).not.toMatch(/7.day/);
    }
  });

  it("a customer name is shown as written, never read as markup", async () => {
    seed({ customerName: "Tom & Jerry <Co>" });
    const m = await sendOne();
    expect(m.subject).toBe("Recovery sequence ended: $99.00 from Tom & Jerry <Co> was not recovered");
    expect(m.html).toContain(`>The recovery sequence for ${escapeHtml("Tom & Jerry <Co>")} ($99.00) has ended`);
    expect(m.html).not.toContain("<Co>");
    expect(m.text).toContain("The recovery sequence for Tom & Jerry <Co> ($99.00) has ended");
  });
});

// ============================================================================
// What it carries: From, no Reply-To, both parts, Recova's footer and settings link
// ============================================================================

describe("E11 carries Recova's footer line and Manage email settings link, and no unsubscribe", () => {
  it("the footer slot holds Recova's sentence, then Manage email settings to /settings", async () => {
    seed();
    const m = await sendOne();
    expect(m.html).toContain(escapeHtml(FOOTER_NOTE));
    expect(m.html).toMatch(new RegExp(`<a class="e-link" href="${BASE}/settings"[^>]*>Manage email settings</a>`));
    expect(m.html.indexOf(escapeHtml(FOOTER_NOTE))).toBeLessThan(m.html.indexOf("Manage email settings"));
    expect(m.text).toContain(`${FOOTER_NOTE}\nManage email settings: ${BASE}/settings`);
  });

  it("no unsubscribe, no postal address, no List-Unsubscribe (RULES.md 3.16)", async () => {
    seed();
    const m = await sendOne();
    for (const part of [m.html, m.text ?? ""]) {
      expect(part).not.toContain("Unsubscribe");
      expect(part).not.toContain(ADDRESS);
      expect(part).not.toContain("/u/");
    }
    expect(m.headers).toBeUndefined();
  });

  it("From Foxhound at Foxhound's one merchant address, no Reply-To, to the notification email", async () => {
    // Recova sends from FROM_HELLO, "Recova <hello@recovamrr.com>". Foxhound has
    // one merchant-facing address; the hello@ question is the seat's (DO step 5).
    seed();
    const m = await sendOne();
    expect(m.from).toBe("Foxhound <recovery@send.foxhoundapp.com>");
    expect(m.replyTo).toBeUndefined();
    expect(m.to).toBe("ops@acme.test");
    const rows = sqlite.prepare("SELECT status, template FROM email_sends WHERE account_id = ?").all(ACCOUNT);
    expect(rows).toEqual([{ status: "sent", template: SEQUENCE_COMPLETE_TEMPLATE }]);
  });

  it("is accessible as rendered: a language, a title, one heading, a real link button, 16px body", async () => {
    seed();
    const m = await sendOne();
    expect(m.html).toMatch(/<html lang="en">/);
    expect(m.html).toMatch(/<title>[^<]+<\/title>/);
    expect(m.html.match(/<h1\b/g)).toHaveLength(1);
    expect(m.html).toMatch(/<a [^>]*href="https:[^"]+"[^>]*>View payment<\/a>/);
    expect(m.html).toContain("font-size:16px");
  });
});

// ============================================================================
// When it sends: named refusals (the trigger and claim are proven in
// test/sequence-complete-notification.test.ts and are unchanged here)
// ============================================================================

describe("E11 names every refusal", () => {
  it("the toggle off is a named refusal, and NULL is on", async () => {
    seed({ enabled: 0 });
    expect(await sendSequenceCompleteNotification(env, { accountId: ACCOUNT, failedPaymentId: FP })).toEqual({
      kind: "skipped",
      reason: "disabled",
    });
    expect(harness.sent).toHaveLength(0);
  });

  it("a second call for the same sequence sends nothing more", async () => {
    seed();
    await sendOne();
    const again = await sendSequenceCompleteNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(again.kind === "sent" && again.result.status).toBe("duplicate");
    expect(harness.sent).toHaveLength(1);
  });

  it("a provider refusal comes back named, never thrown", async () => {
    seed();
    const failing = {
      ...env,
      EMAIL: {
        send: async () => {
          throw new Error("provider exploded");
        },
      },
    } as unknown as Env;
    const out = await sendSequenceCompleteNotification(failing, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(out.kind === "sent" && out.result.status).toBe("failed");
  });
});

// ============================================================================
// The admin preview is the same function's output
// ============================================================================

describe("the admin preview of E11 is the mail the notifier sends", () => {
  it("carries the notice template's heading, button and Recova's footer", async () => {
    const type = findAdminEmailType("sequence_complete");
    expect(type).not.toBeNull();
    const prepared = await prepareAdminEmail(env, {
      type: type!,
      to: "admin@foxhoundapp.test",
      merchant: null,
      now: new Date(),
    });
    const preview = previewAdminEmail(env, type!, prepared);
    expect(preview.from).toBe("Foxhound <recovery@send.foxhoundapp.com>");
    expect(preview.html).toMatch(/<h1[^>]*>Recovery sequence complete\.<\/h1>/);
    expect(preview.html).toMatch(/>View payment<\/a>/);
    expect(preview.text).toContain(`${FOOTER_NOTE}\nManage email settings: ${BASE}/settings`);
  });
});
