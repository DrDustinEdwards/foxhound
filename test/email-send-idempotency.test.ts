import { describe, expect, it, vi } from "vitest";

import { accounts, emailSends } from "~/db/schema";
import type { EmailJob } from "~/lib/email/types";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The send claim: an email_sends row is written as `pending` under a partial unique index on the
// idempotency key BEFORE the provider is called, so a worker killed after the provider accepted
// leaves evidence and its retry finds it instead of sending the mail twice.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const sent: { subject: string }[] = [];
const sendBehavior = { mode: "ok" as "ok" | "throw" };

vi.mock("~/lib/email/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/email/send")>()),
  sendJobEmail: async (_env: unknown, job: EmailJob) => {
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
  sendBehavior.mode = "ok";
  // Live sends ON, or the gate short-circuits before the claim and the cases below test nothing.
  await made.db
    .insert(accounts)
    .values({ id: ACCOUNT, name: "Acme", createdAt: NOW, liveSendsEnabled: true });
  return made;
}

describe("the same key twice sends once", () => {
  it("sends once and leaves one row, while a different key still sends", async () => {
    const { db } = await seed();

    const first = await processEmailJob({} as Env, job(), null);
    const second = await processEmailJob({} as Env, job(), null);

    expect(first.status).toBe("sent");
    // Not a failure: the mail is accounted for, so the step must not retry with a fresh key.
    expect(second.status).toBe("duplicate");
    expect(second.retryable).toBe(false);
    expect(sent).toHaveLength(1);
    expect(await db.select().from(emailSends)).toHaveLength(1);

    // A backoff retry uses a new key (`stepId:attemptCount`) and is a real send.
    const other = await processEmailJob({} as Env, job({ idempotencyKey: "step_1:1" }), null);
    expect(other.status).toBe("sent");
    expect(sent).toHaveLength(2);
  });
});

describe("a provider throw", () => {
  it("leaves a pending row with the error and no sent flip", async () => {
    const { db } = await seed();
    sendBehavior.mode = "throw";

    const result = await processEmailJob({} as Env, job(), null);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
    const rows = await db.select().from(emailSends);
    expect(rows).toHaveLength(1);
    // `pending`, not `failed`: a provider that refused cannot be told from one that accepted and
    // then failed to answer.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].error).toContain("550 mailbox full");
    expect(rows[0].sentAt).toBeNull();
  });

  it("a recorded refusal may be retried, and still leaves exactly one row", async () => {
    // Several email keys are stable across attempts (expiring-card:alertId,
    // winback-step:stepId), so without this one transient refusal would consume the send for good.
    const { db } = await seed();
    sendBehavior.mode = "throw";
    await processEmailJob({} as Env, job(), null);

    sendBehavior.mode = "ok";
    const second = await processEmailJob({} as Env, job(), null);

    expect(second.status).toBe("sent");
    const rows = await db.select().from(emailSends);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].error).toBeNull();
  });
});

describe("the claim's guards", () => {
  it("the unique index refuses a second row on the same key, past processEmailJob", async () => {
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

  it("a denied claim is ok to the step machine, so it never retries under a fresh key", () => {
    expect(
      sendResultToAttempt({
        status: "duplicate",
        providerMessageId: null,
        error: null,
        retryable: false,
      }),
    ).toEqual({ ok: true });
  });

  it("an empty key is refused rather than sent unclaimed", async () => {
    await seed();

    await expect(processEmailJob({} as Env, job({ idempotencyKey: "" }), null)).rejects.toThrow(
      /idempotency key/i,
    );
    expect(sent).toHaveLength(0);
  });
});
