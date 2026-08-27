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
  intelligenceEntitled: false,
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

vi.mock("~/lib/intelligence/views.server", () => ({
  isIntelligenceEntitled: async () => harness.intelligenceEntitled,
}));

const {
  runWeeklyDigest,
  queryDigestAccounts,
  hasDigestThisWeek,
  collectDigestNumbers,
  DIGEST_WINDOW_MS,
  DIGEST_CLAIM_WINDOW_MS,
} = await import("~/lib/cron/digest");
const { buildDigestEmail, digestSubject, recoveryRate, resolveDigestCurrency, escapeDigestHtml } =
  await import("~/lib/recovery/digest-email");

const ACCOUNT = "acct_1";
// A Monday, so the fixture reads the way the cron actually fires.
const NOW = new Date("2026-11-02T08:00:00Z");
const INSIDE = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
const OUTSIDE = new Date(NOW.getTime() - DIGEST_WINDOW_MS - 60_000);
const env = {
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
  harness.intelligenceEntitled = false;
  seedAccount(ACCOUNT, 1);
});

function seedAccount(accountId: string, digestEnabled: number | null, email = "owner@acme.test"): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, digest_enabled, notification_email, processing_paused) VALUES (?, 'Acme', 1000, ?, ?, 0)",
    )
    .run(accountId, digestEnabled, email);
  sqlite
      // ONE LIVE CONNECTION PER STRIPE ACCOUNT (356). The Stripe account id is
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

function seedDigestSend(at: Date, accountId = ACCOUNT, template = "weekly_digest"): void {
  sqlite
    .prepare(
      "INSERT INTO email_sends (id, account_id, template, status, created_at) VALUES (?, ?, ?, 'sent', ?)",
    )
    .run(`es_${at.getTime()}_${accountId}_${template}`, accountId, template, at.getTime());
}

describe("PLANT 0: the window is seven days, asserted as a literal", () => {
  it("DIGEST_WINDOW_MS is exactly seven days", () => {
    // Every fixture below derives INSIDE and OUTSIDE from this constant, so a
    // mutation to it moved both sides of every comparison and proved nothing.
    // Legacy's window is `now - 7*24*60*60*1000` and this is that number.
    expect(DIGEST_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DIGEST_WINDOW_MS).toBe(604_800_000);
  });

  it("a payment eight days old is outside it, measured against a fixed date", async () => {
    // An ABSOLUTE date, independent of the constant, so this discriminates even
    // if the constant moves.
    seedRecovered("r_8d", new Date("2026-10-25T08:00:00Z"), 999);

    const n = await collectDigestNumbers(db, ACCOUNT, new Date("2026-10-26T08:00:00Z"));

    expect(n.totalRecovered).toBe(0);
  });

  it("and six days old is inside it, against the same fixed date", async () => {
    seedRecovered("r_6d", new Date("2026-10-27T08:00:00Z"), 999);

    const n = await collectDigestNumbers(db, ACCOUNT, new Date("2026-10-26T08:00:00Z"));

    expect(n.totalRecovered).toBe(1);
  });
});

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

  it("the subject is `recovery` alone and `platform` with a product", () => {
    expect(digestSubject({ now: NOW, intelligenceActive: false, disputesActive: false })).toBe(
      "Your weekly recovery report: November 2",
    );
    expect(digestSubject({ now: NOW, intelligenceActive: true, disputesActive: false })).toBe(
      "Your weekly platform report: November 2",
    );
    expect(digestSubject({ now: NOW, intelligenceActive: false, disputesActive: true })).toBe(
      "Your weekly platform report: November 2",
    );
  });

  it("a customer name carrying markup is escaped", () => {
    expect(escapeDigestHtml(`<b>"A"&'s</b>`)).toBe("&lt;b&gt;&quot;A&quot;&amp;&#39;s&lt;/b&gt;");
  });

  it("the body carries legacy's labels and the computed figures", () => {
    const html = buildDigestEmail({
      totalFailed: 4,
      totalRecovered: 1,
      recoveredRevenueCents: 5000,
      atRiskRevenueCents: 20000,
      activeCount: 3,
      emailsSent: 7,
      winBackCount: 2,
      expiringCardCount: 0,
      openDisputeCount: 0,
      openDisputeCents: 0,
      currency: "usd",
      senderName: "Teamflow",
      disputesActive: false,
      intelligenceActive: false,
      highRiskCustomers: [],
      now: NOW,
      dashboardUrl: "https://foxhoundapp.test/dashboard",
    });

    expect(html).toContain("Week ending Monday, November 2");
    expect(html).toContain("Your recovery summary");
    expect(html).toContain("$50.00");
    expect(html).toContain("25%");
    expect(html).toContain("Failed payments detected");
    expect(html).toContain("Revenue at risk");
    expect(html).toContain("$200.00");
    expect(html).toContain("Active recovery sequences");
    expect(html).toContain("Recovery emails sent");
    expect(html).toContain("Active win-back sequences");
    // Conditional rows absent at zero, as legacy has them.
    expect(html).not.toContain("Cards expiring soon");
    expect(html).not.toContain("Open disputes");
    expect(html).toContain("https://foxhoundapp.test/dashboard");
  });

  it("the conditional rows appear once their counts are above zero", () => {
    const html = buildDigestEmail({
      totalFailed: 1,
      totalRecovered: 0,
      recoveredRevenueCents: 0,
      atRiskRevenueCents: 100,
      activeCount: 0,
      emailsSent: 0,
      winBackCount: 0,
      expiringCardCount: 2,
      openDisputeCount: 1,
      openDisputeCents: 9900,
      currency: "usd",
      senderName: null,
      disputesActive: true,
      intelligenceActive: false,
      highRiskCustomers: [],
      now: NOW,
      dashboardUrl: "u",
    });

    expect(html).toContain("Cards expiring soon");
    expect(html).toContain("Open disputes");
    expect(html).toContain("1 open dispute totaling $99.00 need a response");
  });

  it("THE INTELLIGENCE SECTION CARRIES NO PERSONAL-OUTREACH LINE, which has no producer", () => {
    const html = buildDigestEmail({
      totalFailed: 0,
      totalRecovered: 0,
      recoveredRevenueCents: 0,
      atRiskRevenueCents: 0,
      activeCount: 0,
      emailsSent: 0,
      winBackCount: 0,
      expiringCardCount: 0,
      openDisputeCount: 0,
      openDisputeCents: 0,
      currency: "usd",
      senderName: null,
      disputesActive: false,
      intelligenceActive: true,
      highRiskCustomers: [{ name: "Acme Co", mrrCents: 19900 }],
      now: NOW,
      dashboardUrl: "u",
    });

    expect(html).toContain("Top at-risk customers");
    expect(html).toContain("Acme Co");
    expect(html).not.toContain("personal outreach");
    expect(html).not.toContain("flagged for");
  });
});

describe("PLANT 2: the toggle is NULL-is-OFF", () => {
  it("digest_enabled TRUE is selected", async () => {
    expect((await queryDigestAccounts(db)).map((a) => a.accountId)).toEqual([ACCOUNT]);
  });

  it("NULL is NOT selected, which is this toggle's whole point", async () => {
    seedAccount("acct_null", null);
    expect((await queryDigestAccounts(db)).map((a) => a.accountId)).not.toContain("acct_null");
  });

  it("FALSE is not selected", async () => {
    seedAccount("acct_off", 0);
    expect((await queryDigestAccounts(db)).map((a) => a.accountId)).not.toContain("acct_off");
  });

  it("an account with no notification email is skipped", async () => {
    sqlite.prepare("UPDATE accounts SET notification_email = NULL WHERE id = ?").run(ACCOUNT);
    expect(await queryDigestAccounts(db)).toEqual([]);
  });

  it("an account whose only connection is disconnected is skipped", async () => {
    sqlite.prepare("UPDATE stripe_connections SET disconnected_at = 2000 WHERE account_id = ?").run(ACCOUNT);
    expect(await queryDigestAccounts(db)).toEqual([]);
  });

  it("A DEMO ACCOUNT IS EXCLUDED", async () => {
    seedAccount("demo_teamflow", 1);
    expect((await queryDigestAccounts(db)).map((a) => a.accountId)).not.toContain("demo_teamflow");
  });

  it("a paused account is excluded", async () => {
    sqlite.prepare("UPDATE accounts SET processing_paused = 1 WHERE id = ?").run(ACCOUNT);
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
    expect(n.atRiskRevenueCents).toBe(14000);
    expect(n.totalRecovered).toBe(1);
    expect(n.recoveredRevenueCents).toBe(4000);
  });

  it("A PAYMENT JUST OUTSIDE THE WINDOW IS EXCLUDED, and just inside is not", async () => {
    seedRecovered("r_edge_out", new Date(NOW.getTime() - DIGEST_WINDOW_MS - 1), 111);
    let n = await collectDigestNumbers(db, ACCOUNT, new Date(NOW.getTime() - DIGEST_WINDOW_MS));
    expect(n.totalRecovered).toBe(0);

    seedRecovered("r_edge_in", new Date(NOW.getTime() - DIGEST_WINDOW_MS + 1), 222);
    n = await collectDigestNumbers(db, ACCOUNT, new Date(NOW.getTime() - DIGEST_WINDOW_MS));
    expect(n.totalRecovered).toBe(1);
    expect(n.recoveredRevenueCents).toBe(222);
  });

  it("ACTIVE SEQUENCES ARE CURRENT STATE, not this week's, as legacy has it", async () => {
    seedFailed("f_old_active", OUTSIDE, 100, "active");

    const n = await collectDigestNumbers(db, ACCOUNT, new Date(NOW.getTime() - DIGEST_WINDOW_MS));

    // Outside the window for the detected count, but still an active sequence.
    expect(n.totalFailed).toBe(0);
    expect(n.activeCount).toBe(1);
  });

  it("another account's rows never leak in", async () => {
    seedAccount("acct_2", 1, "other@acme.test");
    seedFailed("f_other", INSIDE, 777, "active", "acct_2");

    const n = await collectDigestNumbers(db, ACCOUNT, new Date(NOW.getTime() - DIGEST_WINDOW_MS));

    expect(n.totalFailed).toBe(0);
    expect(n.activeCount).toBe(0);
  });
});

describe("PLANT 4: one digest per account per week", () => {
  it("an active week sends one digest with the rendered figures", async () => {
    seedFailed("f1", INSIDE, 10000);
    seedRecovered("r1", INSIDE, 5000);

    const result = await runWeeklyDigest(env, NOW);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(harness.jobs).toHaveLength(1);
    const job = harness.jobs[0];
    expect(job.to).toBe("owner@acme.test");
    expect(job.template).toBe("weekly_digest");
    expect(job.audience).toBe("merchant");
    expect(job.subject).toBe("Your weekly recovery report: November 2");
    // MERCHANT audience: no unsubscribe token is minted.
    expect(job.unsubscribeToken).toBe("");
    // Two failed rows (f1 and seedRecovered's), one recovered: 50%.
    expect(String(job.bodyHtml)).toContain("50%");
    expect(String(job.bodyHtml)).toContain("$50.00");
  });

  it("AN EMPTY WEEK STILL SENDS, which is legacy's behaviour", async () => {
    const result = await runWeeklyDigest(env, NOW);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(String(harness.jobs[0].bodyHtml)).toContain("0%");
    expect(String(harness.jobs[0].bodyHtml)).toContain("$0.00");
  });

  it("A SECOND TICK THE SAME WEEK SENDS NOTHING", async () => {
    seedDigestSend(INSIDE);

    const result = await runWeeklyDigest(env, NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(harness.jobs).toEqual([]);
  });

  it("and a digest from BEFORE the window does not block the next one", async () => {
    seedDigestSend(OUTSIDE);

    expect((await runWeeklyDigest(env, NOW)).sent).toBe(1);
  });

  it("THE CLAIM IS REACHED ALONE, and it is per account and per template", async () => {
    const windowStart = new Date(NOW.getTime() - DIGEST_WINDOW_MS);
    expect(await hasDigestThisWeek(db, ACCOUNT, windowStart)).toBe(false);

    // Another account's digest does not claim this one's.
    seedAccount("acct_2", 1, "two@acme.test");
    seedDigestSend(INSIDE, "acct_2");
    expect(await hasDigestThisWeek(db, ACCOUNT, windowStart)).toBe(false);

    // A different template does not claim it either.
    seedDigestSend(INSIDE, ACCOUNT, "recovery_dunning");
    expect(await hasDigestThisWeek(db, ACCOUNT, windowStart)).toBe(false);

    seedDigestSend(INSIDE, ACCOUNT);
    expect(await hasDigestThisWeek(db, ACCOUNT, windowStart)).toBe(true);
  });

  it("a refused send is not counted and writes no claim of its own", async () => {
    harness.outcome = { status: "blocked" };

    const result = await runWeeklyDigest(env, NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
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
  const MONDAY_1 = new Date("2026-11-02T08:00:00Z");
  const MONDAY_2 = new Date("2026-11-09T08:00:00Z");
  /** Last week's send row, written 90 seconds after last week's run started,
   *  which is what a completed send looks like on the clock. */
  const MONDAY_1_SEND = new Date("2026-11-02T08:01:30Z");

  it("TWO CONSECUTIVE MONDAYS BOTH SEND", async () => {
    seedDigestSend(MONDAY_1_SEND);

    const second = await runWeeklyDigest(env, MONDAY_2);

    // Against the pre-fix claim this reads {sent: 0, skipped: 1}: `now - 7d` on
    // Monday 2 is 08:00:00 on Monday 1, and the row at 08:01:30 is newer.
    expect(second).toEqual({ sent: 1, skipped: 0 });
    expect(harness.jobs).toHaveLength(1);
  });

  it("and the 90 seconds is what did it: a row ON last week's run start also sends", async () => {
    // The boundary itself, so the fix is not merely "90 seconds of slack". A row
    // written at the very instant last week's run started is still last week's.
    seedDigestSend(MONDAY_1);

    expect((await runWeeklyDigest(env, MONDAY_2)).sent).toBe(1);
  });

  it("CONTROL: a second run ten minutes later still sends nothing", async () => {
    // The half that must NOT regress. Widening the claim window fixes the skip
    // by weakening the claim, so the claim has to be shown still claiming.
    seedDigestSend(MONDAY_1_SEND);

    const rerun = await runWeeklyDigest(env, new Date("2026-11-02T08:10:00Z"));

    expect(rerun).toEqual({ sent: 0, skipped: 1 });
    expect(harness.jobs).toEqual([]);
  });

  it("CONTROL: the DATA window is untouched, still seven days", () => {
    // 376 item 13 moved the CLAIM window only. A fix that shortened the data
    // window would quietly change every figure on the email.
    expect(DIGEST_WINDOW_MS).toBe(604_800_000);
    expect(DIGEST_CLAIM_WINDOW_MS).toBe(518_400_000);
    expect(DIGEST_WINDOW_MS - DIGEST_CLAIM_WINDOW_MS).toBe(86_400_000);
  });
});

describe("PLANT 5: the docs describe the built behaviour", () => {
  it("the platform guide no longer says the digest is unbuilt, and says what it does", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .join(" ");

    expect(body).not.toContain("The weekly digest and Slack delivery are not built yet");
    expect(body).toContain("The weekly digest is a Monday morning summary");
    // The three facts a merchant needs: when, that it is off by default, and
    // that a quiet week still produces one.
    expect(body).toContain("previous seven days");
    // Session 56 built the page, so the sentence now names it.
    expect(body).toContain("off until you enable it on the notifications page");
    expect(body).toContain("even in a quiet week");
  });
});
