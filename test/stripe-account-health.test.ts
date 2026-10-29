import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// account.updated: the connected Stripe account's own health. Stored per
// connection, the merchant told once when a problem appears, and retry steps
// held while Stripe has charges off.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  mail: [] as { to: string; subject: string; idempotencyKey: string }[],
  slack: [] as string[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    const batch = write.build(harness.db);
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
    return { applied: true };
  },
}));

vi.mock("~/lib/email/dispatch", () => ({
  processEmailJob: async (_env: Env, job: { to: string; subject: string; idempotencyKey: string }) => {
    harness.mail.push({ to: job.to, subject: job.subject, idempotencyKey: job.idempotencyKey });
    return { status: "sent", providerMessageId: "m", error: null, retryable: false };
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { runRecoveryTick } = await import("~/lib/cron/recovery-tick");

const env = {} as Env;
let sqlite: Database.Database;

beforeEach(() => {
  let db;
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.mail = [];
  harness.slack = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    harness.slack.push((JSON.parse(init.body) as { text: string }).text);
    return new Response("ok");
  });
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, notification_email, slack_notifications_enabled, slack_webhook_url, created_at) VALUES ('a1', 'Acme', 'ops@acme.test', 1, 'https://hooks.slack.com/services/x', 1000)",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, name, is_primary, connected_at, created_at) VALUES ('c1', 'a1', 'acct_s', 'Acme Inc', 1, 1000, 1000)",
    )
    .run();
});

function accountEvent(id: string, created: number, account: Record<string, unknown>) {
  return {
    id,
    type: "account.updated",
    account: "acct_s",
    created,
    data: { object: { id: "acct_s", object: "account", ...account } },
  } as never;
}

function health() {
  return sqlite
    .prepare(
      "SELECT charges_enabled AS charges, payouts_enabled AS payouts, disabled_reason AS reason, past_due_count AS pastDue FROM stripe_connections WHERE id = 'c1'",
    )
    .get();
}

describe("account.updated stores the health and tells the merchant once per new problem", () => {
  it("notifies when charges turn off, not again while they stay off, and ignores a late older event", async () => {
    const received = new Date("2026-11-01T00:00:00Z");
    const off = {
      charges_enabled: false,
      payouts_enabled: true,
      requirements: { past_due: ["individual.verification.document"], disabled_reason: "requirements.past_due", current_deadline: null },
    };

    expect(await processConnectedWebhook(env, accountEvent("evt_1", 2000, off), received)).toEqual({ status: "applied" });
    expect(health()).toEqual({ charges: 0, payouts: 1, reason: "requirements.past_due", pastDue: 1 });
    expect(harness.mail).toHaveLength(1);
    expect(harness.mail[0]).toMatchObject({ to: "ops@acme.test" });
    expect(harness.mail[0].subject).toContain("turned off charges");
    expect(harness.slack).toHaveLength(1);
    expect(harness.slack[0]).toContain("every payment retry Foxhound makes will fail");

    // Still off: stored, no second notice.
    await processConnectedWebhook(env, accountEvent("evt_2", 3000, off), received);
    expect(harness.mail).toHaveLength(1);

    // An older event delivered late does not overwrite the newer state.
    const older = { charges_enabled: true, payouts_enabled: true, requirements: { past_due: [] } };
    expect(await processConnectedWebhook(env, accountEvent("evt_0", 1500, older), received)).toEqual({
      status: "ignored",
      reason: "stale_account_event",
    });
    expect(health()).toMatchObject({ charges: 0 });
  });
});

describe("the recovery tick holds retry steps while Stripe has charges off", () => {
  it("leaves the retry pending without charging or recording an attempt", async () => {
    const runRetry = vi.fn(async () => ({ recovered: false }));
    const recordMissingToken = vi.fn(async () => null);
    const result = await runRecoveryTick(env, {
      query: async () => [
        {
          stepId: "s1",
          stepType: "retry_1",
          stepNumber: 1,
          accountId: "a1",
          failedPaymentId: "fp_1",
          scheduledAt: new Date("2026-07-01T00:00:00Z"),
          nextRetryAt: null,
          attemptCount: 0,
          customBody: null,
          aiSubject: null,
          aiBodyHtml: null,
          invoiceId: "in_1",
          amountCents: 4200,
          currency: "usd",
          customerEmail: "c@example.com",
          customerName: null,
          declineCategory: "soft",
          connectionAccessToken: "iv:cipher",
          merchantName: null,
          brandVoice: null,
          merchantIndustry: null,
          primaryCustomerType: null,
          merchantMrrCents: null,
          brandVoiceSoft: null,
          brandVoiceExpired: null,
          brandVoiceNetwork: null,
          brandVoiceFraud: null,
          chargesEnabled: false,
        },
      ],
      runRetry,
      recordMissingToken,
      checkGuards: async () => ({ tickEnabled: true, accountEligible: true }),
      flipExhausted: async () => [],
    });
    expect(runRetry).not.toHaveBeenCalled();
    expect(recordMissingToken).not.toHaveBeenCalled();
    expect(result.message).toContain("1 retries held (Stripe charges off)");
  });
});
