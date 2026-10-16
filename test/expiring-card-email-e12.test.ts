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
const { buildExpiringCardEmail, expiringCardSubject } = await import("~/lib/recovery/expiring-card-email");
const { buildEmailMessage } = await import("~/lib/email/send");
const { ADMIN_EMAIL_TYPES, prepareAdminEmail } = await import("~/lib/admin/email-send.server");
const { EMAIL_FROM_ADDRESS } = await import("~/lib/constants");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_e12";
const NOW = new Date("2026-11-01T00:00:00Z");
const UPDATE_URL = `${BASE}/p/EXAMPLE-NOT-A-TOKEN`;

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

function alertSentAt(): number | null {
  return (sqlite.prepare("SELECT alert_sent_at AS s FROM expiring_card_alerts WHERE id = 'al_1'").get() as { s: number | null }).s;
}

// ---- what it says ----------------------------------------------------------------

describe("E12 says Recova's words, on Capsomer's blocks", () => {
  it("each of Recova's paragraphs is one block, and the button is Recova's label", () => {
    // Recova's buildExpiringCardEmail, sentence by sentence. Its <strong> runs
    // around the card and the date wait on Capsomer's bold run
    // (capsomer job_2adddfaab5dc); the words are kept exactly.
    const blocks = buildExpiringCardEmail({
      customerName: "Jane Buyer",
      cardBrand: "visa",
      cardLast4: "4242",
      expiresMonth: 3,
      expiresYear: 2027,
      senderName: "Acme Billing",
      updateUrl: UPDATE_URL,
    });
    expect(blocks).toEqual([
      { type: "paragraph", text: "Hi Jane Buyer," },
      {
        type: "paragraph",
        text: "We wanted to give you a heads up that your visa card ending in 4242 is expiring on 03/2027.",
      },
      {
        type: "paragraph",
        text: "To avoid any interruption to your service, please update your payment method before it expires.",
      },
      { type: "button", label: "Update Payment Method", url: UPDATE_URL },
      { type: "paragraph", text: "If you've already updated your card, you can ignore this message." },
      // Recova's "Thanks,<br>{senderName}": Capsomer's paragraph has no line
      // break, so the two lines are two paragraphs, same words.
      { type: "paragraph", text: "Thanks," },
      { type: "paragraph", text: "Acme Billing" },
    ]);
  });

  it("Recova's fallbacks: there, Card, ****, Support", () => {
    const blocks = buildExpiringCardEmail({
      customerName: null,
      cardBrand: null,
      cardLast4: null,
      expiresMonth: 3,
      expiresYear: 2027,
      senderName: null,
      updateUrl: UPDATE_URL,
    });
    const texts = blocks.flatMap((b) => ("text" in b ? [b.text] : []));
    expect(texts[0]).toBe("Hi there,");
    expect(texts[1]).toBe("We wanted to give you a heads up that your Card card ending in **** is expiring on 03/2027.");
    expect(texts.at(-1)).toBe("Support");
    expect(expiringCardSubject({ cardBrand: null, cardLast4: null })).toBe(
      "Action required: Your Card card ending in **** is expiring",
    );
  });

  it("a customer name is shown exactly as Stripe holds it, escaped by Capsomer, never read as markup", async () => {
    seedMerchant();
    seedAlert({ customerName: 'Jane "JJ" <Buyer> & Co' });

    await sendExpiringCardAlerts(env, NOW);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].text).toContain('Hi Jane "JJ" <Buyer> & Co,');
    expect(harness.sent[0].html).toContain("Hi Jane &quot;JJ&quot; &lt;Buyer&gt; &amp; Co,");
  });
});

// ---- what it carries --------------------------------------------------------------

describe("E12 carries Recova's parts, From, Reply-To, footer and links", () => {
  it("subject, From name, a text part with every sentence, and the button to Foxhound's card-update page", async () => {
    seedMerchant();
    seedAlert();

    await sendExpiringCardAlerts(env, NOW);

    const m = harness.sent[0];
    expect(m.subject).toBe("Action required: Your visa card ending in 4242 is expiring");
    expect(m.from).toBe(`Acme Billing <${EMAIL_FROM_ADDRESS}>`);
    const text = m.text ?? "";
    const order = [
      "Hi Jane Buyer,",
      "We wanted to give you a heads up that your visa card ending in 4242 is expiring on 11/2026.",
      "To avoid any interruption to your service, please update your payment method before it expires.",
      "Update Payment Method:\nhttps://foxhoundapp.test/p/",
      "If you've already updated your card, you can ignore this message.",
      "Thanks,\n\nAcme Billing",
    ].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The button is a real link with its visible label.
    expect(m.html).toMatch(/<a class="e-btn" href="https:\/\/foxhoundapp\.test\/p\/[^"]+"[^>]*>Update Payment Method<\/a>/);
  });

  it("the footer carries Recova's sentence, then the unsubscribe link and the postal address, in both parts", async () => {
    seedMerchant();
    seedAlert();

    await sendExpiringCardAlerts(env, NOW);

    const m = harness.sent[0];
    const note = "You're receiving this from Acme Billing about a recent payment. © 2026";
    const text = m.text ?? "";
    const at = [note, "Unsubscribe: https://foxhoundapp.test/u/", ADDRESS].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(m.html).toContain("You&#39;re receiving this from Acme Billing about a recent payment. © 2026");
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/foxhoundapp\.test\/u\//);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("with no sender name, the footer says Support, as Recova's sender_name || 'Support'", async () => {
    seedMerchant({ senderName: null });
    seedAlert();

    await sendExpiringCardAlerts(env, NOW);

    expect(harness.sent[0].from).toBe(`Support <${EMAIL_FROM_ADDRESS}>`);
    expect(harness.sent[0].text).toContain("You're receiving this from Support about a recent payment.");
  });

  it("Reply-To is the merchant's saved address (J03), and absent when none is saved", async () => {
    seedMerchant({ replyTo: "help@acme.example" });
    seedAlert();
    await sendExpiringCardAlerts(env, NOW);
    expect(harness.sent[0].replyTo).toBe("help@acme.example");

    beforeEachReset();
    seedMerchant({ replyTo: null });
    seedAlert();
    await sendExpiringCardAlerts(env, NOW);
    expect(harness.sent[0].replyTo).toBeUndefined();
  });

  it("the rendered mail has a language, the subject as its title, and 16px body text", async () => {
    seedMerchant();
    seedAlert();

    await sendExpiringCardAlerts(env, NOW);

    const html = harness.sent[0].html;
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Action required: Your visa card ending in 4242 is expiring</title>");
    expect(html).toMatch(/font-size:16px;line-height:24px;[^"]*">Hi Jane Buyer,</);
  });

  it("the owner's admin preview is the same mail: the same blocks and Recova's footer sentence", async () => {
    const type = ADMIN_EMAIL_TYPES.find((t) => t.type === "expiring_card");
    if (!type) throw new Error("no expiring_card type");
    const prepared = await prepareAdminEmail(env, {
      type,
      to: "owner@example.com",
      merchant: {
        accountId: ACCOUNT,
        senderName: "Acme Billing",
        replyTo: null,
      } as unknown as Parameters<typeof prepareAdminEmail>[1]["merchant"],
      now: NOW,
    });
    if (prepared.channel !== "job") throw new Error("expected a job");
    const m = buildEmailMessage(prepared.job, BASE);
    expect(m.text).toContain("Hi there,");
    expect(m.text).toContain("Update Payment Method:\nhttps://foxhoundapp.test/settings/email");
    expect(m.text).toContain("You're receiving this from Acme Billing about a recent payment. © 2026");
  });
});

// ---- when it sends ----------------------------------------------------------------

describe("E12 sends on Recova's trigger, to Recova's recipient, and not otherwise", () => {
  it("an unsent candidate on an account with the toggle unset (NULL is on) goes to the customer's own address", async () => {
    seedMerchant({ enabled: null });
    seedAlert({ email: "jane@buyer.example" });

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result.sent).toBe(1);
    expect(harness.sent.map((m) => m.to)).toEqual(["jane@buyer.example"]);
  });

  it("the toggle off sends nothing and stamps the candidate, as Recova does", async () => {
    seedMerchant({ enabled: 0 });
    seedAlert();

    await sendExpiringCardAlerts(env, NOW);

    expect(harness.sent).toHaveLength(0);
    expect(alertSentAt()).not.toBeNull();
  });

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

function beforeEachReset(): void {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sent = [];
}
