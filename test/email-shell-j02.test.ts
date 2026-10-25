import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J02: every email Foxhound sends is built on Capsomer's shared email component
// (RULES.md 3.16, Q3: Dustin "yes", 2026-10-14). Every assertion here reads the
// message as it reaches env.EMAIL.send, never a helper's return value, because the
// claim is about what leaves: an HTML part in the family frame, a plain-text part
// made from the same content, and the CAN-SPAM footer on customer mail only.

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

const { sendEmail } = await import("~/lib/email/send");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { buildTemplateEmail } = await import("~/lib/recovery/email-template");
const { buildWinbackEmail, winbackSubject } = await import("~/lib/recovery/winback-email");
const { buildExpiringCardEmail, expiringCardSubject } = await import("~/lib/recovery/expiring-card-email");
const { digestContent } = await import("~/lib/recovery/digest-email");
const { sendRecoveryNotification } = await import("~/lib/recovery/merchant-notification.server");
const { sendSequenceCompleteNotification } = await import(
  "~/lib/recovery/sequence-complete-notification.server"
);
const { resendDepsFor } = await import("~/lib/recovery/manual-action-deps.server");
const { sendTestEmail } = await import("~/lib/settings/test-email.server");
const { buildFailureAlertEmail, buildStaleAlertEmail } = await import("~/lib/cron/alerts.server");
const { renderFoxhoundAlertEmail } = await import("~/lib/email/templates");
const { sendRenderedTransactionalEmail } = await import("~/lib/email/send");
const { buildMonthlyAuditEmail } = await import("~/lib/audit/monthly-email");

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

// ============================================================================
// Customer mail: dunning, win-back, expiring card, resend, the settings test
// ============================================================================

describe("customer mail carries both parts and the CAN-SPAM footer", () => {
  const CLICK = `${BASE}/e/c/click_tok-123`;
  const OPEN = `${BASE}/e/o/open_tok`;
  const TRAP = `${BASE}/e/h/trap_tok`;

  for (const category of ["soft", "expired", "fraud", "network", "revoked", "unknown"]) {
    it(`dunning fallback (${category}) through the recovery job`, async () => {
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
          customerEmail: "buyer@acme.test",
          amountCents: 4900,
          currency: "usd",
          merchantName: "Acme",
          senderName: "Acme",
          voiceDescription: null,
          cached: { customBody: null, cachedSubject: null, cachedBodyHtml: null },
        },
        copy,
        { unsubscribeToken: "unsub_tok", physicalAddress: ADDRESS, openUrl: OPEN, honeypotUrl: TRAP },
      );
      await sendEmail(env, job);
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
  }

  it("an AI-shaped body keeps its words and its link, and drops script", async () => {
    const body =
      `<p>Hi Jane,</p><p>Your payment of <strong>$12.00</strong> did not go through. ` +
      `You can <a href="${CLICK}">update your card here</a>.</p>` +
      `<script>alert(1)</script><ul><li>First point</li></ul><p>Thanks,<br />Acme</p>`;
    await sendEmail(env, customerJob(body));
    const m = only();
    expectBothParts(m, ["Hi Jane,", "$12.00", "update your card here", "First point", "Acme"]);
    expect(m.html).toContain(`href="${CLICK}"`);
    expect(m.html).not.toContain("<script");
    expect(m.text).not.toContain("alert(1)");
    expectCustomerFooter(m);
  });

  for (const step of [1, 2, 3]) {
    it(`win-back step ${step}`, async () => {
      const resubscribe = `${BASE}/p/resub_tok`;
      // J91: the win-back template is written as Capsomer's blocks.
      const blocks = buildWinbackEmail({
        stepNumber: step,
        customerName: "Jane",
        planName: "Pro",
        senderName: "Acme",
        resubscribeUrl: resubscribe,
      });
      await sendEmail(
        env,
        customerJob("", { bodyHtml: undefined, blocks, subject: winbackSubject({ stepNumber: step, planName: "Pro" }) }),
      );
      const m = only();
      expectBothParts(m, ["Hi Jane,", "Acme"]);
      expect(m.html).toContain(`href="${resubscribe}"`);
      expect(m.text).toContain(resubscribe);
      expectCustomerFooter(m);
    });
  }

  it("expiring card", async () => {
    const update = `${BASE}/p/card_tok`;
    // E12: the alert is written as Capsomer's blocks, not as an HTML body.
    const blocks = buildExpiringCardEmail({
      customerName: "Jane",
      cardBrand: "Visa",
      cardLast4: "4242",
      expiresMonth: 3,
      expiresYear: 2027,
      senderName: "Acme",
      updateUrl: update,
    });
    await sendEmail(
      env,
      customerJob("", {
        bodyHtml: undefined,
        blocks,
        subject: expiringCardSubject({ cardBrand: "Visa", cardLast4: "4242" }),
      }),
    );
    const m = only();
    expectBothParts(m, ["Hi Jane,", "Visa card ending in 4242", "03/2027", "Update Payment Method"]);
    expect(m.html).toContain(`href="${update}"`);
    expectCustomerFooter(m);
  });

  it("the manual resend", async () => {
    const result = await resendDepsFor(env).send({
      accountId: ACCOUNT,
      recoveryStepId: "step_1",
      to: "buyer@acme.test",
      subject: "Your payment",
      bodyHtml: `<p>Your payment did not go through.</p>`,
      now: new Date(2000),
    });
    expect(result.status).toBe("sent");
    const m = only();
    expectBothParts(m, ["Your payment did not go through."]);
    expectCustomerFooter(m);
  });

  it("a link the frame cannot carry is dropped to its words, and the send still goes", async () => {
    // Review fix 1. A cached AI body is reused on every retry, so a throw here
    // would fail the step every time and never reach the template fallback.
    await sendEmail(env, customerJob(`<p><a href="javascript:alert(1)">Pay</a> today.</p>`));
    const m = only();
    expectBothParts(m, ["Pay today."]);
    for (const part of [m.html, m.text ?? ""]) {
      expect(part).not.toContain("javascript:");
      expect(part).not.toContain("alert(1)");
    }
    expectCustomerFooter(m);
  });
});

// ============================================================================
// Merchant notices: never the footer
// ============================================================================

describe("merchant notices carry both parts and never the footer, except the digest", () => {
  it("the recovery notification", async () => {
    const out = await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(out.kind).toBe("sent");
    const m = only();
    expectBothParts(m, ["Payment recovered.", "Jane Buyer just paid", "View payment"]);
    expect(m.html).toContain(`href="${BASE}/recovery/payments/${FP}"`);
    expectNoCustomerFooter(m);
  });

  it("the sequence-complete notification", async () => {
    const out = await sendSequenceCompleteNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(out.kind).toBe("sent");
    const m = only();
    expectBothParts(m, ["Recovery sequence complete.", "View payment"]);
    expectNoCustomerFooter(m);
  });

  it("the weekly digest is the one merchant mail with the footer (E23)", async () => {
    // Recova wraps its digest with an unsubscribe token, so it carries
    // Unsubscribe and the postal address; RULES.md 3.16 keeps every other
    // merchant notice without them.
    const now = new Date("2026-10-12T09:00:00.000Z");
    await sendEmail(env, {
      accountId: ACCOUNT,
      to: "ops@acme.test",
      ...digestContent({
        totalFailed: 4,
        totalRecovered: 2,
        recoveredRevenueCents: 1200,
        atRiskRevenueCents: 5000,
        activeCount: 2,
        emailsSent: 7,
        winBackCount: 1,
        expiringCardCount: 0,
        openDisputeCount: 0,
        openDisputeCents: 0,
        currency: "usd",
        senderName: "Acme",
        disputesActive: false,
        intelligenceActive: false,
        highRiskCustomers: [],
        now,
        baseUrl: BASE,
      }),
      template: "weekly_digest",
      unsubscribeToken: "tok",
      physicalAddress: ADDRESS,
      idempotencyKey: "k",
      audience: "digest",
    });
    const m = only();
    expectBothParts(m, ["Your recovery summary", "Failed payments detected", "Revenue recovered", "View Dashboard"]);
    expectCustomerFooter(m);
  });
});

// ============================================================================
// Transactional platform mail: auth, operational alerts, the monthly audit
// ============================================================================

describe("the settings test email carries both parts and Recova's preview footer, never the CAN-SPAM one", () => {
  // E3: it goes to the signed-in user, not a customer, and Recova's preview
  // carries no unsubscribe and no postal address
  // (app/(app)/settings/test-email/route.ts, blob dcc3a06f).
  it("the settings test email", async () => {
    const { result } = await sendTestEmail(env, ACCOUNT, "owner@acme.test");
    expect(result.status).toBe("sent");
    const m = only();
    expectBothParts(m, [
      "PREVIEW: This is a sample recovery email.",
      "This is a preview email sent from Foxhound. Your real recovery emails will look like this.",
    ]);
    expectNoCustomerFooter(m);
  });
});

describe("transactional mail carries both parts and never the footer", () => {
  it("the cron failure and stale alerts", async () => {
    const now = new Date("2026-10-14T00:00:00.000Z");
    const failure = buildFailureAlertEmail(
      { cronName: "recovery", runId: "run_1", error: "boom: timed out", lastSuccessAt: null },
      now,
    );
    const to = "support@foxhoundapp.test";
    await sendRenderedTransactionalEmail(env, { to, rendered: renderFoxhoundAlertEmail({ to, ...failure }) });
    const stale = buildStaleAlertEmail(
      { cronName: "digest", reason: "never_run", lastRunAt: null, schedule: "0 8 * * 1" },
      now,
    );
    await sendRenderedTransactionalEmail(env, { to, rendered: renderFoxhoundAlertEmail({ to, ...stale }) });
    expect(harness.sent).toHaveLength(2);
    expectBothParts(harness.sent[0], ["recovery", "Run id: run_1", "boom: timed out"]);
    expectBothParts(harness.sent[1], ["digest", "Last succeeded: (never)"]);
    harness.sent.forEach(expectNoCustomerFooter);
  });

  it("the monthly audit", async () => {
    const ok = <T,>(data: T) => ({ ok: true as const, data });
    const message = buildMonthlyAuditEmail({
      result: {
        failedInvoices: ok({ count: 2, totalCents: 4200, totals: [{ currency: "usd", cents: 4200 }], byCategory: {}, byCategoryTotals: {} }),
        expiringCards: ok({ count: 1, mrrAtRiskCents: 1500, mrrAtRiskTotals: [{ currency: "usd", cents: 1500 }], expiresByMonth: {} }),
        pastDueSubscriptions: ok({ count: 0, totalCents: 0, totals: [] }),
        cardUpdater: ok({ eventsInWindow: 0, expiredCardDeclinesInWindow: 0, advisory: null, windowDays: 30 }),
        disputes: ok({
          open: { count: 1, totalCents: 9900, totals: [{ currency: "usd", cents: 9900 }] },
          acceptedWithoutFighting: { count: 0, totalCents: 0, totals: [] },
          historical: { won: 3, lost: 1 },
        }),
        health: ok({
          mrrCents: 100_000,
          mrrTotals: [{ currency: "usd", cents: 100_000 }],
          arrCents: 1_200_000,
          arrTotals: [{ currency: "usd", cents: 1_200_000 }],
          activeSubscriptionsCount: 42,
          voluntaryChurnRateBps: 210,
          involuntaryChurnRateBps: 90,
        }),
        meta: { stripeAccountId: "acct_x", lookbackDays: 90, currency: "usd", ranAt: new Date(0) },
      } as unknown as Parameters<typeof buildMonthlyAuditEmail>[0]["result"],
      summary: "One. Two. Three.",
      runId: "run_123",
      baseUrl: BASE,
      comparisons: [{ currency: "usd", cents: 1240, changeCents: 310 }],
    });
    // E24: merchant notice mail, written as Capsomer blocks, as the sender sends it.
    await sendEmail(env, {
      accountId: ACCOUNT,
      to: "owner@acme.test",
      fromName: "Foxhound",
      subject: message.subject,
      blocks: message.blocks,
      template: "monthly_audit",
      audience: "merchant",
      unsubscribeToken: "",
      physicalAddress: "",
      idempotencyKey: "monthly-audit:acct_1:2026-09",
    });
    const m = only();
    expectBothParts(m, ["What Foxhound did this month", "MRR:", "View full audit"]);
    expect(m.html).toContain(`href="${BASE}/audit/results/run_123"`);
    expectNoCustomerFooter(m);
  });
});

// ============================================================================
// The reader that turns a sender's HTML into Capsomer blocks
// ============================================================================

describe("htmlToBlocks keeps the sender's words and order", async () => {
  const { htmlToBlocks } = await import("~/lib/email/templates");

  it("a line break starts a new paragraph, and a real heading tag is a heading", () => {
    expect(htmlToBlocks(`<h1>Payment recovered.</h1><p>Thanks,<br />Acme</p>`)).toEqual([
      { type: "heading", text: "Payment recovered." },
      { type: "paragraph", text: "Thanks," },
      { type: "paragraph", text: "Acme" },
    ]);
  });

  it("bold inside a sentence stays in the sentence", () => {
    expect(htmlToBlocks(`<p>Jane just paid <strong>$99.00</strong>.</p>`)).toEqual([
      { type: "paragraph", text: "Jane just paid $99.00." },
    ]);
  });

  it("hidden content, script and comments never reach a block", () => {
    expect(
      htmlToBlocks(
        `<p>Seen</p><div style="display: none">Unseen</div><p aria-hidden="true">Nope</p><!-- note --><script>x()</script><style>p{}</style>`,
      ),
    ).toEqual([{ type: "paragraph", text: "Seen" }]);
  });

  it("table cells are paragraphs, and a cell's spans are kept apart", () => {
    expect(
      htmlToBlocks(
        `<table><tr><td>$12.00<span>Revenue recovered</span></td><td>50%<span>Recovery rate</span></td></tr></table>` +
          `<table><tr><td><span>Failed payments detected</span><span>4</span></td></tr></table>`,
      ),
    ).toEqual([
      { type: "paragraph", text: "$12.00 Revenue recovered" },
      { type: "paragraph", text: "50% Recovery rate" },
      { type: "paragraph", text: "Failed payments detected 4" },
    ]);
  });

  it("a whole small block is fine print", () => {
    expect(htmlToBlocks(`<p><small>If the button does not work:<br>https://x.test/a</small></p>`)).toEqual([
      { type: "fine", text: "If the button does not work:" },
      { type: "fine", text: "https://x.test/a" },
    ]);
  });
});

// ============================================================================
// Review fixes (J02 code review)
// ============================================================================

describe("review fixes to the HTML reader", async () => {
  const { htmlToBlocks } = await import("~/lib/email/templates");

  it("fix 2: numeric and common named entities are decoded; unknown ones stay", () => {
    expect(
      htmlToBlocks(
        "<p>it&rsquo;s &lsquo;a&rsquo; &ldquo;b&rdquo; &mdash; &ndash; &hellip; &euro;1 &pound;2 &yen;3 " +
          "&copy; &reg; &trade; x&nbsp;y &bull; &middot; &laquo;q&raquo; 2&times;3 9&deg; 5&cent; &sect;4 &para; " +
          "&#8217;&#x2019;&#X2014; &madeup; &amp;</p>",
      ),
    ).toEqual([
      {
        type: "paragraph",
        text:
          "it\u2019s \u2018a\u2019 \u201cb\u201d \u2014 \u2013 \u2026 \u20ac1 \u00a32 \u00a53 " +
          "\u00a9 \u00ae \u2122 x y \u2022 \u00b7 \u00abq\u00bb 2\u00d73 9\u00b0 5\u00a2 \u00a74 \u00b6 " +
          "\u2019\u2019\u2014 &madeup; &",
      },
    ]);
  });

  it("fix 3: a hidden li, td or p is closed by a sibling or a parent end tag", () => {
    expect(htmlToBlocks(`<ul><li hidden>secret<li>Shown</ul>`)).toEqual([{ type: "paragraph", text: "Shown" }]);
    expect(htmlToBlocks(`<ul><li hidden><ul><li>nested</li></ul>still hidden<li>Shown</ul>`)).toEqual([
      { type: "paragraph", text: "Shown" },
    ]);
    expect(htmlToBlocks(`<table><tr><td hidden>s<td>Cell</tr></table>`)).toEqual([{ type: "paragraph", text: "Cell" }]);
    expect(htmlToBlocks(`<div><p hidden>secret</div><p>After</p>`)).toEqual([{ type: "paragraph", text: "After" }]);
    expect(htmlToBlocks(`<p hidden>secret<div>Block</div>`)).toEqual([{ type: "paragraph", text: "Block" }]);
  });

  it("fix 3: a void or self-closing hidden element never opens a skip", () => {
    expect(htmlToBlocks(`<p><img hidden src="https://x.test/i.png" alt="">Still here</p>`)).toEqual([
      { type: "paragraph", text: "Still here" },
    ]);
    expect(htmlToBlocks(`<p><span hidden />Still</p><p>Next</p>`)).toEqual([
      { type: "paragraph", text: "Still" },
      { type: "paragraph", text: "Next" },
    ]);
  });

  it("fix 6: a second link opening inside the first keeps the first link's words", () => {
    expect(
      htmlToBlocks(`<p><a href="https://x.test/a">First <a href="https://x.test/b">Second</a> end</p>`),
    ).toEqual([
      { type: "paragraph", text: "First Second end" },
      { type: "button", label: "First", url: "https://x.test/a" },
      { type: "button", label: "Second", url: "https://x.test/b" },
    ]);
  });
});
