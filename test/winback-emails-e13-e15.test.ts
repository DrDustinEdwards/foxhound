import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J91, rows E13, E14 and E15: the three win-back emails. Recova is the spec
// (app/api/cron/process-winback/route.ts, blob 18f20de9; lib/email.ts, blob
// 3f882729): what each email says (subject, every sentence, the button label,
// the sign-off), what it carries (From, Reply-To, both parts, Recova's footer
// sentence before the unsubscribe and the postal address) and when it sends.
//
// Every assertion reads the message as it reaches env.EMAIL.send, through the
// real cron, the real dispatch and the real send module, because the claim is
// about what leaves.

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
  generated: null as null | { subject: string; bodyHtml: string },
  promptInputs: [] as Record<string, unknown>[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/recovery/winback-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/recovery/winback-generation")>()),
  generateWinbackEmail: async (_env: unknown, input: Record<string, unknown>) => {
    harness.promptInputs.push(input);
    if (!harness.generated) throw new Error("no generated copy planted");
    return {
      subject: harness.generated.subject,
      bodyHtml: harness.generated.bodyHtml.replaceAll("{{url}}", String(input.resubscribeUrl)),
    };
  },
}));

const { runWinbackSends } = await import("~/lib/cron/winback");
const { buildWinbackEmail } = await import("~/lib/recovery/winback-email");
const { buildWinbackPrompt } = await import("~/lib/recovery/winback-generation");
const { signCardUpdateToken } = await import("~/lib/card-update/token");
const { verifyUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
const { WIN_BACK_SCHEDULE } = await import("~/lib/recovery/schedule");
const { WINBACK_UNFLAGGED_STEP1_HOURS } = await import("~/lib/constants");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const REPLY = "help@teamflow.test";
const HOUR = 60 * 60 * 1000;
const CANCELLED = new Date("2026-11-01T00:00:00Z");
const YEAR = 2026;

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
  harness.generated = null;
  harness.promptInputs = [];
});

function seed(opts: {
  stepNumber: number;
  offsetHours: number;
  senderName?: string | null;
  replyTo?: string | null;
  customerName?: string | null;
  planName?: string | null;
  toggle?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, live_sends_enabled, winback_notifications_enabled) VALUES (?, 'Acme', 1000, 1, ?)",
    )
    .run(ACCOUNT, opts.toggle === undefined ? null : opts.toggle);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, reply_to_email, connected_at, created_at) VALUES ('c1', ?, 'acct_s_1', 1, 'cipher', ?, ?, 1000, 1000)",
    )
    .run(
      ACCOUNT,
      opts.senderName === undefined ? "Teamflow" : opts.senderName,
      opts.replyTo === undefined ? REPLY : opts.replyTo,
    );
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, customer_name, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES ('wb_1', ?, 'cus_wb', 'sub_1', 'buyer@acme.test', ?, ?, 4900, 'usd', 'active', ?, 'c1')",
    )
    .run(
      ACCOUNT,
      opts.customerName === undefined ? "Jane" : opts.customerName,
      opts.planName === undefined ? "Pro" : opts.planName,
      CANCELLED.getTime(),
    );
  sqlite
    .prepare(
      "INSERT INTO win_back_steps (id, win_back_sequence_id, account_id, step_number, scheduled_at, attempt_count) VALUES ('st_1', 'wb_1', ?, ?, ?, 0)",
    )
    .run(ACCOUNT, opts.stepNumber, CANCELLED.getTime() + opts.offsetHours * HOUR);
}

const at = (hours: number) => new Date(CANCELLED.getTime() + hours * HOUR);

function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

/** The sentences in order, each appearing after the one before it. */
function expectInOrder(part: string, sentences: string[]): void {
  let from = 0;
  for (const s of sentences) {
    const i = part.indexOf(s, from);
    expect(i, `"${s}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = i + s.length;
  }
}

/** Recova's footer, as wrapEmailHtml writes it with an unsubscribe token: the
 *  sentence, then Unsubscribe, then the postal address. The token is the
 *  recipient's own address-wide customer token, never a digest token (which
 *  suppresses nothing) and never another address's, and the footer link carries
 *  the same token as the List-Unsubscribe header. */
async function expectRecovaFooter(m: SentMessage, senderName: string): Promise<void> {
  const sentence = `You're receiving this from ${senderName} about a recent payment. © ${YEAR}`;
  expectInOrder(m.text ?? "", [sentence, "Unsubscribe", ADDRESS]);
  expectInOrder(m.html, [`You&#39;re receiving this from ${senderName} about a recent payment.`, "Unsubscribe", ADDRESS]);
  expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/foxhoundapp\.test\/u\//);
  expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  const token = (m.headers?.["List-Unsubscribe"] ?? "").match(/\/u\/([^>]+)>/)?.[1] ?? "";
  expect(await verifyUnsubscribeToken(env, token)).toEqual({ email: "buyer@acme.test", accountId: ACCOUNT });
  expect(m.html).toContain(`/u/${token}"`);
}

const ROWS = [
  {
    row: "E13",
    stepNumber: 1,
    offsetHours: 1,
    subject: "We're sorry to see you go. Here's what you're missing.",
    sentences: [
      "Hi Jane,",
      "We noticed you recently cancelled your Pro subscription. We're sorry to see you go.",
      "If there's anything we could have done better, we'd love to hear from you. And if you ever want to come back, we'll be here.",
      "Reactivate My Account",
      "Thanks for being a customer,",
      "Teamflow",
    ],
    button: "Reactivate My Account",
  },
  {
    row: "E14",
    stepNumber: 2,
    offsetHours: 96,
    subject: "A quick update since you left",
    sentences: [
      "Hi Jane,",
      "It's been a few days since you cancelled, and we wanted to share what's new.",
      "We've been working hard on improvements and would love to have you back. Your account can be reactivated instantly.",
      "Come Back",
      "Thanks,",
      "Teamflow",
    ],
    button: "Come Back",
  },
  {
    row: "E15",
    stepNumber: 3,
    offsetHours: 336,
    subject: "Last chance to reactivate your account",
    sentences: [
      "Hi Jane,",
      "This is our last check-in. If you've decided to move on, we completely understand and wish you the best.",
      "But if you've been on the fence, now's a great time to come back. Your data is still here waiting for you.",
      "Reactivate Now",
      "Thanks for giving us a shot,",
      "Teamflow",
    ],
    button: "Reactivate Now",
  },
] as const;

describe("J91: each win-back email says and carries what Recova's does", () => {
  it("the webhook schedules Recova's offsets: 1, 96 and 336 hours, and 4 for an unflagged step 1 under Intelligence", () => {
    // Recova's WIN_BACK_SCHEDULE (lib/recovery-schedules.ts, blob 88f4e97a) and
    // its handleSubscriptionDeleted's `step1OffsetHours = 4`. The sends below
    // seed each step at the offset this schedule gives it.
    expect(WIN_BACK_SCHEDULE.map((s) => [s.stepNumber, s.offsetHours])).toEqual(
      ROWS.map((r) => [r.stepNumber, r.offsetHours]),
    );
    expect(WINBACK_UNFLAGGED_STEP1_HOURS).toBe(4);
  });

  for (const r of ROWS) {
    describe(`${r.row}, win-back step ${r.stepNumber}`, () => {
      it("sends at Recova's offset to the sequence's customer, and not before", async () => {
        seed({ stepNumber: r.stepNumber, offsetHours: r.offsetHours });
        expect(await runWinbackSends(env, at(r.offsetHours - 0.1))).toEqual({ sent: 0, skipped: 0 });
        expect(harness.sent).toHaveLength(0);
        expect(await runWinbackSends(env, at(r.offsetHours))).toEqual({ sent: 1, skipped: 0 });
        expect(only().to).toBe("buyer@acme.test");
      });

      it("does not send when the merchant turned win-back off", async () => {
        seed({ stepNumber: r.stepNumber, offsetHours: r.offsetHours, toggle: 0 });
        expect(await runWinbackSends(env, at(r.offsetHours))).toEqual({ sent: 0, skipped: 1 });
        expect(harness.sent).toHaveLength(0);
      });

      it("says Recova's subject and every sentence, in order, in both parts", async () => {
        seed({ stepNumber: r.stepNumber, offsetHours: r.offsetHours });
        await runWinbackSends(env, at(r.offsetHours));
        const m = only();
        expect(m.subject).toBe(r.subject);
        expectInOrder(m.text ?? "", [...r.sentences]);
        expectInOrder(
          m.html,
          r.sentences.map((s) => s.replaceAll("'", "&#39;")),
        );
      });

      it("its one button carries Recova's label and the resubscribe link for this step", async () => {
        seed({ stepNumber: r.stepNumber, offsetHours: r.offsetHours });
        await runWinbackSends(env, at(r.offsetHours));
        const m = only();
        const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
        const resubscribe = hrefs.filter((h) => h.startsWith(`${BASE}/p/`));
        expect(resubscribe).toHaveLength(1);
        expect(m.html).toMatch(new RegExp(`href="${resubscribe[0]}"[^>]*>\\s*${r.button}\\s*<`));
        expect(m.text).toContain(resubscribe[0]);
      });

      it("carries the merchant's From name, its Reply-To, and Recova's footer before the unsubscribe and address", async () => {
        seed({ stepNumber: r.stepNumber, offsetHours: r.offsetHours });
        await runWinbackSends(env, at(r.offsetHours));
        const m = only();
        expect(m.from).toMatch(/^Teamflow </);
        expect(m.replyTo).toBe(REPLY);
        await expectRecovaFooter(m, "Teamflow");
      });
    });
  }

  it("Recova's fallbacks: no sender name reads Support in the From, the sign-off and the footer", async () => {
    seed({ stepNumber: 2, offsetHours: 96, senderName: null, replyTo: null, customerName: null });
    await runWinbackSends(env, at(96));
    const m = only();
    expect(m.from).toMatch(/^Support </);
    expect(m.replyTo).toBeUndefined();
    expectInOrder(m.text ?? "", ["Hi there,", "Thanks,", "Support"]);
    await expectRecovaFooter(m, "Support");
  });

  it("a customer name is shown exactly as Stripe has it, never read as markup", async () => {
    seed({ stepNumber: 1, offsetHours: 1, customerName: "Ann <Admin> & Co" });
    await runWinbackSends(env, at(1));
    const m = only();
    expect(m.text).toContain("Hi Ann <Admin> & Co,");
    expect(m.html).toContain("Hi Ann &lt;Admin&gt; &amp; Co,");
  });

  it("the template is Capsomer's blocks, its one button the resubscribe link", () => {
    const blocks = buildWinbackEmail({
      stepNumber: 3,
      customerName: "Jane",
      planName: "Pro",
      senderName: "Teamflow",
      resubscribeUrl: `${BASE}/p/tok`,
    });
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toContainEqual({ type: "button", label: "Reactivate Now", url: `${BASE}/p/tok` });
  });
});

describe("J91: the AI copy path is on the same component and carries the same footer", () => {
  it("generated copy goes out with Recova's footer, From, Reply-To and the minted link", async () => {
    seed({ stepNumber: 2, offsetHours: 96 });
    harness.generated = {
      subject: "Something new for you, Jane",
      bodyHtml: '<p>Hi Jane,</p><p>We made it better.</p><p><a href="{{url}}">Come Back</a></p><p>Thanks,<br>Teamflow</p>',
    };
    const keyed = { ...env, ANTHROPIC_API_KEY: "sk-example" } as unknown as Env;
    expect(await runWinbackSends(keyed, at(96))).toEqual({ sent: 1, skipped: 0 });
    const m = only();
    expect(m.subject).toBe("Something new for you, Jane");
    expectInOrder(m.text ?? "", ["Hi Jane,", "We made it better.", "Come Back", "Thanks,", "Teamflow"]);
    expect(m.from).toMatch(/^Teamflow </);
    expect(m.replyTo).toBe(REPLY);
    await expectRecovaFooter(m, "Teamflow");
    const row = sqlite.prepare("SELECT result FROM win_back_steps WHERE id = 'st_1'").get() as { result: string };
    expect(row.result).toBe("email_sent_ai");
  });

  it("cached copy from an earlier tick goes out with the same footer", async () => {
    seed({ stepNumber: 3, offsetHours: 336 });
    const token = await signCardUpdateToken(env, { winBackSequenceId: "wb_1", winBackStepNumber: 3, accountId: ACCOUNT });
    sqlite
      .prepare("UPDATE win_back_steps SET ai_subject = ?, ai_body_html = ? WHERE id = 'st_1'")
      .run("One last note", `<p>Hi Jane,</p><p><a href="${BASE}/p/${token}">Reactivate Now</a></p>`);
    await runWinbackSends(env, at(336));
    const m = only();
    expect(m.subject).toBe("One last note");
    await expectRecovaFooter(m, "Teamflow");
  });
});

describe("J91: the prompt states the real delay before each email (truthfulness fix)", () => {
  const base = {
    customerName: "Jane",
    planName: "Pro",
    cancelReason: null,
    brandVoice: null,
    senderName: "Teamflow",
    resubscribeUrl: `${BASE}/p/tok`,
  };

  it("step 1 on an Intelligence account goes at 4 hours, and the prompt says 4 hours, not 1", () => {
    const p = buildWinbackPrompt({ ...base, stepNumber: 1, offsetHours: 4 });
    expect(p).toContain("This is a first win-back email sent 4 hours after cancellation, warm, empathetic, not pushy.");
    expect(p).not.toContain("1 hour");
  });

  it("Recova's three delays read as Recova words them", () => {
    expect(buildWinbackPrompt({ ...base, stepNumber: 1, offsetHours: 1 })).toContain("sent 1 hour after cancellation");
    expect(buildWinbackPrompt({ ...base, stepNumber: 2, offsetHours: 96 })).toContain("sent 4 days after cancellation");
    expect(buildWinbackPrompt({ ...base, stepNumber: 3, offsetHours: 336 })).toContain("sent 14 days after cancellation");
  });

  it("the cron passes the step's own delay, read from the sequence and the step", async () => {
    seed({ stepNumber: 1, offsetHours: 4 });
    harness.generated = {
      subject: "We miss you",
      bodyHtml: '<p>Hi Jane,</p><p><a href="{{url}}">Reactivate My Account</a></p>',
    };
    const keyed = { ...env, ANTHROPIC_API_KEY: "sk-example" } as unknown as Env;
    await runWinbackSends(keyed, at(4));
    expect(harness.promptInputs).toHaveLength(1);
    expect(harness.promptInputs[0].offsetHours).toBe(4);
  });
});
