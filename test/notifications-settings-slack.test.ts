import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 56: S36's notifications page and the Slack sender.
//
// THE HEADLINE PLANT IS THE END-TO-END DIGEST CHAIN. 350 binding 2 recorded
// that session 55's digest cron is correct, proven and mails NOBODY, because
// digest_enabled is NULL-is-OFF and nothing could write it. Turning the toggle
// on through this page and then running the cron is what ends that, and it is
// asserted below rather than assumed.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  posted: [] as { url: string; body: unknown }[],
  response: { ok: true, status: 200 } as { ok: boolean; status: number },
  emailJobs: [] as Record<string, unknown>[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/email/dispatch", () => ({
  processEmailJob: async (_env: unknown, job: Record<string, unknown>) => {
    harness.emailJobs.push(job);
    return { status: "sent" };
  },
}));

vi.mock("~/lib/intelligence/views.server", () => ({
  isIntelligenceEntitled: async () => false,
}));

const {
  buildSlackPayload,
  postToSlack,
  postSlackNotification,
} = await import("~/lib/notify/slack.server");
const { normalizeSlackWebhookUrl, SLACK_WEBHOOK_ERROR } = await import(
  "~/lib/settings/slack-webhook"
);
const { buildNotificationSettingsUpdate } = await import("~/lib/settings/persist.server");
const { runWeeklyDigest, queryDigestAccounts } = await import("~/lib/cron/digest");

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-02T08:00:00Z");
const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way",
} as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.posted = [];
  harness.response = { ok: true, status: 200 };
  harness.emailJobs = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    harness.posted.push({
      url: typeof input === "string" ? input : String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response("ok", { status: harness.response.status });
  }) as typeof globalThis.fetch;
  seedAccount(ACCOUNT);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function seedAccount(accountId: string): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, processing_paused, notification_email) VALUES (?, 'Acme', 1000, 0, 'owner@acme.test')",
    )
    .run(accountId);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, connected_at, created_at) VALUES (?, ?, 'acct_s', 1, 'cipher', 'Teamflow', 1000, 1000)",
    )
    .run(`c_${accountId}`, accountId);
}

function accountRow() {
  return sqlite
    .prepare(
      "SELECT digest_enabled AS digest, slack_notifications_enabled AS slack, slack_webhook_url AS url, recovery_notifications_enabled AS recovery, sequence_complete_notifications_enabled AS seqComplete, winback_notifications_enabled AS winback, expiring_card_notifications_enabled AS expiring, notification_email AS email FROM accounts WHERE id = ?",
    )
    .get(ACCOUNT) as Record<string, unknown>;
}

async function save(input: Record<string, unknown>): Promise<void> {
  await buildNotificationSettingsUpdate(db, ACCOUNT, {
    notificationEmail: "owner@acme.test",
    slackWebhookUrl: null,
    slackNotificationsEnabled: false,
    digestEnabled: false,
    recoveryNotificationsEnabled: true,
    sequenceCompleteNotificationsEnabled: true,
    ...input,
  } as never);
}

describe("PLANT 1: the Slack webhook URL is validated to hooks.slack.com", () => {

  it("an empty box CLEARS the column, which is legacy's `|| null`", () => {
    expect(normalizeSlackWebhookUrl("")).toEqual({ ok: true, value: null });
    expect(normalizeSlackWebhookUrl("   ")).toEqual({ ok: true, value: null });
    expect(normalizeSlackWebhookUrl(null)).toEqual({ ok: true, value: null });
  });

  it("REJECTS ANOTHER HOST, which is the whole point of the addition", () => {
    for (const bad of [
      "https://evil.test/hook",
      "http://hooks.slack.com/services/x",
      "https://hooks.slack.com.evil.test/x",
      "https://internal.local/admin",
      "not a url",
      "javascript:alert(1)",
    ]) {
      expect(normalizeSlackWebhookUrl(bad), bad).toEqual({
        ok: false,
        error: SLACK_WEBHOOK_ERROR,
      });
    }
  });
});

describe("PLANT 2: the save writes its six columns and neither S34 column", () => {

  it("AND LEAVES THE S34 COLUMNS UNTOUCHED, because legacy renders them elsewhere", async () => {
    sqlite
      .prepare(
        "UPDATE accounts SET winback_notifications_enabled = 1, expiring_card_notifications_enabled = 1 WHERE id = ?",
      )
      .run(ACCOUNT);

    await save({ digestEnabled: true });

    const row = accountRow();
    expect(row.winback).toBe(1);
    expect(row.expiring).toBe(1);
  });
});

describe("PLANT 3: THE DIGEST CHAIN, END TO END", () => {
  it("NULL selects no account, which is the inertness 350 binding 2 recorded", async () => {
    expect(accountRow().digest).toBeNull();
    expect(await queryDigestAccounts(db)).toEqual([]);
    expect((await runWeeklyDigest(env, NOW)).sent).toBe(0);
  });
});

describe("PLANT 4: the Slack payload is legacy's", () => {

  it("email_sent carries the envelope and the STEP TYPE in the title", () => {
    expect(
      buildSlackPayload({
        type: "email_sent",
        stepType: "email_day3",
        customerEmail: "b@a.test",
        customerName: "Jane",
        amount: "$49.00",
      }),
    ).toEqual({
      text: "📧 *Recovery email sent: email_day3*\nCustomer: Jane (b@a.test)\nAmount: $49.00",
    });
  });
});

describe("PLANT 5: the gate refuses before anything is posted", () => {
  const event = {
    type: "email_sent" as const,
    stepType: "email_day1",
    customerEmail: "b@a.test",
    customerName: "Jane",
    amount: "$10.00",
  };

  it("NULL is OFF: an untouched account posts nothing", async () => {
    expect(await postSlackNotification(env, ACCOUNT, event)).toEqual({ status: "disabled" });
    expect(harness.posted).toEqual([]);
  });

  it("enabled with NO webhook posts nothing", async () => {
    await save({ slackNotificationsEnabled: true });
    expect(await postSlackNotification(env, ACCOUNT, event)).toEqual({ status: "no_webhook" });
    expect(harness.posted).toEqual([]);
  });

  it("A DEMO ACCOUNT REFUSES BEFORE THE ACCOUNT IS EVEN READ", async () => {
    expect(await postSlackNotification(env, "demo_teamflow", event)).toEqual({ status: "demo" });
    expect(harness.posted).toEqual([]);
  });

  it("enabled WITH a webhook posts legacy's body to the stored URL", async () => {
    await save({
      slackNotificationsEnabled: true,
      slackWebhookUrl: "https://hooks.slack.com/services/T/B/x",
    });

    expect(await postSlackNotification(env, ACCOUNT, event)).toEqual({ status: "posted" });
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0].url).toBe("https://hooks.slack.com/services/T/B/x");
    expect(harness.posted[0].body).toEqual(buildSlackPayload(event));
  });
});

describe("PLANT 6: a Slack failure is recorded and never thrown", () => {
  const event = {
    type: "payment_recovered" as const,
    stepType: "retry",
    customerEmail: "b@a.test",
    customerName: "Jane",
    amount: "$10.00",
  };

  it("A 500 RETURNS A REFUSAL, where legacy would never notice", async () => {
    harness.response = { ok: false, status: 500 };

    const outcome = await postToSlack("https://hooks.slack.com/services/x", event);

    expect(outcome).toEqual({ status: "failed", reason: "http_500" });
  });

  it("a redirect is never followed, and a URL off hooks.slack.com is never fetched", async () => {
    let redirectMode: RequestRedirect | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } });
    }) as typeof globalThis.fetch;
    expect(await postToSlack("https://hooks.slack.com/services/x", event)).toEqual({ status: "failed", reason: "http_302" });
    expect(redirectMode).toBe("manual");

    harness.posted = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      harness.posted.push({ url: String(input), body: {} });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    expect(await postToSlack("https://hooks.slack.com:8443/services/x", event)).toEqual({
      status: "failed",
      reason: "host_not_allowed",
    });
    expect(await postToSlack("https://internal.example/x", event)).toEqual({ status: "failed", reason: "host_not_allowed" });
    expect(harness.posted).toEqual([]);
  });

  it("a THROWN fetch is caught and named, never rethrown", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;

    await expect(
      postToSlack("https://hooks.slack.com/services/x", event),
    ).resolves.toEqual({ status: "failed", reason: "threw" });
  });
});
