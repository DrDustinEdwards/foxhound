import { describe, expect, it, vi } from "vitest";

import { accounts, auditDigestRuns, cronAlerts, cronRunHistory, failedPayments, recoveredPayments } from "~/db/schema";
import { findStaleCrons } from "~/lib/cron/alerts.server";
import { CRON_SCHEDULE_MONTHLY } from "~/lib/constants";
import {
  buildDigestEmail,
  compareTotals,
  describeDigestRun,
  digestPeriod,
} from "~/lib/audit/digest.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 316 / SPEC 314: the monthly audit digest cron, closing the promise
// /settings/audit ships ("on the 1st of each month, we run a fresh audit and
// email you a comparison versus the prior month").
//
// WHAT THIS SUITE PROVES, in the order 257/286/296 require:
//   1. registration, through the REAL runner, not by reading the array
//   2. toggle-off AND NULL both skipped THROUGH THE SHARED PREDICATE
//   3. processing_paused, cancelled and demo accounts all skipped
//   4. idempotency per account per month, by DATABASE refusal
//   5. a failure reaching Session 24's alert machinery
//   6. cron-health seeing the schedule as MAPPABLE (314's unmappable posture)
//
// COVERAGE BOUND (246). Everything below runs against a real in-memory SQLite
// with the committed migrations applied verbatim, so the unique index and the
// FKs are the real ones. What is NOT proven here: a real Cloudflare Email
// Service send (env.EMAIL is a stub throughout), and the deployed cron actually
// firing on the 1st, which only a calendar can demonstrate. Neither is
// assertable in this harness and both are stated rather than implied.
//
// DEAD-LETTERING IS DELIBERATELY NOT PROVEN, because it is not reachable from
// this path and faking it would be worse than omitting it. email_dead_letters
// records QUEUE-delivered jobs (it stores queue_message_id and attempts, and is
// written by the DLQ consumer). The digest calls sendTransactionalEmail
// directly, and the queue PRODUCER was deleted under ruling 280, so no digest
// send can ever become a queue message. The half of Session 24's machinery this
// cron genuinely rides is the failure ALERT, proven in section 5.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { runAuditDigest } = await import("~/lib/audit/digest.server");
const { runCronJob } = await import("~/lib/cron/run");
const { CRON_JOBS, jobsForSchedule } = await import("~/lib/cron/registry");

const NOW = new Date("2026-09-01T04:00:00.000Z");
const PERIOD = "2026-08";

type TestDb = ReturnType<typeof createInMemoryDb>["db"];

function env(send: (m: unknown) => Promise<{ id: string }> = async () => ({ id: "m" })): Env {
  const stub = { acquire: async () => true, release: async () => {} };
  return {
    DB: {},
    EMAIL: { send },
    CRON_LOCK: { get: () => stub, idFromName: (n: string) => n },
  } as unknown as Env;
}

async function seedAccount(db: TestDb, id: string, row: Record<string, unknown> = {}) {
  await db.insert(accounts).values({
    id,
    name: id,
    notificationEmail: `${id}@merchant.test`,
    createdAt: NOW,
    ...row,
  });
}

/** A billable recovered payment, with the failed_payments parent its FK needs. */
async function seedRecovery(db: TestDb, accountId: string, cents: number, currency = "usd") {
  const fpId = `fp_${accountId}_${cents}_${currency}`;
  await db.insert(failedPayments).values({
    id: fpId,
    stripeEventId: `evt_${fpId}`,
    stripeInvoiceId: `in_${fpId}`,
    stripeCustomerId: `cus_${fpId}`,
    customerEmail: "c@example.test",
    amountCents: cents,
    currency,
    declineCategory: "soft",
    status: "recovered",
    detectedAt: NOW,
    accountId,
  });
  await db.insert(recoveredPayments).values({
    id: `rp_${fpId}`,
    failedPaymentId: fpId,
    recoveredAt: NOW,
    amountCents: cents,
    currency,
    recoveryMethod: "retry",
    accountId,
    attributionKind: "foxhound_retry",
  });
}

// ============================================================================
// Pure decisions
// ============================================================================

describe("316: the period a run covers", () => {
  it("a run on the 1st covers the month that just ended", () => {
    expect(digestPeriod(NOW)).toBe("2026-08");
  });

  it("January's run covers the PREVIOUS YEAR's December", () => {
    expect(digestPeriod(new Date("2027-01-01T04:00:00.000Z"))).toBe("2026-12");
  });

  it("the period string is zero-padded, so it sorts as a string", () => {
    expect(digestPeriod(new Date("2026-11-01T04:00:00.000Z"))).toBe("2026-10");
    expect("2026-09" > "2026-10").toBe(false);
  });
});

describe("316: the comparison is per currency and never summed across them", () => {
  it("a first run reports NO change rather than a change of zero", () => {
    expect(compareTotals([{ currency: "usd", cents: 500 }], null)).toEqual([
      { currency: "usd", cents: 500, changeCents: null },
    ]);
  });

  it("a later run reports the delta against the prior snapshot", () => {
    expect(
      compareTotals([{ currency: "usd", cents: 800 }], [{ currency: "usd", cents: 500 }]),
    ).toEqual([{ currency: "usd", cents: 800, changeCents: 300 }]);
  });

  it("TWO CURRENCIES STAY TWO ROWS, with their own deltas", () => {
    // core.md records cross-currency summing as a live defect elsewhere. If this
    // ever collapses to one row, that defect has been reproduced here.
    const result = compareTotals(
      [
        { currency: "usd", cents: 800 },
        { currency: "eur", cents: 200 },
      ],
      [
        { currency: "usd", cents: 500 },
        { currency: "eur", cents: 150 },
      ],
    );
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ currency: "usd", cents: 800, changeCents: 300 });
    expect(result).toContainEqual({ currency: "eur", cents: 200, changeCents: 50 });
  });

  it("a currency that DISAPPEARED still produces a row, as a fall to zero", () => {
    expect(compareTotals([], [{ currency: "gbp", cents: 400 }])).toEqual([
      { currency: "gbp", cents: 0, changeCents: -400 },
    ]);
  });
});

describe("316: the email body follows the copy's promise", () => {
  it("carries the total AND the comparison, in the merchant's currency", () => {
    const { subject, bodyHtml } = buildDigestEmail(
      [{ currency: "usd", cents: 12_40, changeCents: 3_10 }],
      PERIOD,
    );
    expect(subject).toContain(PERIOD);
    expect(bodyHtml).toContain("$12.40");
    expect(bodyHtml).toContain("$3.10");
    expect(bodyHtml).toContain("up");
  });

  it("a FALL reads as down, not as a negative amount", () => {
    const { bodyHtml } = buildDigestEmail(
      [{ currency: "usd", cents: 100, changeCents: -500 }],
      PERIOD,
    );
    expect(bodyHtml).toContain("down $5.00");
    expect(bodyHtml).not.toContain("-$5.00");
  });

  it("the FIRST digest says there is nothing to compare against yet", () => {
    const { bodyHtml } = buildDigestEmail(
      [{ currency: "usd", cents: 500, changeCents: null }],
      PERIOD,
    );
    expect(bodyHtml).toContain("first digest");
  });

  it("names the setting that turns it off, since the merchant opted in", () => {
    const { bodyHtml } = buildDigestEmail([{ currency: "usd", cents: 1, changeCents: null }], PERIOD);
    expect(bodyHtml).toContain("audit settings");
  });

  it("NEVER names the AI vendor, and does not claim an AI summary it has none of", () => {
    const { bodyHtml } = buildDigestEmail([{ currency: "usd", cents: 1, changeCents: 1 }], PERIOD);
    for (const banned of ["Claude", "Anthropic", "GPT", "LLM", "written by AI"]) {
      expect(bodyHtml).not.toContain(banned);
    }
  });
});

// ============================================================================
// 1. Registration, through the real runner
// ============================================================================

describe("316 (1): the cron is REGISTERED and the real runner executes it", () => {
  it("rides the monthly schedule, which is what the page's copy promises", () => {
    const monthly = jobsForSchedule(CRON_SCHEDULE_MONTHLY);
    expect(monthly.map((j) => j.name)).toContain("audit-digest");
    // "0 4 1 * *" is the 1st of the month. The copy says the 1st.
    expect(CRON_SCHEDULE_MONTHLY.split(" ")[2]).toBe("1");
  });

  it("THE REGISTERED HANDLER RUNS through runCronJob and records history", async () => {
    // Not "the array contains a name": the registry's own handler is pulled out
    // and driven through the real gate/lock/history path.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const job = CRON_JOBS.find((j) => j.name === "audit-digest")!;
    const outcome = await runCronJob(env(), job.name, job.handler);

    expect(outcome.status).toBe("success");
    const runs = await db.select().from(cronRunHistory);
    expect(runs).toHaveLength(1);
    expect(runs[0].cronName).toBe("audit-digest");
    expect(runs[0].rowsProcessed).toBe(1);

    // The digest row names the run that produced it.
    const digests = await db.select().from(auditDigestRuns);
    expect(digests).toHaveLength(1);
    expect(digests[0].cronRunId).toBe(runs[0].id);
    expect(digests[0].status).toBe("sent");
  });
});

// ============================================================================
// 2. The opt-in gate, THROUGH the shared predicate
// ============================================================================

describe("316 (2): the toggle is read through the SHARED predicate", () => {
  it("a NULL account is SKIPPED, which is the halt Session 25 called", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_null", { auditAutoRun: null });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.eligible).toBe(1); // it WAS enumerated
    expect(result.optedIn).toBe(0); // and the predicate refused it
    expect(result.sent).toBe(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
  });

  it("an explicitly FALSE account is skipped the same way", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_off", { auditAutoRun: false });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.eligible).toBe(1);
    expect(result.optedIn).toBe(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
  });

  it("a TRUE account sends, so the skips above are the predicate and not inertia", async () => {
    // Without this, three passing skip tests would be indistinguishable from a
    // cron that never sends to anyone.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const sent: unknown[] = [];
    const result = await runAuditDigest(
      env(async (m) => {
        sent.push(m);
        return { id: "m" };
      }),
      NOW,
      null,
    );

    expect(result.optedIn).toBe(1);
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("THE GATE IS NOT IN SQL: an opted-out account is still ENUMERATED", async () => {
    // The design note of 316. If the toggle moved into the WHERE clause, the
    // page and the cron could drift apart on what NULL means with no test
    // noticing. `eligible` counts rows the QUERY returned; `optedIn` counts what
    // the shared predicate allowed. They must differ here.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "a_on", { auditAutoRun: true });
    await seedAccount(db, "a_null", { auditAutoRun: null });
    await seedAccount(db, "a_off", { auditAutoRun: false });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.eligible).toBe(3);
    expect(result.optedIn).toBe(1);
  });
});

// ============================================================================
// 3. Account states, matching the sibling crons
// ============================================================================

describe("316 (3): the account states every other per-account cron respects", () => {
  it("a PROCESSING-PAUSED account is skipped even with the toggle on", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_paused", { auditAutoRun: true, processingPaused: true });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.eligible).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("a CANCELLED account is skipped even with the toggle on", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_cancelled", { auditAutoRun: true, cancelledAt: NOW });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.eligible).toBe(0);
  });

  it("a DEMO account is skipped even with the toggle on", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "demo_teamflow", { auditAutoRun: true });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.eligible).toBe(0);
  });

  it("BILLING-EXEMPT is deliberately NOT a gate: the digest is free", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_exempt", { auditAutoRun: true, billingExempt: true });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.sent).toBe(1);
  });

  it("an account with NO notification email is claimed but not mailed", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_noemail", { auditAutoRun: true, notificationEmail: null });

    const sent: unknown[] = [];
    const result = await runAuditDigest(
      env(async (m) => {
        sent.push(m);
        return { id: "m" };
      }),
      NOW,
      null,
    );

    expect(result.skippedNoRecipient).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_recipient");
  });
});

// ============================================================================
// 4. Idempotency, by DATABASE refusal
// ============================================================================

describe("316 (4): idempotent per account per month, refused by the database", () => {
  it("a SECOND run in the same month sends nothing", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const sent: unknown[] = [];
    const e = env(async (m) => {
      sent.push(m);
      return { id: "m" };
    });

    const first = await runAuditDigest(e, NOW, null);
    const second = await runAuditDigest(e, NOW, null);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(1);
  });

  it("A PLANTED DUPLICATE ROW is refused by the INDEX, not by application logic", async () => {
    // The plant: the month's row is inserted by hand BEFORE the cron runs, as a
    // concurrent run would have. Nothing in runAuditDigest has seen it.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await db.insert(auditDigestRuns).values({
      id: "planted",
      accountId: "acct_on",
      periodMonth: PERIOD,
      totals: null,
      status: "sent",
      error: null,
      sentAt: NOW,
      cronRunId: null,
      createdAt: NOW,
    });

    const sent: unknown[] = [];
    const result = await runAuditDigest(
      env(async (m) => {
        sent.push(m);
        return { id: "m" };
      }),
      NOW,
      null,
    );

    expect(result.optedIn).toBe(1); // it got as far as the claim
    expect(result.skippedDuplicate).toBe(1); // and the index refused it
    expect(sent).toHaveLength(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(1);
  });

  it("the SAME account in a DIFFERENT month is a different slot", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await runAuditDigest(env(), NOW, null);
    const october = await runAuditDigest(env(), new Date("2026-10-01T04:00:00.000Z"), null);

    expect(october.sent).toBe(1);
    const rows = await db.select().from(auditDigestRuns);
    expect(rows.map((r) => r.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("TWO accounts in the same month do not collide with each other", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "a_one", { auditAutoRun: true });
    await seedAccount(db, "a_two", { auditAutoRun: true });

    const result = await runAuditDigest(env(), NOW, null);

    expect(result.sent).toBe(2);
  });
});

// ============================================================================
// The comparison, end to end against real recovered_payments
// ============================================================================

describe("316: the comparison runs off the prior month's stored snapshot", () => {
  it("month two reports the change since month one", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });
    await seedRecovery(db, "acct_on", 5_00);

    const bodies: string[] = [];
    const e = env(async (m) => {
      bodies.push((m as { html?: string }).html ?? "");
      return { id: "m" };
    });

    await runAuditDigest(e, NOW, null);
    // A further recovery lands, then October's run fires.
    await seedRecovery(db, "acct_on", 3_00);
    await runAuditDigest(e, new Date("2026-10-01T04:00:00.000Z"), null);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("first digest");
    expect(bodies[1]).toContain("$8.00"); // cumulative
    expect(bodies[1]).toContain("up $3.00"); // the month's change
    expect(bodies[1]).not.toContain("first digest");
  });

  it("only BILLABLE attribution counts, so a stripe_baseline row is not claimed", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });
    await db.insert(failedPayments).values({
      id: "fp_base",
      stripeEventId: "evt_base",
      stripeInvoiceId: "in_base",
      stripeCustomerId: "cus_base",
      customerEmail: "c@example.test",
      amountCents: 900,
      currency: "usd",
      declineCategory: "soft",
      status: "recovered",
      detectedAt: NOW,
      accountId: "acct_on",
    });
    await db.insert(recoveredPayments).values({
      id: "rp_base",
      failedPaymentId: "fp_base",
      recoveredAt: NOW,
      amountCents: 900,
      currency: "usd",
      recoveryMethod: "stripe",
      accountId: "acct_on",
      attributionKind: "stripe_baseline",
    });

    const bodies: string[] = [];
    await runAuditDigest(
      env(async (m) => {
        bodies.push((m as { html?: string }).html ?? "");
        return { id: "m" };
      }),
      NOW,
      null,
    );

    expect(bodies[0]).toContain("No recovered payments are attributed to Foxhound yet");
    expect(bodies[0]).not.toContain("$9.00");
  });
});

// ============================================================================
// 5. Failure rides Session 24's alert machinery
// ============================================================================

describe("316 (5): a failing digest alerts through Session 24's path", () => {
  it("A BROKEN SEND fails the run and writes a cron_alerts row", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const job = CRON_JOBS.find((j) => j.name === "audit-digest")!;
    const outcome = await runCronJob(
      env(async () => {
        throw new Error("email down");
      }),
      job.name,
      job.handler,
    );

    expect(outcome.status).toBe("failed");
    // The alert is the machinery from 313/314, not a new one built here.
    expect(outcome.alert).toEqual({ sent: false, reason: "send_failed", error: "email down" });
    const alerts = await db.select().from(cronAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].cronName).toBe("audit-digest");
    expect(alerts[0].kind).toBe("failure");
  });

  it("ONE MERCHANT'S FAILURE does not stop another merchant's digest", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "a_bad", { auditAutoRun: true, notificationEmail: "bad@merchant.test" });
    await seedAccount(db, "a_good", { auditAutoRun: true, notificationEmail: "good@merchant.test" });

    const delivered: string[] = [];
    await expect(
      runAuditDigest(
        env(async (m) => {
          const to = (m as { to: string }).to;
          if (to === "bad@merchant.test") throw new Error("mailbox full");
          delivered.push(to);
          return { id: "m" };
        }),
        NOW,
        null,
      ),
    ).rejects.toThrow("mailbox full");

    // The good merchant was still served, and the bad one left a trace.
    expect(delivered).toEqual(["good@merchant.test"]);
    const rows = await db.select().from(auditDigestRuns);
    expect(rows.find((r) => r.accountId === "a_bad")!.status).toBe("failed");
    expect(rows.find((r) => r.accountId === "a_bad")!.error).toBe("mailbox full");
    expect(rows.find((r) => r.accountId === "a_good")!.status).toBe("sent");
  });

  it("A FAILED MONTH IS NOT RETRIED next run: the claim stands", async () => {
    // Retry-from-DLQ is out of scope. The row is the trace, and the month is
    // burned rather than silently re-sent.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await expect(
      runAuditDigest(
        env(async () => {
          throw new Error("email down");
        }),
        NOW,
        null,
      ),
    ).rejects.toThrow();

    const retry = await runAuditDigest(env(), NOW, null);
    expect(retry.sent).toBe(0);
    expect(retry.skippedDuplicate).toBe(1);
  });
});

// ============================================================================
// 6. cron-health can judge it (314's unmappable posture)
// ============================================================================

describe("316 (6): cron-health sees the schedule as MAPPABLE", () => {
  it("the digest's schedule resolves to a period, so staleness is judgeable", () => {
    const job = CRON_JOBS.find((j) => j.name === "audit-digest")!;
    // Through the REAL detector: an unmapped schedule reports unknown_schedule,
    // which is the blind spot 314 accepted only because nothing was on one.
    const findings = findStaleCrons([job], new Map([[job.name, new Date(NOW)]]), NOW);
    expect(findings).toEqual([]);

    const overdue = findStaleCrons(
      [job],
      new Map([[job.name, new Date("2026-05-01T04:00:00.000Z")]]),
      NOW,
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0].reason).toBe("overdue");
    expect(overdue[0].reason).not.toBe("unknown_schedule");
  });

  it("a NEVER-RUN digest is reported, which is the billing-monthly class", () => {
    const job = CRON_JOBS.find((j) => j.name === "audit-digest")!;
    const findings = findStaleCrons([job], new Map([[job.name, null]]), NOW);
    expect(findings[0].reason).toBe("never_run");
  });
});

// ============================================================================
// The run message an operator reads
// ============================================================================

describe("316: the run message distinguishes the outcomes", () => {
  it("a zero-send run says WHY it sent nothing", () => {
    const message = describeDigestRun({
      eligible: 3,
      optedIn: 0,
      sent: 0,
      skippedDuplicate: 0,
      skippedNoRecipient: 0,
      failed: 0,
      firstError: null,
    });
    // "0 sent" alone cannot distinguish nobody-opted-in from cron-is-broken.
    expect(message).toContain("3 eligible");
    expect(message).toContain("0 opted in");
  });

  it("a deduped run is visibly different from an empty one", () => {
    const message = describeDigestRun({
      eligible: 1,
      optedIn: 1,
      sent: 0,
      skippedDuplicate: 1,
      skippedNoRecipient: 0,
      failed: 0,
      firstError: null,
    });
    expect(message).toContain("1 already sent this month");
  });
});
