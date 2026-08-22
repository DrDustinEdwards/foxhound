import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// THE EXPIRING-CARD ALERT CRON, ported from legacy's expiring-cards route
// (blob 717f6bbe). Two passes: scan, then send.
//
// Every send assertion observes email_sends or the sent message. The claim
// assertions observe alert_sent_at, and the outcome assertion observes the
// outcomes table, because 341 binding 1 makes recording it the point.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as { from: string; to: string; subject: string; html: string; headers?: unknown }[],
  subscriptions: [] as unknown[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// recordOutcome routes through the per-account money-write DO, which has no
// binding in a unit test. Same stub the billing suites use: run the batch
// against the harness database so the OUTCOME ROW is observable, which is the
// point of 341 binding 1.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    const batch = write.build(harness.db);
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
    return { applied: true };
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_e: unknown, c: string) => `plain:${c}`,
}));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    subscriptions: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const s of harness.subscriptions) yield s;
        },
      }),
    },
  }),
}));

const { runExpiringCards, scanExpiringCards, sendExpiringCardAlerts, isInsideLeadWindow, EXPIRING_CARD_SCAN_SOFT_LIMIT } =
  await import("~/lib/cron/expiring-cards");
const { expiringCardSubject } = await import("~/lib/recovery/expiring-card-email");
const { LIVE_SENDS_DISABLED_ERROR } = await import("~/lib/email/dispatch");

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-01T00:00:00Z");

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
  harness.subscriptions = [];
});

function seedAccount(opts: { enabled?: number | null; liveSends?: number; senderName?: string | null } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, expiring_card_notifications_enabled, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?)",
    )
    .run(ACCOUNT, opts.enabled === undefined ? null : opts.enabled, opts.liveSends === undefined ? 1 : opts.liveSends);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'cipher', ?, 1000, 1000)",
    )
    .run(ACCOUNT, opts.senderName === undefined ? "Acme Billing" : opts.senderName);
}

function subscription(expMonth: number, expYear: number, customerId = "cus_1", email: string | null = "buyer@acme.test") {
  return {
    id: `sub_${customerId}`,
    customer: { id: customerId, email, name: "Jane Buyer" },
    default_payment_method: { card: { exp_month: expMonth, exp_year: expYear, brand: "visa", last4: "4242" } },
  };
}

function alertRows() {
  return sqlite
    .prepare(
      "SELECT id, stripe_customer_id AS customer, expires_month AS m, expires_year AS y, alert_sent_at AS sentAt FROM expiring_card_alerts ORDER BY expires_month, stripe_customer_id",
    )
    .all() as { id: string; customer: string; m: number; y: number; sentAt: number | null }[];
}

function sendRows() {
  return sqlite
    .prepare("SELECT status, template, error FROM email_sends WHERE account_id = ?")
    .all(ACCOUNT) as { status: string; template: string | null; error: string | null }[];
}

function outcomeRows() {
  return sqlite
    .prepare("SELECT event_type AS eventType, outcome, event_data AS eventData FROM outcomes WHERE account_id = ?")
    .all(ACCOUNT) as { eventType: string; outcome: string | null; eventData: string | null }[];
}

describe("PLANT 1: the band guard, ported as found", () => {
  it("a card inside the window qualifies, one outside does not, and an expired one does not", () => {
    // now is 2026-11-01, so the horizon is 2026-12-01.
    expect(isInsideLeadWindow(11, 2026, NOW)).toBe(true);
    expect(isInsideLeadWindow(12, 2026, NOW)).toBe(true);
    expect(isInsideLeadWindow(1, 2027, NOW)).toBe(false);
    // ALREADY EXPIRED is skipped, not alerted: the window is a band.
    expect(isInsideLeadWindow(10, 2026, NOW)).toBe(false);
    expect(isInsideLeadWindow(1, 2020, NOW)).toBe(false);
  });

  it("the scan records only the cards inside the band", async () => {
    seedAccount();
    harness.subscriptions = [
      subscription(11, 2026, "cus_in"),
      subscription(1, 2027, "cus_far"),
      subscription(10, 2026, "cus_expired"),
    ];

    const result = await scanExpiringCards(env, NOW);

    expect(result.scanned).toBe(3);
    expect(result.recorded).toBe(1);
    expect(alertRows().map((r) => r.customer)).toEqual(["cus_in"]);
  });

  it("a customer with no email is not recorded, because it could never be sent", async () => {
    seedAccount();
    harness.subscriptions = [subscription(11, 2026, "cus_noemail", null)];
    await scanExpiringCards(env, NOW);
    expect(alertRows()).toEqual([]);
  });
});

describe("PLANT 2: the scan is deduped by the database", () => {
  it("a second scan records nothing new for the same card-month", async () => {
    seedAccount();
    harness.subscriptions = [subscription(11, 2026)];

    const first = await scanExpiringCards(env, NOW);
    const second = await scanExpiringCards(env, NOW);

    expect(first.recorded).toBe(1);
    expect(alertRows()).toHaveLength(1);
    // The upsert conflicts and does nothing; the row count is the assertion.
    expect(second.recorded).toBe(1);
    expect(alertRows()).toHaveLength(1);
  });

  it("a DIFFERENT expiry month for the same customer is a new candidate", async () => {
    seedAccount();
    harness.subscriptions = [subscription(11, 2026)];
    await scanExpiringCards(env, NOW);
    harness.subscriptions = [subscription(12, 2026)];
    await scanExpiringCards(env, NOW);
    expect(alertRows()).toHaveLength(2);
  });

  it("the scan paginates rather than stopping at legacy's first page", async () => {
    seedAccount();
    harness.subscriptions = Array.from({ length: 250 }, (_, i) =>
      subscription(11, 2026, `cus_${i}`, `b${i}@acme.test`),
    );

    const result = await scanExpiringCards(env, NOW);

    // Legacy's single limit:100 call would have seen 100 of these.
    expect(result.scanned).toBe(250);
    expect(alertRows()).toHaveLength(250);
    expect(result.overLimit).toEqual([]);
  });

  it("crossing the soft ceiling is REPORTED, not hidden", async () => {
    seedAccount();
    harness.subscriptions = Array.from({ length: EXPIRING_CARD_SCAN_SOFT_LIMIT + 10 }, (_, i) =>
      subscription(11, 2026, `cus_${i}`, `b${i}@acme.test`),
    );

    const result = await scanExpiringCards(env, NOW);

    expect(result.scanned).toBe(EXPIRING_CARD_SCAN_SOFT_LIMIT);
    expect(result.overLimit).toEqual([ACCOUNT]);
  });
});

describe("PLANT 3: the send, at legacy's strings and on the customer audience", () => {
  async function seedCandidate(id = "al_1") {
    sqlite
      .prepare(
        "INSERT INTO expiring_card_alerts (id, account_id, stripe_connection_id, stripe_customer_id, customer_email, customer_name, card_brand, card_last4, expires_month, expires_year, created_at) VALUES (?, ?, 'c1', 'cus_1', 'buyer@acme.test', 'Jane Buyer', 'visa', '4242', 11, 2026, 1000)",
      )
      .run(id, ACCOUNT);
  }

  it("one email, legacy's subject, with the CAN-SPAM footer and unsubscribe headers", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result.sent).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].subject).toBe("Action required: Your visa card ending in 4242 is expiring");
    expect(harness.sent[0].to).toBe("buyer@acme.test");
    // CUSTOMER audience: this is commercial mail on the merchant's behalf.
    expect(harness.sent[0].html).toContain("Unsubscribe");
    expect(harness.sent[0].html).toContain("1 Test Way");
    expect((harness.sent[0].headers as Record<string, string>)["List-Unsubscribe"]).toBeTruthy();
    // The merchant's own sender name, not the platform's.
    expect(harness.sent[0].from.startsWith("Acme Billing <")).toBe(true);
    expect(sendRows()[0].template).toBe("expiring_card_alert");
  });

  it("the body carries legacy's wording and links to the alert-mode card page", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();
    await sendExpiringCardAlerts(env, NOW);
    const html = harness.sent[0].html;
    expect(html).toContain("Hi Jane Buyer,");
    expect(html).toContain("<strong>visa card ending in 4242</strong>");
    expect(html).toContain("is expiring on <strong>11/2026</strong>");
    expect(html).toContain("To avoid any interruption to your service");
    expect(html).toContain("Update Payment Method");
    expect(html).toContain("If you've already updated your card, you can ignore this message.");
    expect(html).toContain("https://foxhoundapp.test/p/");
  });

  it("THE OUTCOME IS RECORDED at legacy's event_type, on a send", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();

    await sendExpiringCardAlerts(env, NOW);

    const outcomes = outcomeRows();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].eventType).toBe("expiring_card_alert_sent");
    expect(outcomes[0].outcome).toBe("sent");
    expect(String(outcomes[0].eventData)).toContain("2026");
  });

  it("a SECOND tick sends nothing more and records no second outcome", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();

    await sendExpiringCardAlerts(env, NOW);
    const second = await sendExpiringCardAlerts(env, new Date(NOW.getTime() + 86_400_000));

    expect(second.sent).toBe(0);
    expect(harness.sent).toHaveLength(1);
    expect(outcomeRows()).toHaveLength(1);
    expect(alertRows()[0].sentAt).not.toBeNull();
  });
});

describe("PLANT 4: every refusal, and none of them records an outcome", () => {
  async function seedCandidate() {
    sqlite
      .prepare(
        "INSERT INTO expiring_card_alerts (id, account_id, stripe_connection_id, stripe_customer_id, customer_email, card_brand, card_last4, expires_month, expires_year, created_at) VALUES ('al_1', ?, 'c1', 'cus_1', 'buyer@acme.test', 'visa', '4242', 11, 2026, 1000)",
      )
      .run(ACCOUNT);
  }

  it("toggle FALSE sends nothing, stamps the candidate, records no outcome", async () => {
    seedAccount({ enabled: 0 });
    await seedCandidate();

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result.sent).toBe(0);
    expect(harness.sent).toHaveLength(0);
    expect(outcomeRows()).toEqual([]);
    // STAMPED, so it is never reconsidered: legacy's behaviour.
    expect(alertRows()[0].sentAt).not.toBeNull();
  });

  it("toggle NULL sends, which is the whole point of NULL-is-ON", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();
    expect((await sendExpiringCardAlerts(env, NOW)).sent).toBe(1);
  });

  it("a SUPPRESSED address sends nothing and is stamped", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();
    sqlite
      .prepare(
        "INSERT INTO email_suppressions (id, email, token, suppressed_at) VALUES ('s1', 'buyer@acme.test', 'tok', 2000)",
      )
      .run();

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result.sent).toBe(0);
    expect(harness.sent).toHaveLength(0);
    expect(alertRows()[0].sentAt).not.toBeNull();
    expect(outcomeRows()).toEqual([]);
  });

  it("a DEMO or live-sends-off account refuses at the send gate", async () => {
    seedAccount({ enabled: null, liveSends: 0 });
    await seedCandidate();

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result.sent).toBe(0);
    expect(harness.sent).toHaveLength(0);
    expect(sendRows()[0].status).toBe("blocked");
    expect(sendRows()[0].error).toBe(LIVE_SENDS_DISABLED_ERROR);
    expect(outcomeRows()).toEqual([]);
  });

  it("a send FAILURE leaves the candidate unsent so tomorrow retries", async () => {
    seedAccount({ enabled: null });
    await seedCandidate();
    const failing = {
      ...env,
      EMAIL: { send: async () => { throw new Error("provider exploded"); } },
    } as unknown as Env;

    const result = await sendExpiringCardAlerts(failing, NOW);

    expect(result.sent).toBe(0);
    expect(alertRows()[0].sentAt).toBeNull();
    expect(sendRows()[0].status).toBe("failed");
    expect(outcomeRows()).toEqual([]);
  });
});

describe("PLANT 5: the cron is registered and shaped like the others", () => {
  const REGISTRY = readFileSync(
    fileURLToPath(new URL("../app/lib/cron/registry.ts", import.meta.url)),
    "utf8",
  );

  it("registered at the daily schedule, which is where the lease is applied", () => {
    expect(REGISTRY).toContain('{ name: "expiring-cards", schedule: CRON_SCHEDULE_DAILY, handler: expiringCards }');
    // The lease lives in run.ts for every job; registering is what opts in.
    const run = readFileSync(
      fileURLToPath(new URL("../app/lib/cron/run.ts", import.meta.url)),
      "utf8",
    );
    expect(run).toContain("lock.acquire(CRON_LOCK_LEASE_MS)");
  });

  it("one run does both passes", async () => {
    seedAccount({ enabled: null });
    harness.subscriptions = [subscription(11, 2026)];

    const result = await runExpiringCards(env, NOW);

    expect(result.scan.recorded).toBe(1);
    expect(result.send.sent).toBe(1);
    expect(harness.sent).toHaveLength(1);
  });

  it("no wide dash in the customer-facing strings", () => {
    const wide = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
    expect(expiringCardSubject({ cardBrand: "visa", cardLast4: "4242" })).not.toMatch(wide);
  });
});

describe("PLANT 6: the docs describe the alert, including what it does not do", () => {
  const DOCS = readFileSync(
    fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
    "utf8",
  );
  const section = DOCS.slice(
    DOCS.indexOf('heading: "Before a card expires"'),
    DOCS.indexOf('heading: "What counts as billable"'),
  );

  it("names the cadence, the window, the sender and the link", () => {
    expect(section).toContain("checks your active subscriptions nightly");
    expect(section).toContain("inside 30 days of expiring");
    expect(section).toContain("comes from your sender name");
    expect(section).toContain("hosted card-update page");
  });

  it("says it sends once, and that an expired card is not warned about", () => {
    expect(section).toContain("once per card and expiry month");
    expect(section).toContain("already expired is not warned about");
  });

  it("SAYS PLAINLY THAT IT IS NOT BILLABLE, which is the pricing question 341 ruled", () => {
    expect(section).toContain("Nothing about this alert is billable");
    expect(section).toContain("prevents a failure rather than recovering one");
  });
});
