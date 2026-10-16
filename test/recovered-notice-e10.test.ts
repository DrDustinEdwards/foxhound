import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { escapeHtml } from "capsomer/email";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E10 (job J88, job_de1ad9014914): the Payment recovered notice to the merchant,
// on Capsomer's `notice` template with Recova's words, recipient and footer.
//
// Recova is the spec, read whole at the blobs parity/ROWS-E.md names:
//   app/api/webhooks/stripe/route.ts  blob deb585e4, 47,093 bytes (lines 725 to 777)
//   lib/email.ts                      blob 3f882729,  2,035 bytes (wrapEmailHtml)
//   lib/constants.ts                  blob a21b32b8, 14,977 bytes (FROM_RECOVERY, APP_URL)
//   lib/resend-retry.ts               blob adcda147,  4,766 bytes (sendEmailWithRetry)
//
// Every assertion reads the message as it reaches env.EMAIL.send, or the
// email_sends row, never a helper's return value: the claim is about what leaves.

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

const notifier = await import("~/lib/recovery/merchant-notification.server");
const {
  sendRecoveryNotification,
  recoveryNotifyBody,
  RECOVERY_NOTIFY_TEMPLATE,
} = notifier;
const { buildEmailMessage } = await import("~/lib/email/send");
const { findAdminEmailType, prepareAdminEmail, previewAdminEmail } =
  await import("~/lib/admin/email-send.server");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const FP = "fp_1";
const YEAR = new Date().getUTCFullYear();
// Recova's footer sentence, wrapEmailHtml(body, 'Recova'), with Foxhound's name:
// "You're receiving this from ${senderName} about a recent payment. &copy; ${year}".
const FOOTER_NOTE = `You're receiving this from Foxhound about a recent payment. © ${YEAR}`;

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

function seed(
  opts: {
    customerName?: string | null;
    declineCategory?: string;
    enabled?: number | null;
  } = {},
): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, recovery_notifications_enabled, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', ?, 1)",
    )
    .run(ACCOUNT, opts.enabled === undefined ? null : opts.enabled);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, 'evt', 'in_1', 'cus_1', 'buyer@acme.test', ?, 9900, 'usd', ?, 'recovered', 1000)",
    )
    .run(
      FP,
      ACCOUNT,
      opts.customerName === undefined ? "Jane Buyer" : opts.customerName,
      opts.declineCategory ?? "soft",
    );
}

async function sendOne(): Promise<SentMessage> {
  const out = await sendRecoveryNotification(env, {
    accountId: ACCOUNT,
    failedPaymentId: FP,
  });
  expect(out.kind).toBe("sent");
  expect(out.kind === "sent" && out.result.status).toBe("sent");
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

function sendRows() {
  return sqlite
    .prepare("SELECT status, template FROM email_sends WHERE account_id = ?")
    .all(ACCOUNT) as {
    status: string;
    template: string;
  }[];
}

// ============================================================================
// What it says: Recova's words on Capsomer's notice template
// ============================================================================

describe("E10 says Recova's words, as a title, one sentence and a View payment button", () => {
  it("recoveryNotifyBody is the notice template's content: title, sentence, button", () => {
    // DO step 4. Recova's body (route.ts:759-761) is three paragraphs: the bold
    // title, the sentence, the button. On Capsomer's notice they are its title,
    // its one body paragraph and its action.
    const notice = recoveryNotifyBody({
      amountCents: 9900,
      currency: "usd",
      customerLabel: "Jane Buyer",
      declineCategory: "soft",
      paymentUrl: `${BASE}/recovery/payments/${FP}`,
    });
    expect(notice).toEqual({
      title: "Payment recovered.",
      body: [
        "Jane Buyer just paid $99.00. Foxhound recovered it automatically after a soft decline.",
      ],
      action: { label: "View payment", url: `${BASE}/recovery/payments/${FP}` },
    });
  });

  it("the sent mail carries exactly the title as its one heading, the sentence, and the button", async () => {
    seed();
    const m = await sendOne();
    expect(m.html.match(/<h1\b/g)).toHaveLength(1);
    expect(m.html).toMatch(/<h1[^>]*>Payment recovered\.<\/h1>/);
    expect(m.html).toContain(
      ">Jane Buyer just paid $99.00. Foxhound recovered it automatically after a soft decline.</td>",
    );
    expect(m.html).toMatch(
      new RegExp(
        `<a class="e-btn" href="${BASE}/recovery/payments/${FP}"[^>]*>View payment</a>`,
      ),
    );
    // The text part, from the same blocks: title, sentence, button label with
    // its address on a line of its own.
    expect(m.text).toContain("Payment recovered.\n\n");
    expect(m.text).toContain(
      "Jane Buyer just paid $99.00. Foxhound recovered it automatically after a soft decline.",
    );
    expect(m.text).toContain(`View payment:\n${BASE}/recovery/payments/${FP}`);
  });

  it("the subject is Recova's, not the title", async () => {
    seed();
    const m = await sendOne();
    expect(m.subject).toBe("Payment recovered: $99.00 from Jane Buyer");
    expect(m.html).toContain(
      "<title>Payment recovered: $99.00 from Jane Buyer</title>",
    );
  });

  it("a customer name is shown as written, never read as markup", async () => {
    // The name comes from Stripe. Interpolated into HTML and read back, "<Co>"
    // was a tag and vanished; on the notice template it is a value Capsomer
    // escapes, so the merchant reads exactly what Stripe holds.
    seed({ customerName: "Tom & Jerry <Co>" });
    const m = await sendOne();
    expect(m.subject).toBe("Payment recovered: $99.00 from Tom & Jerry <Co>");
    expect(m.html).toContain(
      `>${escapeHtml("Tom & Jerry <Co>")} just paid $99.00.`,
    );
    expect(m.html).not.toContain("<Co>");
    expect(m.text).toContain("Tom & Jerry <Co> just paid $99.00.");
  });
});

// ============================================================================
// What it carries: From, no Reply-To, both parts, Recova's footer and settings link
// ============================================================================

describe("E10 carries Recova's footer line and Manage email settings link, and no unsubscribe", () => {
  it("the footer slot holds Recova's sentence, then Manage email settings to /settings", async () => {
    seed();
    const m = await sendOne();
    // HTML: Capsomer escapes the apostrophe; the words are Recova's.
    expect(m.html).toContain(escapeHtml(FOOTER_NOTE));
    expect(m.html).toMatch(
      new RegExp(
        `<a class="e-link" href="${BASE}/settings"[^>]*>Manage email settings</a>`,
      ),
    );
    expect(m.html.indexOf(escapeHtml(FOOTER_NOTE))).toBeLessThan(
      m.html.indexOf("Manage email settings"),
    );
    expect(m.text).toContain(
      `${FOOTER_NOTE}\nManage email settings: ${BASE}/settings`,
    );
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

  it("From Foxhound at the recovery address, no Reply-To, to the notification email", async () => {
    seed();
    const m = await sendOne();
    expect(m.from).toBe("Foxhound <recovery@send.foxhoundapp.com>");
    expect(m.replyTo).toBeUndefined();
    expect(m.to).toBe("ops@acme.test");
    expect(sendRows()).toEqual([
      { status: "sent", template: RECOVERY_NOTIFY_TEMPLATE },
    ]);
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

  it("a merchant mail with no footer note still has no footer line of its own (the digest, the dispute outcome notices)", () => {
    // The settings link belongs to the mails that carried Recova's footer
    // sentence; the others are unchanged by this job.
    const m = buildEmailMessage(
      {
        accountId: ACCOUNT,
        to: "ops@acme.test",
        fromName: "Foxhound",
        subject: "S",
        bodyHtml: "<p>Body.</p>",
        template: "t",
        unsubscribeToken: "",
        physicalAddress: "",
        idempotencyKey: "k",
        audience: "merchant",
      },
      BASE,
    );
    expect(m.html).not.toContain("Manage email settings");
    expect(m.text).not.toContain("Manage email settings");
  });
});

// ============================================================================
// When it sends: Recova's trigger, toggle and recipient, and named refusals
// ============================================================================

describe("E10 sends on Recova's trigger, once, and names every refusal", () => {
  it("only after the recovery money write applied, the transition claim in Foxhound's terms", () => {
    const code = readFileSync(
      fileURLToPath(new URL("../app/lib/webhooks/process.ts", import.meta.url)),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain(
      "if (applied) {\n        await sendRecoveryNotification(env, { accountId, failedPaymentId });",
    );
  });

  it("a second call for the same recovery sends nothing more", async () => {
    seed();
    await sendOne();
    const again = await sendRecoveryNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });
    expect(again.kind === "sent" && again.result.status).toBe("duplicate");
    expect(harness.sent).toHaveLength(1);
  });

  it("the toggle off is a named refusal, and NULL is on", async () => {
    seed({ enabled: 0 });
    expect(
      await sendRecoveryNotification(env, {
        accountId: ACCOUNT,
        failedPaymentId: FP,
      }),
    ).toEqual({
      kind: "skipped",
      reason: "disabled",
    });
    expect(harness.sent).toHaveLength(0);
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
    const out = await sendRecoveryNotification(failing, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });
    expect(out.kind === "sent" && out.result.status).toBe("failed");
  });
});

// ============================================================================
// The admin preview is the same function's output
// ============================================================================

describe("the admin preview of E10 is the mail the notifier sends", () => {
  it("carries the notice template's heading, button and Recova's footer", async () => {
    const type = findAdminEmailType("recovery_notification");
    expect(type).not.toBeNull();
    const prepared = await prepareAdminEmail(env, {
      type: type!,
      to: "admin@foxhoundapp.test",
      merchant: null,
      now: new Date(),
    });
    const preview = previewAdminEmail(env, type!, prepared);
    expect(preview.from).toBe("Foxhound <recovery@send.foxhoundapp.com>");
    expect(preview.html).toMatch(/<h1[^>]*>Payment recovered\.<\/h1>/);
    expect(preview.html).toMatch(/>View payment<\/a>/);
    expect(preview.text).toContain(
      `${FOOTER_NOTE}\nManage email settings: ${BASE}/settings`,
    );
  });
});
