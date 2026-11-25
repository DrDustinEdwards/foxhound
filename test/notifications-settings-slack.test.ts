import type Database from "better-sqlite3";
import { encryptToken } from "~/lib/stripe/encryption";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The Slack sender: webhook host validation, the gate before a post, and failures that never throw.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  posted: [] as { url: string; body: unknown }[],
  response: { ok: true, status: 200 } as { ok: boolean; status: number },
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { buildSlackPayload, postToSlack, postSlackNotification } =
  await import("~/lib/notify/slack.server");
const { normalizeSlackWebhookUrl, SLACK_WEBHOOK_ERROR } =
  await import("~/lib/settings/slack-webhook");
const { buildNotificationSettingsUpdate } = await import("~/lib/settings/persist.server");

const ACCOUNT = "acct_1";
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

async function save(input: Record<string, unknown>): Promise<void> {
  await buildNotificationSettingsUpdate(db, ACCOUNT, {
    notificationEmail: "owner@acme.test",
    slackNotificationsEnabled: false,
    digestEnabled: false,
    recoveryNotificationsEnabled: true,
    sequenceCompleteNotificationsEnabled: true,
    ...input,
    // The column holds the URL sealed, as applyNotificationSettings writes it.
    slackWebhookUrl:
      typeof input.slackWebhookUrl === "string"
        ? await encryptToken(env, input.slackWebhookUrl)
        : null,
  } as never);
}

describe("the Slack webhook URL is validated to hooks.slack.com", () => {
  it("rejects another host", () => {
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

describe("the gate refuses before anything is posted", () => {
  const event = {
    type: "email_sent" as const,
    stepType: "email_day1",
    customerEmail: "b@a.test",
    customerName: "Jane",
    amount: "$10.00",
  };

  it("an untouched account posts nothing", async () => {
    expect(await postSlackNotification(env, ACCOUNT, event)).toEqual({ status: "disabled" });
    expect(harness.posted).toEqual([]);
  });

  it("enabled with NO webhook posts nothing", async () => {
    await save({ slackNotificationsEnabled: true });
    expect(await postSlackNotification(env, ACCOUNT, event)).toEqual({ status: "no_webhook" });
    expect(harness.posted).toEqual([]);
  });

  it("a demo account refuses before the account is read", async () => {
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

describe("a Slack failure is recorded and never thrown", () => {
  const event = {
    type: "payment_recovered" as const,
    stepType: "retry",
    customerEmail: "b@a.test",
    customerName: "Jane",
    amount: "$10.00",
  };

  it("a 500 returns a failure", async () => {
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
    expect(await postToSlack("https://hooks.slack.com/services/x", event)).toEqual({
      status: "failed",
      reason: "http_302",
    });
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
    expect(await postToSlack("https://internal.example/x", event)).toEqual({
      status: "failed",
      reason: "host_not_allowed",
    });
    expect(harness.posted).toEqual([]);
  });

  it("a THROWN fetch is caught and named, never rethrown", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;

    await expect(postToSlack("https://hooks.slack.com/services/x", event)).resolves.toEqual({
      status: "failed",
      reason: "threw",
    });
  });

  it("a Slack host that never answers cannot hold the caller: the post carries a timeout", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    await postToSlack("https://hooks.slack.com/services/x", event);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
