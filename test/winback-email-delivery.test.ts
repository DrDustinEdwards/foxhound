import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// What a win-back email carries when it leaves: sent at its offset to the sequence's customer, the
// merchant's From name and Reply-To, and the footer with a customer unsubscribe token. Assertions
// read the message as it reaches env.EMAIL.send, through the real cron, dispatch and send module.

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
const { verifyUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");

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

/** The footer sentence, then Unsubscribe, then the postal address. The link carries the recipient's
 *  own address-wide customer token (never a digest token, which suppresses nothing), the same one as
 *  the List-Unsubscribe header. */
async function expectFooter(m: SentMessage, senderName: string): Promise<void> {
  const sentence = `You're receiving this from ${senderName} about a recent payment. © ${YEAR}`;
  expectInOrder(m.text ?? "", [sentence, "Unsubscribe", ADDRESS]);
  expectInOrder(m.html, [
    `You&#39;re receiving this from ${senderName} about a recent payment.`,
    "Unsubscribe",
    ADDRESS,
  ]);
  expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/foxhoundapp\.test\/u\//);
  expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  const token = (m.headers?.["List-Unsubscribe"] ?? "").match(/\/u\/([^>]+)>/)?.[1] ?? "";
  expect(await verifyUnsubscribeToken(env, token)).toEqual({
    email: "buyer@acme.test",
    accountId: ACCOUNT,
  });
  expect(m.html).toContain(`/u/${token}"`);
}

describe("a win-back email at its offset", () => {
  const OFFSET = 96;

  it("sends at its offset to the sequence's customer, and not before", async () => {
    seed({ stepNumber: 2, offsetHours: OFFSET });
    expect(await runWinbackSends(env, at(OFFSET - 0.1))).toEqual({ sent: 0, skipped: 0 });
    expect(harness.sent).toHaveLength(0);
    expect(await runWinbackSends(env, at(OFFSET))).toEqual({ sent: 1, skipped: 0 });
    expect(only().to).toBe("buyer@acme.test");
  });

  it("does not send when the merchant turned win-back off", async () => {
    seed({ stepNumber: 2, offsetHours: OFFSET, toggle: 0 });
    expect(await runWinbackSends(env, at(OFFSET))).toEqual({ sent: 0, skipped: 1 });
    expect(harness.sent).toHaveLength(0);
  });

  it("carries one resubscribe link, the merchant's From name and Reply-To, and the footer", async () => {
    seed({ stepNumber: 2, offsetHours: OFFSET });
    await runWinbackSends(env, at(OFFSET));
    const m = only();
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    const resubscribe = hrefs.filter((h) => h.startsWith(`${BASE}/p/`));
    expect(resubscribe).toHaveLength(1);
    expect(m.text).toContain(resubscribe[0]);
    expect(m.from).toMatch(/^Teamflow </);
    expect(m.replyTo).toBe(REPLY);
    await expectFooter(m, "Teamflow");
  });
});

describe("the AI copy path carries the same From, Reply-To and footer", () => {
  it("generated copy goes out with the footer, From, Reply-To and the minted link", async () => {
    seed({ stepNumber: 2, offsetHours: 96 });
    harness.generated = {
      subject: "Something new for you, Jane",
      bodyHtml:
        '<p>Hi Jane,</p><p>We made it better.</p><p><a href="{{url}}">Come Back</a></p><p>Thanks,<br>Teamflow</p>',
    };
    const keyed = { ...env, ANTHROPIC_API_KEY: "sk-example" } as unknown as Env;
    expect(await runWinbackSends(keyed, at(96))).toEqual({ sent: 1, skipped: 0 });
    const m = only();
    expect(m.subject).toBe("Something new for you, Jane");
    expectInOrder(m.text ?? "", [
      "Hi Jane,",
      "We made it better.",
      "Come Back",
      "Thanks,",
      "Teamflow",
    ]);
    expect(m.from).toMatch(/^Teamflow </);
    expect(m.replyTo).toBe(REPLY);
    await expectFooter(m, "Teamflow");
    const row = sqlite.prepare("SELECT result FROM win_back_steps WHERE id = 'st_1'").get() as {
      result: string;
    };
    expect(row.result).toBe("email_sent_ai");
  });
});

describe("the generation prompt gets the real delay", () => {
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
