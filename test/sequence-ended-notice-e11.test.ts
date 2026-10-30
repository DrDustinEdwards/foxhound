import type Database from "better-sqlite3";
import { escapeHtml } from "capsomer/email";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E11: the Recovery sequence ended notice to the
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

const { sendSequenceCompleteNotification } =
  await import("~/lib/recovery/sequence-complete-notification.server");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const FP = "fp_1";
// Recova's footer sentence, wrapEmailHtml(notifyBody, 'Recova', undefined), with
// Foxhound's name: "You're receiving this from ${senderName} about a recent
// payment. &copy; ${year}".
// Recova's sentence (route.ts line 398), less the false "7-day".

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

  it("a customer name is shown as written, never read as markup", async () => {
    seed({ customerName: "Tom & Jerry <Co>" });
    const m = await sendOne();
    expect(m.subject).toBe("Recovery sequence ended: $99.00 from Tom & Jerry <Co> was not recovered");
    expect(m.html).toContain(`>The recovery sequence for ${escapeHtml("Tom & Jerry <Co>")} ($99.00) has ended`);
    expect(m.html).not.toContain("<Co>");
    expect(m.text).toContain("The recovery sequence for Tom & Jerry <Co> ($99.00) has ended");
  });
});
