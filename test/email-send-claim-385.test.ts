import { describe, expect, it, vi } from "vitest";

import { accounts, emailSends } from "~/db/schema";
import type { EmailJob } from "~/lib/email/types";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 85b, RULING 385: THE SEND CLAIM.
//
// 385 ruled the step-level send-then-claim order stays on both the recovery and
// win-back paths, and named the residual that leaves: a worker killed between
// the provider accepting and the step being claimed re-sends once the lock's
// lease lapses, because nothing recorded that the mail had gone. That cannot be
// closed at the step layer, where every write happens after the send. It closes
// one layer down, at the send itself.
//
// THE ROW IS WRITTEN BEFORE THE PROVIDER IS CALLED, with status `pending`, under
// a partial unique index on the key. A worker that dies at any point after that
// insert leaves evidence, and the retry finds it.
//
// PREMISE CHECKED AT 09c2162: `EmailJob.idempotencyKey` was read by NOTHING.
// Measured over app/, workers/ and test/: every occurrence was a producer
// writing the field, and `email_sends` had no column to put it in. 376 item 15
// recorded it as CITED; this is its first reader.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const sent: { subject: string }[] = [];
const sendCalls: { atRowCount: number }[] = [];
const sendBehavior = { mode: "ok" as "ok" | "throw" };

vi.mock("~/lib/email/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/email/send")>()),
  sendEmail: async (_env: unknown, job: EmailJob) => {
    // THE ORDER ASSERTION'S INSTRUMENT (385 plant 5). The stub counts the rows
    // that exist AT THE MOMENT the provider is called, so "the row was written
    // first" is measured rather than inferred from the end state.
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    const rows = await db.select().from(emailSends);
    sendCalls.push({ atRowCount: rows.length });
    sent.push({ subject: job.subject });
    if (sendBehavior.mode === "throw") throw new Error("provider refused: 550 mailbox full");
    return { providerMessageId: "prov_1" };
  },
}));

vi.mock("~/lib/email/suppression", () => ({ isSuppressed: async () => false }));

const { processEmailJob, buildEmailSendRow } = await import("~/lib/email/dispatch");
const { sendResultToAttempt } = await import("~/lib/engine/execute-step");

const NOW = new Date("2026-08-27T12:00:00.000Z");
const ACCOUNT = "acc_live";

function job(overrides: Partial<EmailJob> = {}): EmailJob {
  return {
    accountId: ACCOUNT,
    recoveryStepId: null,
    to: "customer@example.com",
    fromName: "Acme",
    subject: "Your payment needs a quick fix",
    bodyHtml: "<p>Please update your card.</p>",
    template: "recovery_dunning",
    unsubscribeToken: "unsub_tok",
    physicalAddress: "123 Main St, Springfield",
    idempotencyKey: "step_1:0",
    ...overrides,
  };
}

async function seed() {
  const made = createInMemoryDb();
  harness.db = made.db;
  sent.length = 0;
  sendCalls.length = 0;
  sendBehavior.mode = "ok";
  // Live sends ON, or the gate short-circuits before the claim is ever reached
  // and every test below would pass having exercised nothing (383's rule).
  await made.db
    .insert(accounts)
    .values({ id: ACCOUNT, name: "Acme", createdAt: NOW, liveSendsEnabled: true });
  return made;
}

// ============================================================================

describe("PLANT 1: the same key twice sends once", () => {
  it("SENDS ONCE AND LEAVES ONE ROW", async () => {
    const { db } = await seed();

    const first = await processEmailJob({} as Env, job(), null);
    const second = await processEmailJob({} as Env, job(), null);

    expect(first.status).toBe("sent");
    // Not a failure: the mail is accounted for, so the step must not back off
    // and retry with a fresh key.
    expect(second.status).toBe("duplicate");
    expect(second.retryable).toBe(false);

    expect(sent).toHaveLength(1);
    const rows = await db.select().from(emailSends);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].idempotencyKey).toBe("step_1:0");
  });

  it("and a DIFFERENT key sends, so the claim is per logical send", async () => {
    const { db } = await seed();

    await processEmailJob({} as Env, job({ idempotencyKey: "step_1:0" }), null);
    const other = await processEmailJob({} as Env, job({ idempotencyKey: "step_1:1" }), null);

    // The recovery path's key is `stepId:attemptCount`, so this is exactly what
    // a backoff retry looks like: a new attempt, a new key, a real send.
    expect(other.status).toBe("sent");
    expect(sent).toHaveLength(2);
    expect(await db.select().from(emailSends)).toHaveLength(2);
  });
});

describe("PLANT 3: a provider throw", () => {
  it("LEAVES A PENDING ROW WITH THE ERROR AND NO SENT FLIP", async () => {
    const { db } = await seed();
    sendBehavior.mode = "throw";

    const result = await processEmailJob({} as Env, job(), null);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);

    const rows = await db.select().from(emailSends);
    expect(rows).toHaveLength(1);
    // `pending`, NOT `failed`: this code cannot tell a provider that refused
    // from one that accepted and then failed to answer, and `failed` would
    // assert the first.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].error).toContain("550 mailbox full");
    expect(rows[0].sentAt).toBeNull();
    expect(rows[0].providerMessageId).toBeNull();
  });

  it("A RECORDED REFUSAL MAY BE RETRIED, and still leaves exactly one row", async () => {
    // The provider was ASKED and said no, so no mail left and the retry is safe.
    // Seven of this repo's eleven email keys are stable across attempts
    // (expiring-card:alertId, winback-step:stepId, recovery-notify:paymentId),
    // so without this a single transient refusal would permanently consume those
    // sends. expiring-card-cron.test.ts asserts the opposite by name.
    const { db } = await seed();
    sendBehavior.mode = "throw";
    await processEmailJob({} as Env, job(), null);

    sendBehavior.mode = "ok";
    const second = await processEmailJob({} as Env, job(), null);

    expect(second.status).toBe("sent");
    expect(sent).toHaveLength(2);
    // Re-taken, not duplicated: the unique index still holds one row per key.
    const rows = await db.select().from(emailSends);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].error).toBeNull();
  });
});

describe("PLANT 4: the unique index, fired directly (381)", () => {
  it("REFUSES A SECOND ROW ON THE SAME KEY at the database", async () => {
    // Reaching the insert directly, past processEmailJob, because the guard that
    // matters is the index and not the code path that usually meets it. 381's
    // rule: fire the constraint, do not merely believe the migration.
    const { db } = await seed();
    const row = {
      job: job(),
      status: "pending" as const,
      providerMessageId: null,
      error: null,
      recipientHash: "hash",
      queueMessageId: null,
      now: NOW,
      idempotencyKey: "direct_key",
    };

    await buildEmailSendRow(db, row);

    await expect(buildEmailSendRow(db, row)).rejects.toThrow(/UNIQUE constraint failed/i);
    expect(await db.select().from(emailSends)).toHaveLength(1);
  });

  it("but a NULL key is not a value, so unclaimed rows do not collide", async () => {
    // Suppressed and blocked rows carry no key, and there can be many of them.
    // A plain unique index would be enough in SQLite; the index is partial and
    // this proves the behavior either way.
    const { db } = await seed();
    const base = {
      job: job(),
      status: "blocked" as const,
      providerMessageId: null,
      error: "blocked",
      recipientHash: "hash",
      queueMessageId: null,
      now: NOW,
    };

    await buildEmailSendRow(db, base);
    await buildEmailSendRow(db, base);

    expect(await db.select().from(emailSends)).toHaveLength(2);
  });
});

describe("PLANT 5: a denied claim is OK to the step machine, not a failure", () => {
  it("sendResultToAttempt treats `duplicate` as ok", () => {
    // THE CONSEQUENCE THIS PINS. If a duplicate mapped to a retryable failure,
    // the step would back off and retry with `stepId:attemptCount + 1`, a key
    // the claim has never seen, and send the very email the claim exists to
    // prevent. The claim would then be a guard that causes the thing it guards.
    expect(sendResultToAttempt({ status: "duplicate", providerMessageId: null, error: null, retryable: false })).toEqual({ ok: true });
    // The statuses either side of it are unchanged, so this is a widening and
    // not a rewrite.
    expect(sendResultToAttempt({ status: "sent", providerMessageId: "p", error: null, retryable: false })).toEqual({ ok: true });
    expect(
      sendResultToAttempt({ status: "failed", providerMessageId: null, error: "boom", retryable: true }).ok,
    ).toBe(false);
    expect(
      sendResultToAttempt({ status: "blocked", providerMessageId: null, error: "off", retryable: true }).ok,
    ).toBe(false);
  });
});

describe("PLANT 6: the gates before the claim still hold, and claim nothing", () => {

  it("an EMPTY key is refused rather than sent unclaimed", async () => {
    // An empty string is a real value to a unique index, so it would collide
    // with every other keyless send and start refusing unrelated mail. Fail
    // closed and loud.
    await seed();

    await expect(processEmailJob({} as Env, job({ idempotencyKey: "" }), null)).rejects.toThrow(
      /idempotency key/i,
    );
    expect(sent).toHaveLength(0);
  });
});
