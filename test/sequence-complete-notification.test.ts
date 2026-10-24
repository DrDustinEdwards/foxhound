
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// THE SEQUENCE-COMPLETE NOTIFICATION, ported from legacy's process-recovery cron
// (blob 7015998c), the "Notify merchant - sequence complete, unrecovered" block.
//
// Every plant observes email_sends or the sent message. The ones that matter
// most are the MUTUAL EXCLUSION (a sequence that ends by recovery must get the
// other notice and never this one) and the CLAIM (a re-run of the terminal tick
// sends nothing more).

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as { from: string; to: string; subject: string; html: string; headers?: unknown }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { sendSequenceCompleteNotification } =
  await import("~/lib/recovery/sequence-complete-notification.server");

const ACCOUNT = "acct_1";
const FP = "fp_1";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way, Austin TX",
  EMAIL: {
    send: async (m: { from: string; to: string; subject: string; html: string; headers?: unknown }) => {
      harness.sent.push(m);
      return { id: "msg_1" };
    },
  },
} as unknown as Env;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
});

function seedAccount(opts: {
  notificationEmail?: string | null;
  enabled?: number | null;
  liveSends?: number;
}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, sequence_complete_notifications_enabled, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?, ?)",
    )
    .run(
      ACCOUNT,
      opts.notificationEmail === undefined ? "ops@acme.test" : opts.notificationEmail,
      opts.enabled === undefined ? null : opts.enabled,
      opts.liveSends === undefined ? 1 : opts.liveSends,
    );
}

function seedPayment(opts: {
  id?: string;
  status?: string;
  customerName?: string | null;
  amountCents?: number;
  currency?: string;
}): void {
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, ?, ?, 'cus_1', 'buyer@acme.test', ?, ?, ?, 'soft', ?, 1000)",
    )
    .run(
      opts.id ?? FP,
      ACCOUNT,
      "evt_" + (opts.id ?? FP),
      "in_" + (opts.id ?? FP),
      opts.customerName === undefined ? "Jane Buyer" : opts.customerName,
      opts.amountCents ?? 9900,
      opts.currency ?? "usd",
      opts.status ?? "active",
    );
}


function sendRows() {
  return sqlite
    .prepare("SELECT status, template, error FROM email_sends WHERE account_id = ?")
    .all(ACCOUNT) as { status: string; template: string | null; error: string | null }[];
}

describe("PLANT 2: the toggle and the recipient are legacy's", () => {
  it("FALSE sends nothing and names the refusal", async () => {
    seedAccount({ enabled: 0 });
    seedPayment({});
    const result = await sendSequenceCompleteNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });
    expect(result).toEqual({ kind: "skipped", reason: "disabled" });
    expect(harness.sent).toHaveLength(0);
    expect(sendRows()).toHaveLength(0);
  });

  it("NO notification email means NO send, and there is no owner fallback", async () => {
    seedAccount({ notificationEmail: null, enabled: null });
    seedPayment({});
    const result = await sendSequenceCompleteNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });
    expect(result).toEqual({ kind: "skipped", reason: "no_recipient" });
    expect(harness.sent).toHaveLength(0);
  });

  it("a payment on ANOTHER account is not found", async () => {
    seedAccount({ enabled: null });
    seedPayment({});
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, notification_email) VALUES ('acct_other', 'O', 1000, 'them@o.test')")
      .run();
    const result = await sendSequenceCompleteNotification(env, {
      accountId: "acct_other",
      failedPaymentId: FP,
    });
    expect(result).toEqual({ kind: "skipped", reason: "not_found" });
  });
});

describe("PLANT 3: the demo refusal and a send failure", () => {

  it("a database failure is caught and named, never thrown at the tick", async () => {
    harness.db = { select() { throw new Error("d1 exploded"); } };
    const result = await sendSequenceCompleteNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toBe("d1 exploded");
  });
});
