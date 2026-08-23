import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const { sendSequenceCompleteNotification, sequenceCompleteSubject, sequenceCompleteBody, SEQUENCE_COMPLETE_TEMPLATE } =
  await import("~/lib/recovery/sequence-complete-notification.server");
const { flipExhaustedSequences, queryExhaustedSequences, readClaimedSequences, buildExhaustedSequenceFlip } =
  await import("~/lib/cron/recovery-tick");
const { LIVE_SENDS_DISABLED_ERROR } = await import("~/lib/email/dispatch");

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

/** One executed step, so the payment counts as a started-and-finished sequence. */
function seedExecutedStep(paymentId = FP, id = "s1"): void {
  sqlite
    .prepare(
      "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count, executed_at, result) VALUES (?, ?, ?, 'email_day1', 1, 1000, 1, 2000, 'sent')",
    )
    .run(id, ACCOUNT, paymentId);
}

function sendRows() {
  return sqlite
    .prepare("SELECT status, template, error FROM email_sends WHERE account_id = ?")
    .all(ACCOUNT) as { status: string; template: string | null; error: string | null }[];
}

describe("PLANT 1: an exhausted sequence sends one email with legacy's strings", () => {
  it("toggle NULL sends, to the notification email, with legacy's subject", async () => {
    seedAccount({ enabled: null });
    seedPayment({});

    const result = await sendSequenceCompleteNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });

    expect(result.kind).toBe("sent");
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].to).toBe("ops@acme.test");
    expect(harness.sent[0].subject).toBe(
      "Recovery sequence ended: $99.00 from Jane Buyer was not recovered",
    );
    expect(harness.sent[0].from).toBe("Foxhound <recovery@send.foxhoundapp.com>");
    expect(sendRows()).toHaveLength(1);
    expect(sendRows()[0].template).toBe(SEQUENCE_COMPLETE_TEMPLATE);
  });

  it("the body carries legacy's wording and the payment link", async () => {
    seedAccount({ enabled: null });
    seedPayment({});
    await sendSequenceCompleteNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    const html = harness.sent[0].html;
    expect(html).toContain("<strong>Recovery sequence complete.</strong>");
    expect(html).toContain("The recovery sequence for Jane Buyer ($99.00) has ended without a");
    expect(html).toContain("manually reach out or write off this balance");
    expect(html).toContain(`https://foxhoundapp.test/recovery/payments/${FP}`);
  });

  it("does NOT claim seven days, because no schedule runs seven days", () => {
    // Legacy says "The 7-day recovery sequence" while its own schedules plan
    // out to email_day30. Class (c) truthfulness.
    const body = sequenceCompleteBody({
      amountCents: 9900,
      currency: "usd",
      customerLabel: "X",
      paymentUrl: "https://x/1",
    });
    expect(body).not.toContain("7-day");
    expect(body).not.toContain("7 day");
  });

  it("empty customer name falls back to the email, as legacy's || does", async () => {
    seedAccount({ enabled: null });
    seedPayment({ customerName: "" });
    await sendSequenceCompleteNotification(env, { accountId: ACCOUNT, failedPaymentId: FP });
    expect(harness.sent[0].subject).toContain("from buyer@acme.test");
  });
});

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
  it("an account without live sends is blocked, and the block is logged", async () => {
    seedAccount({ enabled: null, liveSends: 0 });
    seedPayment({});
    const result = await sendSequenceCompleteNotification(env, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });
    expect(result.kind === "sent" && result.result.status).toBe("blocked");
    expect(harness.sent).toHaveLength(0);
    expect(sendRows()[0].error).toBe(LIVE_SENDS_DISABLED_ERROR);
  });

  it("a send failure leaves the terminal state recorded", async () => {
    seedAccount({ enabled: null });
    seedPayment({ status: "failed_unrecovered" });
    const failing = {
      ...env,
      EMAIL: { send: async () => { throw new Error("provider exploded"); } },
    } as unknown as Env;

    const result = await sendSequenceCompleteNotification(failing, {
      accountId: ACCOUNT,
      failedPaymentId: FP,
    });

    expect(result.kind === "sent" && result.result.status).toBe("failed");
    const fp = sqlite.prepare("SELECT status FROM failed_payments WHERE id = ?").get(FP) as {
      status: string;
    };
    expect(fp.status).toBe("failed_unrecovered");
  });

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

describe("PLANT 4: the claim, and the mutual exclusion with the recovery notice", () => {
  it("the flip reports exactly the sequences it claimed, and a re-run claims none", async () => {
    seedAccount({ enabled: null });
    seedPayment({});
    seedExecutedStep();
    const now = new Date(5_000_000);

    const first = await flipExhaustedSequences(env, now);
    expect(first).toEqual([{ failedPaymentId: FP, accountId: ACCOUNT }]);

    // A SECOND TICK over the same data claims nothing: the flip is conditional
    // on status='active' and the row is no longer active. This is what stops a
    // re-run sending a second email.
    const second = await flipExhaustedSequences(env, new Date(6_000_000));
    expect(second).toEqual([]);
    expect(await queryExhaustedSequences(env, 10)).toEqual([]);
  });

  it("A RECOVERED SEQUENCE IS NEVER A CANDIDATE, so it gets the other notice only", async () => {
    // The mutual exclusion, at its source. queryExhaustedSequences selects
    // status='active' only, so a payment the webhook already flipped to
    // 'recovered' can never reach this notification.
    seedAccount({ enabled: null });
    seedPayment({ status: "recovered" });
    seedExecutedStep();

    expect(await queryExhaustedSequences(env, 10)).toEqual([]);
    expect(await flipExhaustedSequences(env, new Date(5_000_000))).toEqual([]);
    expect(harness.sent).toHaveLength(0);
  });

  it("a sequence with a step still pending is not exhausted", async () => {
    seedAccount({ enabled: null });
    seedPayment({});
    seedExecutedStep(FP, "s1");
    sqlite
      .prepare(
        "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count) VALUES ('s2', ?, ?, 'email_day3', 2, 9000, 0)",
      )
      .run(ACCOUNT, FP);

    expect(await flipExhaustedSequences(env, new Date(5_000_000))).toEqual([]);
  });
});

describe("PLANT 5: the tick hooks the notification on the claim", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/lib/cron/recovery-tick.ts", import.meta.url)),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("it iterates what the flip CLAIMED, not what it considered", () => {
    expect(code).toContain("const claimed = await flipExhausted(env, now);");
    expect(code).toContain("for (const sequence of claimed) {");
    expect(code).toContain("await sendSequenceCompleteNotification(env, sequence);");
  });

  it("the notification runs AFTER the flip, never inside the batch", () => {
    const flipIdx = code.indexOf("const claimed = await flipExhausted");
    const sendIdx = code.indexOf("sendSequenceCompleteNotification(env, sequence)");
    expect(flipIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(flipIdx);
    expect(code).not.toContain("buildExhaustedSequenceFlip(db, ids, now), sendSequence");
  });

  it("the notification module writes nothing and records no outcome", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/lib/recovery/sequence-complete-notification.server.ts", import.meta.url)),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("recordOutcome");
    expect(src).not.toContain("executeMoneyWrite");
    expect(src).not.toContain("db.insert");
    expect(src).not.toContain("db.update");
  });

  it("no wide dash in the user-facing strings", () => {
    const wide = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
    expect(
      sequenceCompleteSubject({ amountCents: 9900, currency: "usd", customerLabel: "X" }),
    ).not.toMatch(wide);
    expect(
      sequenceCompleteBody({ amountCents: 9900, currency: "usd", customerLabel: "X", paymentUrl: "https://x/1" }),
    ).not.toMatch(wide);
  });
});

describe("PLANT 6: the docs describe the notice and its exclusivity", () => {
  const DOCS = readFileSync(
    fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
    "utf8",
  );
  const section = DOCS.slice(DOCS.indexOf('heading: "Notifications"'), DOCS.indexOf('heading: "Alerts"'));

  it("says what ends a sequence and that the two notices never both fire", () => {
    // Line for the heading map: platform, "Notifications", body[1].
    expect(section).toContain("runs out of steps without the payment coming back");
    expect(section).toContain("you never get both for one payment");
  });

  it("no longer lists the sequence-complete notice as unbuilt", () => {
    expect(section).not.toContain("the sequence-complete notice are not built");
    // Session 55 built the digest, so SLACK is the only one still unbuilt and
    // the line names it alone. The digest must no longer be listed as unbuilt.
    expect(section).toContain("Slack delivery is not built yet.");
    expect(section).not.toContain("The weekly digest and Slack delivery are not built yet.");
  });
});

describe("PLANT 7: the two layers of the claim, each proven on its own", () => {
  // Inside flipExhaustedSequences the query and the flip run back to back on
  // one thread, so every candidate is claimed and neither layer is observable
  // through the public function. Reached directly, both are.

  it("THE FLIP IS A CLAIM: an already-terminal row is not re-stamped", async () => {
    seedAccount({ enabled: null });
    seedPayment({ id: "fp_done", status: "failed_unrecovered" });
    sqlite.prepare("UPDATE failed_payments SET resolved_at = 1234 WHERE id = 'fp_done'").run();

    // Its id is handed to the flip anyway, which is what a concurrent tick
    // would do. The `status = 'active'` guard is the only thing refusing it.
    await db.batch([buildExhaustedSequenceFlip(db, ["fp_done"], new Date(9_999_999))]);

    const row = sqlite
      .prepare("SELECT resolved_at AS r FROM failed_payments WHERE id = 'fp_done'")
      .get() as { r: number };
    expect(row.r).toBe(1234);
  });

  it("THE READ-BACK NARROWS: a candidate this flip did not claim is excluded", async () => {
    seedAccount({ enabled: null });
    seedPayment({ id: "fp_mine" });
    seedPayment({ id: "fp_theirs" });
    const now = new Date(5_000_000);

    // fp_mine is claimed by THIS flip; fp_theirs was already terminal, stamped
    // by another tick at a different time. Both are in the candidate list.
    sqlite
      .prepare("UPDATE failed_payments SET status = 'failed_unrecovered', resolved_at = 4000 WHERE id = 'fp_theirs'")
      .run();
    await db.batch([buildExhaustedSequenceFlip(db, ["fp_mine", "fp_theirs"], now)]);

    const claimed = await readClaimedSequences(db, ["fp_mine", "fp_theirs"], now);

    expect(claimed).toEqual([{ failedPaymentId: "fp_mine", accountId: ACCOUNT }]);
  });

  it("a row terminal at a DIFFERENT time is excluded even with the same status", async () => {
    seedAccount({ enabled: null });
    seedPayment({ id: "fp_old", status: "failed_unrecovered" });
    sqlite.prepare("UPDATE failed_payments SET resolved_at = 4000 WHERE id = 'fp_old'").run();

    expect(await readClaimedSequences(db, ["fp_old"], new Date(5_000_000))).toEqual([]);
    // And it IS found at its own timestamp, so the filter is the timestamp and
    // not something incidental.
    expect(await readClaimedSequences(db, ["fp_old"], new Date(4000))).toHaveLength(1);
  });
});
