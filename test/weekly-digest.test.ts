import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 55 / 337 binding 2: THE WEEKLY DIGEST CRON, the fifth absent engine.
//
// Legacy's spec is app/api/cron/weekly-digest/route.ts (blob b6ff2a8c, 22,247
// bytes): Monday 08:00 UTC, a ROLLING seven-day window, digest_enabled TRUE
// (NULL is OFF, the one toggle with that semantic), notification_email as the
// recipient, and a digest that SENDS EVEN IN AN EMPTY WEEK.
//
// THE ONE THING LEGACY DOES NOT HAVE IS A DEDUPE. It relies on its schedule and
// its lock, so a second invocation inside a week sends a second digest. The
// claim here is carried by the email_sends row the previous send wrote.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  jobs: [] as Record<string, unknown>[],
  outcome: { status: "sent" } as { status: string },
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/email/dispatch", () => ({
  processEmailJob: async (_env: unknown, job: Record<string, unknown>) => {
    harness.jobs.push(job);
    return harness.outcome;
  },
}));

const {
  runWeeklyDigest,
  queryDigestAccounts,
  collectDigestNumbers,
  DIGEST_WINDOW_MS,
} = await import("~/lib/cron/digest");
const { buildDigestBlocks, recoveryRate, resolveDigestCurrency } = await import(
  "~/lib/recovery/digest-email"
);

/** The words of a digest's blocks, one line each, for a containment check. */
function words(blocks: { text?: string; label?: string; url?: string }[]): string {
  return blocks.map((b) => [b.text, b.label, b.url].filter(Boolean).join(" ")).join("\n");
}

const ACCOUNT = "acct_1";
// A Monday, so the fixture reads the way the cron actually fires.
const NOW = new Date("2026-11-02T08:00:00Z");
const INSIDE = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
const OUTSIDE = new Date(NOW.getTime() - DIGEST_WINDOW_MS - 60_000);
const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way",
} as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.jobs = [];
  harness.outcome = { status: "sent" };
  seedAccount(ACCOUNT, 1);
});

function seedAccount(accountId: string, digestEnabled: number | null, email = "owner@acme.test"): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, digest_enabled, notification_email, processing_paused) VALUES (?, 'Acme', 1000, ?, ?, 0)",
    )
    .run(accountId, digestEnabled, email);
  sqlite
      // ONE LIVE CONNECTION PER STRIPE ACCOUNT. The Stripe account id is
      // derived from the Foxhound account rather than hardcoded, because a
      // shared literal made every two-account fixture violate the unique
      // index the moment it shipped, and production could never have had two
      // merchants on one connected account anyway.
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, connected_at, created_at) VALUES (?, ?, ?, 1, 'cipher', 'Teamflow', 1000, 1000)",
    )
    .run(`c_${accountId}`, accountId, `acct_s_${accountId}`);
}

function seedFailed(id: string, at: Date, cents = 5000, status = "active", accountId = ACCOUNT): void {
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, ?, ?, 'cus_1', 'b@a.test', ?, 'usd', 'soft', ?, ?)",
    )
    .run(id, accountId, `evt_${id}`, `in_${id}`, cents, status, at.getTime());
}

function seedRecovered(id: string, at: Date, cents = 5000, currency = "usd"): void {
  seedFailed(`fp_${id}`, at, cents, "recovered");
  sqlite
    .prepare(
      "INSERT INTO recovered_payments (id, account_id, failed_payment_id, amount_cents, currency, recovery_method, recovered_at) VALUES (?, ?, ?, ?, ?, 'stripe_retry', ?)",
    )
    .run(id, ACCOUNT, `fp_${id}`, cents, currency, at.getTime());
}


describe("PLANT 1: the pure copy is legacy's", () => {
  it("recovery rate is a whole percent and ZERO when nothing failed", () => {
    expect(recoveryRate(0, 0)).toBe(0);
    expect(recoveryRate(4, 1)).toBe(25);
    expect(recoveryRate(3, 2)).toBe(67);
  });

  it("currency falls back most-common, then failed, then usd", () => {
    expect(resolveDigestCurrency([{ currency: "eur" }, { currency: "eur" }, { currency: "usd" }], [])).toBe("eur");
    expect(resolveDigestCurrency([], [{ currency: "gbp" }])).toBe("gbp");
    expect(resolveDigestCurrency([], [])).toBe("usd");
  });

  it("the conditional rows appear once their counts are above zero", () => {
    const text = words(
      buildDigestBlocks({
      personalOutreachCount: 0,
      totalFailed: 1,
      totalRecovered: 0,
      recoveredRevenue: [{ currency: "usd", cents: 0 }],
      atRiskRevenue: [{ currency: "usd", cents: 100 }],
      activeCount: 0,
      emailsSent: 0,
      winBackCount: 0,
      expiringCardCount: 2,
      openDisputeCount: 1,
      openDisputeAmounts: [{ currency: "usd", cents: 9900 }],
      currency: "usd",
      senderName: null,
      disputesActive: true,
      highRiskCustomers: [],
      now: NOW,
      baseUrl: "https://u.test",
      }),
    );

    expect(text).toContain("Cards expiring soon");
    expect(text).toContain("Open disputes");
    expect(text).toContain("1 open dispute totaling $99.00 need a response");
  });
});

describe("PLANT 2: the toggle is NULL-is-OFF", () => {

  it("an account with no notification email is skipped", async () => {
    sqlite.prepare("UPDATE accounts SET notification_email = NULL WHERE id = ?").run(ACCOUNT);
    expect(await queryDigestAccounts(db)).toEqual([]);
  });

  it("an account whose only connection is disconnected is skipped", async () => {
    sqlite.prepare("UPDATE stripe_connections SET disconnected_at = 2000 WHERE account_id = ?").run(ACCOUNT);
    expect(await queryDigestAccounts(db)).toEqual([]);
  });
});

describe("PLANT 3: the numbers come from the week", () => {
  it("counts and sums only what is inside the rolling window", async () => {
    seedFailed("f_in", INSIDE, 10000);
    seedFailed("f_out", OUTSIDE, 99999);
    seedRecovered("r_in", INSIDE, 4000);

    const n = await collectDigestNumbers(db, ACCOUNT, new Date(NOW.getTime() - DIGEST_WINDOW_MS));

    // f_in plus the failed row seedRecovered creates, never f_out.
    expect(n.totalFailed).toBe(2);
    expect(n.atRiskRevenue).toEqual([{ currency: "usd", cents: 14000 }]);
    expect(n.totalRecovered).toBe(1);
    expect(n.recoveredRevenue).toEqual([{ currency: "usd", cents: 4000 }]);
  });

  it("ACTIVE SEQUENCES ARE CURRENT STATE, not this week's, as legacy has it", async () => {
    seedFailed("f_old_active", OUTSIDE, 100, "active");

    const n = await collectDigestNumbers(db, ACCOUNT, new Date(NOW.getTime() - DIGEST_WINDOW_MS));

    // Outside the window for the detected count, but still an active sequence.
    expect(n.totalFailed).toBe(0);
    expect(n.activeCount).toBe(1);
  });
});

describe("PLANT 4: one digest per account per week", () => {
  it("an active week sends one digest with the rendered figures", async () => {
    seedFailed("f1", INSIDE, 10000);
    seedRecovered("r1", INSIDE, 5000);

    const result = await runWeeklyDigest(env, NOW);

    expect(result).toMatchObject({ sent: 1, skipped: 0 });
    expect(harness.jobs).toHaveLength(1);
    const job = harness.jobs[0];
    expect(job.to).toBe("owner@acme.test");
    expect(job.template).toBe("weekly_digest");
    // The DIGEST audience (E23): Recova's unsubscribe and postal address.
    expect(job.audience).toBe("digest");
    expect(job.subject).toBe("Your weekly platform report: November 2");
    expect(String(job.unsubscribeToken)).not.toBe("");
    expect(job.physicalAddress).toBe("1 Test Way");
    // Two failed rows (f1 and seedRecovered's), one recovered: 50%.
    const body = words(job.blocks as { text?: string }[]);
    expect(body).toContain("Recovery rate: 50%");
    expect(body).toContain("Revenue recovered: $50.00");
  });
});

describe("PLANT 6: the digest does not skip itself (376 item 13)", () => {
  // THE DEFECT, in one sentence: the claim asked for a send newer than
  // `now - 7d` with `now` fixed at run start, and last week's row was written
  // moments AFTER last week's run started, so it sat inside the window by
  // exactly the duration of last week's run and every second Monday was eaten.
  //
  // EVERY DATE HERE IS ABSOLUTE AND NONE IS DERIVED FROM THE CONSTANT UNDER
  // TEST. 350's own reversals record a window mutation that proved nothing
  // because the fixtures moved with the constant; these are two real Mondays
  // and a real 90 seconds.
  it("last Monday's send, written 90 seconds after last Monday's run began, does not claim this Monday", async () => {
    sqlite
      .prepare(
        "INSERT INTO email_sends (id, account_id, template, status, created_at) VALUES ('es_last', ?, 'weekly_digest', 'sent', ?)",
      )
      .run(ACCOUNT, new Date("2026-10-26T08:01:30Z").getTime());

    const result = await runWeeklyDigest(env, new Date("2026-11-02T08:00:00Z"));

    expect(result.outcomes).toEqual([{ accountId: ACCOUNT, status: "sent" }]);
    expect(harness.jobs).toHaveLength(1);
  });
});
