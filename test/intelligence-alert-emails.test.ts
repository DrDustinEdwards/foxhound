import type Database from "better-sqlite3";
import { encryptToken } from "~/lib/stripe/encryption";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Threshold and critical-customers alerts: mails read at env.EMAIL.send, firings read from alert_history.

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

const { evaluateAndRecordAlerts, runAlertsForAllAccounts, runCriticalCustomersCheck } =
  await import("~/lib/intelligence/alert-run.server");
const { evaluateAlerts } = await import("~/lib/intelligence/alerts");

const BASE = "https://foxhound.example.com";
const ACCOUNT = "acct_1";
const ALERT = "alert_1";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/EXAMPLE";
const NOW = new Date("2026-10-16T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: BASE,
  PHYSICAL_ADDRESS: "1 Example Way",
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: "msg_1" };
    },
  },
} as unknown as Env;

const failingBinding = {
  ...env,
  EMAIL: {
    send: async () => {
      throw new Error("provider exploded");
    },
  },
} as unknown as Env;

let sqlite: Database.Database;
let slackPosts: { url: string; body: string }[];

beforeEach(() => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  slackPosts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      slackPosts.push({ url, body: init.body });
      return new Response("ok", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function db() {
  return harness.db as Parameters<typeof evaluateAndRecordAlerts>[1];
}

// The column holds the URL sealed (slack-webhook-secret.server.ts), so the
// seeds are sealed once, up front, under the test key.
const SEALED = new Map(
  await Promise.all(
    [WEBHOOK, "https://internal.example.com/hook"].map(
      async (url) => [url, await encryptToken(env, url)] as const,
    ),
  ),
);

function seedAccount(
  opts: { email?: string | null; slack?: string | null; live?: number } = {},
): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, slack_webhook_url, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?, ?)",
    )
    .run(
      ACCOUNT,
      opts.email === undefined ? "ops@acme.example.com" : opts.email,
      opts.slack ? (SEALED.get(opts.slack) ?? opts.slack) : null,
      opts.live ?? 1,
    );
}

function seedAlert(
  opts: {
    metric?: string;
    direction?: string;
    threshold?: number;
    channel?: string;
    lastTriggeredAt?: number | null;
    enabled?: number;
  } = {},
): void {
  sqlite
    .prepare(
      "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, last_triggered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000)",
    )
    .run(
      ALERT,
      ACCOUNT,
      opts.metric ?? "mrr_at_risk_cents",
      opts.threshold ?? 500_000,
      opts.direction ?? "above",
      opts.channel ?? "email",
      opts.enabled ?? 1,
      opts.lastTriggeredAt === undefined ? null : opts.lastTriggeredAt,
    );
}

function historyRows() {
  return sqlite
    .prepare(
      "SELECT alert_id, metric, threshold_value, direction, actual_value, channel, fired_at, notification_sent FROM alert_history WHERE account_id = ? ORDER BY fired_at",
    )
    .all(ACCOUNT) as {
    alert_id: string | null;
    metric: string;
    threshold_value: number;
    direction: string;
    actual_value: number;
    channel: string;
    fired_at: number;
    notification_sent: number;
  }[];
}

function lastTriggeredAt(): number | null {
  const row = sqlite.prepare("SELECT last_triggered_at FROM alerts WHERE id = ?").get(ALERT) as {
    last_triggered_at: number | null;
  };
  return row.last_triggered_at;
}

describe("a threshold alert fires on a breach outside its cooldown and records notification_sent truly", () => {
  it("no breach: no mail and no row", async () => {
    seedAccount();
    seedAlert();
    await evaluateAndRecordAlerts(env, db(), ACCOUNT, { mrr_at_risk_cents: 400_000 }, NOW);
    expect(harness.sent).toHaveLength(0);
    expect(historyRows()).toHaveLength(0);
  });

  it("the pure evaluator applies the same rule: breach and outside the cooldown", () => {
    const config = {
      id: ALERT,
      accountId: ACCOUNT,
      metric: "mrr_at_risk_cents",
      thresholdValue: 100,
      direction: "above",
      channel: "email",
    };
    const metrics = { mrr_at_risk_cents: 200 };
    expect(
      evaluateAlerts([{ ...config, lastTriggeredAt: null }], metrics, NOW.getTime()),
    ).toHaveLength(1);
    expect(
      evaluateAlerts(
        [{ ...config, lastTriggeredAt: new Date(NOW.getTime() - 22 * HOUR) }],
        metrics,
        NOW.getTime(),
      ),
    ).toHaveLength(0);
    expect(
      evaluateAlerts(
        [{ ...config, lastTriggeredAt: new Date(NOW.getTime() - DAY + 5_000) }],
        metrics,
        NOW.getTime(),
      ),
    ).toHaveLength(1);
    expect(
      evaluateAlerts(
        [{ ...config, lastTriggeredAt: new Date(NOW.getTime() - DAY) }],
        metrics,
        NOW.getTime(),
      ),
    ).toHaveLength(1);
  });

  it("no notification address: no mail, the row is still written with notification_sent 0", async () => {
    seedAccount({ email: null });
    seedAlert();
    await evaluateAndRecordAlerts(env, db(), ACCOUNT, { mrr_at_risk_cents: 712_345 }, NOW);
    expect(harness.sent).toHaveLength(0);
    expect(historyRows().map((r) => r.notification_sent)).toEqual([0]);
    expect(lastTriggeredAt()).toBe(NOW.getTime());
  });

  it("a provider refusal records notification_sent 0, never throws", async () => {
    seedAccount();
    seedAlert();
    await evaluateAndRecordAlerts(
      failingBinding,
      db(),
      ACCOUNT,
      { mrr_at_risk_cents: 712_345 },
      NOW,
    );
    expect(historyRows().map((r) => r.notification_sent)).toEqual([0]);
  });

  it("a slack-channel alert posts to the webhook and sends no mail", async () => {
    seedAccount({ slack: WEBHOOK });
    seedAlert({ channel: "slack" });
    await evaluateAndRecordAlerts(env, db(), ACCOUNT, { mrr_at_risk_cents: 712_345 }, NOW);
    expect(harness.sent).toHaveLength(0);
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0].url).toBe(WEBHOOK);
    expect(slackPosts[0].body).toContain("$7,123.45");
    expect(historyRows().map((r) => [r.channel, r.notification_sent])).toEqual([["slack", 1]]);
  });

  it("a stored webhook on any host but hooks.slack.com is never fetched", async () => {
    seedAccount({ slack: "https://internal.example.com/hook" });
    seedAlert({ channel: "slack" });
    await evaluateAndRecordAlerts(env, db(), ACCOUNT, { mrr_at_risk_cents: 712_345 }, NOW);
    expect(slackPosts).toHaveLength(0);
    expect(historyRows().map((r) => r.notification_sent)).toEqual([0]);
  });

  it("the alerts run computes the recovery rate from the account's own rows and sends it", async () => {
    seedAccount();
    // No failed payments: the recovery rate is 0, below 1.
    sqlite
      .prepare(
        "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES (?, ?, 'recovery_rate_pct', 1, 'below', 'email', 1, 1000)",
      )
      .run(ALERT, ACCOUNT);
    const result = await runAlertsForAllAccounts(env, NOW.getTime());
    expect(result.fired).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].subject).toBe("Foxhound alert: Recovery rate below threshold");
    expect(historyRows().map((r) => r.notification_sent)).toEqual([1]);
  });
});

function seedCritical(
  opts: {
    customers?: string[];
    health?: number;
    disputeState?: string;
    paymentStatus?: string;
    account?: string;
  } = {},
): void {
  const customers = opts.customers ?? ["cus_1"];
  const account = opts.account ?? ACCOUNT;
  const tag = account === ACCOUNT ? "" : `_${account}`;
  customers.forEach((cus, i) => {
    sqlite
      .prepare(
        "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, ?, ?, ?, 'buyer@example.com', 9900, 'usd', 'soft', ?, 1000)",
      )
      .run(
        `fp_${i}${tag}`,
        account,
        `evt_${i}${tag}`,
        `in_${i}${tag}`,
        cus,
        opts.paymentStatus ?? "active",
      );
    sqlite
      .prepare(
        "INSERT INTO customer_context (id, account_id, stripe_customer_id, health_score, currency, created_at, updated_at) VALUES (?, ?, ?, ?, 'usd', 1000, 1000)",
      )
      .run(`cc_${i}${tag}`, account, cus, opts.health ?? 33);
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, amount_cents, currency, reason, status, state, created_at) VALUES (?, ?, ?, ?, ?, 4900, 'usd', 'fraudulent', 'needs_response', ?, 1000)",
      )
      .run(
        `dp_${i}${tag}`,
        account,
        `dp_s_${i}${tag}`,
        `ch_${i}${tag}`,
        cus,
        opts.disputeState ?? "pending_review",
      );
  });
}

describe("the critical customers alert fires on three conditions at once, with a 24h cooldown", () => {
  it("records alert_history cross_product_critical with no alert row behind it", async () => {
    seedAccount();
    seedCritical();
    await runCriticalCustomersCheck(env, db(), ACCOUNT, NOW);
    expect(historyRows()).toEqual([
      {
        alert_id: null,
        metric: "cross_product_critical",
        threshold_value: 0,
        direction: "above",
        actual_value: 1,
        channel: "email",
        fired_at: NOW.getTime(),
        notification_sent: 1,
      },
    ]);
  });

  it.each([{ health: 34 }, { disputeState: "resolved_lost" as const }])(
    "a health score of 34 or a resolved dispute is not critical: %o",
    async (seed) => {
      seedAccount();
      seedCritical(seed);
      expect((await runCriticalCustomersCheck(env, db(), ACCOUNT, NOW)).kind).toBe("skipped");
      expect(harness.sent).toHaveLength(0);
      expect(historyRows()).toHaveLength(0);
    },
  );

  it("inside 24h of the last critical firing: nothing", async () => {
    seedAccount();
    seedCritical();
    await runCriticalCustomersCheck(env, db(), ACCOUNT, new Date(NOW.getTime() - 12 * HOUR));
    harness.sent = [];
    expect(await runCriticalCustomersCheck(env, db(), ACCOUNT, NOW)).toEqual({
      kind: "skipped",
      reason: "cooldown",
    });
    expect(harness.sent).toHaveLength(0);
    expect(historyRows()).toHaveLength(1);
  });

  it("Slack only when there is no address: channel slack", async () => {
    seedAccount({ email: null, slack: WEBHOOK });
    seedCritical();
    const out = await runCriticalCustomersCheck(env, db(), ACCOUNT, NOW);
    expect(out).toMatchObject({ kind: "fired", channel: "slack", notificationSent: true });
    expect(harness.sent).toHaveLength(0);
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0].url).toBe(WEBHOOK);
    expect(slackPosts[0].body).toContain(`${BASE}/intelligence/recommendations`);
    expect(historyRows().map((r) => [r.channel, r.notification_sent])).toEqual([["slack", 1]]);
  });

  it("neither channel: the row is still recorded, channel email, notification_sent 0", async () => {
    seedAccount({ email: null });
    seedCritical();
    const out = await runCriticalCustomersCheck(env, db(), ACCOUNT, NOW);
    expect(out).toMatchObject({ kind: "fired", channel: "none", notificationSent: false });
    expect(historyRows().map((r) => [r.channel, r.notification_sent])).toEqual([["email", 0]]);
  });

  it("a provider refusal is notification_sent 0 and a named outcome, never a throw", async () => {
    seedAccount();
    seedCritical();
    const out = await runCriticalCustomersCheck(failingBinding, db(), ACCOUNT, NOW);
    expect(out).toMatchObject({ kind: "fired", channel: "email", notificationSent: false });
    expect(historyRows().map((r) => r.notification_sent)).toEqual([0]);
  });
});
