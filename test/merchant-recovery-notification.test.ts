
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// THE MERCHANT RECOVERY NOTIFICATION, ported from legacy's stripe webhook
// (blob deb585e4), the "Notify merchant" block in handlePaymentSucceeded.
//
// EVERY PLANT OBSERVES email_sends OR THE SENT MESSAGE, never a helper's return
// value: the point of this engine is that a real email leaves, and a mutation
// that detaches the hook has to go red at the table.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as { from: string; to: string; subject: string; html: string; headers?: unknown }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { sendRecoveryNotification } =
  await import("~/lib/recovery/merchant-notification.server");
const { LIVE_SENDS_DISABLED_ERROR } = await import("~/lib/email/dispatch");

const ACCOUNT = "acct_1";
const FP = "fp_1";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
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

function seed(opts: {
  notificationEmail?: string | null;
  enabled?: number | null;
  liveSends?: number;
  customerName?: string | null;
  amountCents?: number;
  currency?: string;
  declineCategory?: string;
}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, recovery_notifications_enabled, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?, ?)",
    )
    .run(
      ACCOUNT,
      opts.notificationEmail === undefined ? "ops@acme.test" : opts.notificationEmail,
      opts.enabled === undefined ? null : opts.enabled,
      opts.liveSends === undefined ? 1 : opts.liveSends,
    );
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, 'evt', 'in_1', 'cus_1', 'buyer@acme.test', ?, ?, ?, ?, 'recovered', 1000)",
    )
    .run(
      FP,
      ACCOUNT,
      opts.customerName === undefined ? "Jane Buyer" : opts.customerName,
      opts.amountCents ?? 9900,
      opts.currency ?? "usd",
      opts.declineCategory ?? "soft",
    );
}

function sendRows() {
  return sqlite
    .prepare("SELECT status, template, error FROM email_sends WHERE account_id = ?")
    .all(ACCOUNT) as { status: string; template: string | null; error: string | null }[];
}

describe("PLANT 1: a recovery with the toggle NULL sends one email", () => {

  it("falls back to the customer EMAIL when there is no name, as legacy does", async () => {
    seed({ enabled: null, customerName: null });
    await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(harness.sent[0].subject).toBe("Payment recovered: $99.00 from buyer@acme.test");
  });
});

describe("PLANT 2: the toggle and the recipient are legacy's", () => {
  it("FALSE sends nothing and logs nothing", async () => {
    seed({ enabled: 0 });
    const result = await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    // A named REFUSAL, not a swallowed crash. The two used to look identical.
    expect(result).toEqual({ kind: "skipped", reason: "disabled" });
    expect(harness.sent).toHaveLength(0);
    expect(sendRows()).toHaveLength(0);
  });

  it("NO notification email means NO send, and legacy has no owner fallback", async () => {
    // Legacy's guard is `if (notifyEmail && ...)`. An account that never set one
    // is simply not notified; inventing a fallback would mail an address the
    // merchant never nominated.
    seed({ notificationEmail: null, enabled: null });
    const result = await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(result).toEqual({ kind: "skipped", reason: "no_recipient" });
    expect(harness.sent).toHaveLength(0);
    expect(sendRows()).toHaveLength(0);
  });
});

describe("PLANT 3: the demo refusal is the same gate every send meets", () => {
  it("an account without live sends is blocked, and the block is logged", async () => {
    seed({ enabled: null, liveSends: 0 });

    const result = await sendRecoveryNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });

    expect(result.kind === "sent" && result.result.status).toBe("blocked");
    expect(harness.sent).toHaveLength(0);
    const rows = sendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].error).toBe(LIVE_SENDS_DISABLED_ERROR);
  });
});

describe("PLANT 9: the cases a single happy fixture cannot reach", () => {

  it("a payment on ANOTHER account is not found, so the read is account-scoped", async () => {
    seed({ enabled: null });
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, notification_email) VALUES ('acct_other', 'Other', 1000, 'them@other.test')")
      .run();

    // The payment exists; it just is not this account's.
    const result = await sendRecoveryNotification(env, {
      accountId: "acct_other",
      failedPaymentId: FP,
    });

    expect(result).toEqual({ kind: "skipped", reason: "not_found" });
    expect(harness.sent).toHaveLength(0);
  });

  it("a DATABASE failure is caught and named, never thrown at the webhook", async () => {
    // processEmailJob swallows send errors itself, so only a failure BEFORE it
    // exercises the outer catch. That catch is the reason a mail problem cannot
    // unwind a committed recovery or fail the webhook.
    harness.db = {
      select() {
        throw new Error("d1 exploded");
      },
    };

    const result = await sendRecoveryNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toBe("d1 exploded");
  });
});
