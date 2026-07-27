import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  BRAKE_CONFIRM_PHRASES,
  PAUSE_REASON_MANUAL,
  isBrakeIntent,
  isConfirmPhraseValid,
} from "~/lib/admin/brake";
import {
  BRAKE_CHUNK_ACCOUNTS,
  BRAKE_PAUSE_REASON,
  SUBREQUEST_BUDGET,
  brakeSubrequestCost,
  chunkAccountIds,
  countStaleMarkers,
  engageBrake,
  getBrakeStatus,
  listBrakePausedAccountIds,
  releaseBrake,
} from "~/lib/admin/brake.server";
import { setProcessingPaused } from "~/lib/admin/merchants.server";
import { DEMO_ACCOUNT_ID_PREFIX, RECOVERY_TICK_CRON_NAME } from "~/lib/constants";

import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The global emergency brake (parity ruling 34). The load-bearing property is
// the ENGAGE/RELEASE ASYMMETRY: release must resume only what the brake paused,
// never a merchant an operator paused for cause. Every test here runs against
// the real migrated schema, so the pause_reason marker is exercised as shipped.

const ACTOR = "admin@foxhoundapp.com";

async function seedAccounts(db: Awaited<ReturnType<typeof createInMemoryDb>>["db"]) {
  await db.insert(schema.accounts).values([
    // Eligible: a normal, running merchant.
    { id: "acc_normal", name: "Normal", billingExempt: false, processingPaused: false },
    { id: "acc_normal_2", name: "Normal 2", billingExempt: false, processingPaused: false },
    // ELIGIBLE, and the point of review MEDIUM-2: billing-exempt (ours / comped)
    // is a billing flag, never a processing one, so the brake reaches it.
    { id: "acc_exempt", name: "Exempt", billingExempt: true, processingPaused: false },
    // Not eligible: demo, the firewall every job honors.
    { id: `${DEMO_ACCOUNT_ID_PREFIX}teamflow`, name: "Demo", billingExempt: false, processingPaused: false },
    // Not eligible: already paused BY A HUMAN. The whole point of the marker.
    { id: "acc_individually_paused", name: "Held", billingExempt: false, processingPaused: true },
  ]);
}

async function paused(db: Awaited<ReturnType<typeof createInMemoryDb>>["db"], id: string) {
  const rows = await db
    .select({ processingPaused: schema.accounts.processingPaused, pauseReason: schema.accounts.pauseReason })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id));
  return rows[0];
}

describe("confirm phrases (pure)", () => {
  it("requires the exact phrase, case-sensitively", () => {
    expect(isConfirmPhraseValid("engage", "PAUSE ALL")).toBe(true);
    expect(isConfirmPhraseValid("engage", "pause all")).toBe(false);
    expect(isConfirmPhraseValid("engage", "PAUSE")).toBe(false);
    expect(isConfirmPhraseValid("engage", "")).toBe(false);
    // A release phrase must not satisfy an engage.
    expect(isConfirmPhraseValid("engage", BRAKE_CONFIRM_PHRASES.release)).toBe(false);
  });

  it("tolerates surrounding whitespace only", () => {
    expect(isConfirmPhraseValid("release", "  RESUME ALL  ")).toBe(true);
    expect(isConfirmPhraseValid("release", "RESUME  ALL")).toBe(false);
  });

  it("every intent has a distinct phrase, so no control can be confirmed by another's word", () => {
    const phrases = Object.values(BRAKE_CONFIRM_PHRASES);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it("rejects unknown intents before any write path is reached", () => {
    expect(isBrakeIntent("engage")).toBe(true);
    expect(isBrakeIntent("delete-everything")).toBe(false);
  });
});

describe("engage", () => {
  it("pauses exactly the eligible set and leaves demo and already-paused untouched", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    const result = await engageBrake(db, { actorEmail: ACTOR });

    expect(result.affectedCount).toBe(3);
    expect(result.accountIds.sort()).toEqual(["acc_exempt", "acc_normal", "acc_normal_2"]);

    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: true, pauseReason: BRAKE_PAUSE_REASON });
    expect(await paused(db, "acc_normal_2")).toEqual({ processingPaused: true, pauseReason: BRAKE_PAUSE_REASON });
    // The exempt account is paused like any other. Before MEDIUM-2 it was
    // skipped, so a comped merchant's customers kept getting charged through an
    // incident the panel reported as fully stopped.
    expect(await paused(db, "acc_exempt")).toEqual({ processingPaused: true, pauseReason: BRAKE_PAUSE_REASON });
    // Untouched, and critically NOT marked, so release cannot claim them.
    expect(await paused(db, `${DEMO_ACCOUNT_ID_PREFIX}teamflow`)).toEqual({
      processingPaused: false,
      pauseReason: null,
    });
    expect(await paused(db, "acc_individually_paused")).toEqual({ processingPaused: true, pauseReason: null });
  });

  it("writes one audit row per account plus an umbrella row naming count and actor", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    await engageBrake(db, { actorEmail: ACTOR });

    const rows = await db.select().from(schema.adminAuditLog);
    const perAccount = rows.filter((r) => r.action === "brake.pause.account");
    const umbrella = rows.filter((r) => r.action === "brake.engage");

    expect(perAccount).toHaveLength(3);
    expect(umbrella).toHaveLength(1);
    expect(umbrella[0]?.actorEmail).toBe(ACTOR);
    expect((umbrella[0]?.metadata as { intendedCount: number }).intendedCount).toBe(3);
    expect(rows.every((r) => r.actorEmail === ACTOR)).toBe(true);
  });

  it("is idempotent: a second engage pauses nothing more", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    await engageBrake(db, { actorEmail: ACTOR });
    const second = await engageBrake(db, { actorEmail: ACTOR });

    expect(second.affectedCount).toBe(0);
    expect(second.accountIds).toEqual([]);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(3);
    // The umbrella row is still written: hitting the brake twice in an incident
    // is a fact worth keeping, even when it changed nothing.
    const engages = (await db.select().from(schema.adminAuditLog)).filter((r) => r.action === "brake.engage");
    expect(engages).toHaveLength(2);
  });
});

describe("MEDIUM-2: batching keeps the brake inside the subrequest budget", () => {
  it("costs a bounded number of subrequests at 500 accounts, where the unbatched shape did not", () => {
    // Asserted arithmetic, not a comment. The pre-fix shape awaited two round
    // trips per account inside a loop, so the control built for a platform-wide
    // incident was the one least likely to complete during one.
    const unbatched = 1 /* eligibility read */ + 500 * 2 + 1; /* umbrella */
    expect(unbatched).toBeGreaterThan(SUBREQUEST_BUDGET);

    // Two batches per chunk since MEDIUM-1: the guarded flag writes, then audit
    // rows for the ids those writes actually transitioned. That doubled the
    // batch count and bought an audit trail that cannot claim a pause the brake
    // did not perform. 20 chunks at 500 accounts, so 2 + 40.
    expect(brakeSubrequestCost(500)).toBe(42);
    expect(brakeSubrequestCost(500)).toBeLessThan(SUBREQUEST_BUDGET);
    // Headroom survived the doubling, and is still not marginal: even an order
    // of magnitude more merchants fits.
    expect(brakeSubrequestCost(5_000)).toBeLessThan(SUBREQUEST_BUDGET);
  });

  it("chunks cover every account exactly once, with no empty trailing batch", () => {
    const ids = Array.from({ length: 501 }, (_, i) => `acc_${i}`);
    const chunks = chunkAccountIds(ids);
    expect(chunks.flat()).toEqual(ids);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks).toHaveLength((brakeSubrequestCost(ids.length) - 2) / 2);
  });

  it("statements per batch stay well inside a sane D1 batch size", () => {
    // One statement per account per batch now that the flag writes and the audit
    // rows are separate batches.
    expect(BRAKE_CHUNK_ACCOUNTS).toBeLessThanOrEqual(50);
  });

  it("a chunk that transitioned nothing writes no audit batch at all", async () => {
    // The audit batch is skipped, not sent empty, so an idempotent second engage
    // costs the eligibility read and the umbrella row and nothing else.
    const { db } = createInMemoryDb();
    await seedAccounts(db);
    await engageBrake(db, { actorEmail: ACTOR });

    let batchCalls = 0;
    const second = await engageBrake(
      db,
      { actorEmail: ACTOR },
      {
        runBatch: async (d, statements) => {
          batchCalls += 1;
          return d.batch(statements as never);
        },
      },
    );

    expect(second.affectedCount).toBe(0);
    expect(batchCalls).toBe(0);
  });
});

describe("MEDIUM-2: a mid-engage failure is diagnosable and releasable", () => {
  it("keeps the umbrella intent row, commits whole chunks, and release cleans up exactly those", async () => {
    const { db } = createInMemoryDb();
    // 30 eligible accounts spans two chunks at BRAKE_CHUNK_ACCOUNTS=25.
    await db.insert(schema.accounts).values(
      Array.from({ length: 30 }, (_, i) => ({
        id: `acc_${String(i).padStart(2, "0")}`,
        name: `M${i}`,
        billingExempt: false,
        processingPaused: false,
      })),
    );

    // Batch order per chunk is now [flag writes, audit rows], so call 3 is the
    // SECOND chunk's flag write: chunk one is fully committed, chunk two is not
    // written at all.
    let call = 0;
    const result = await engageBrake(
      db,
      { actorEmail: ACTOR },
      {
        runBatch: async (d, statements) => {
          call += 1;
          if (call === 3) throw new Error("simulated D1 chunk failure");
          return d.batch(statements as never);
        },
      },
    );

    // Reported honestly: intended 30, committed 25.
    expect(result.intendedCount).toBe(30);
    expect(result.affectedCount).toBe(25);
    expect(result.error).toMatch(/simulated D1 chunk failure/);
    // Chunk one's evidence rows landed with it.
    const perAccount = (await db.select().from(schema.adminAuditLog)).filter(
      (r) => r.action === "brake.pause.account",
    );
    expect(perAccount).toHaveLength(25);

    // The umbrella INTENT row survives, which is the point of writing it first.
    const umbrella = (await db.select().from(schema.adminAuditLog)).filter(
      (r) => r.action === "brake.engage",
    );
    expect(umbrella).toHaveLength(1);
    expect((umbrella[0]?.metadata as { intendedCount: number }).intendedCount).toBe(30);

    // Partial pauses are visible and, critically, MARKED.
    const marked = await listBrakePausedAccountIds(db);
    expect(marked).toHaveLength(25);

    // And release cleans up exactly the marked rows, leaving the rest alone.
    const released = await releaseBrake(db, { actorEmail: ACTOR });
    expect(released.affectedCount).toBe(25);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(0);
    expect(await paused(db, "acc_29")).toEqual({ processingPaused: false, pauseReason: null });
  });

  it("counts a chunk whose flag writes landed but whose audit rows did not", async () => {
    // The failure mode the split batches introduced. The accounts ARE paused and
    // marked, so the count must include them and release must clean them up; the
    // safe direction is over-reporting the pause, never under-reporting it and
    // leaving marked rows nobody knows to release.
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    let call = 0;
    const result = await engageBrake(
      db,
      { actorEmail: ACTOR },
      {
        runBatch: async (d, statements) => {
          call += 1;
          if (call === 2) throw new Error("audit batch failed");
          return d.batch(statements as never);
        },
      },
    );

    expect(result.affectedCount).toBe(3);
    expect(result.error).toMatch(/audit batch failed/);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(3);
    expect(
      (await db.select().from(schema.adminAuditLog)).filter((r) => r.action === "brake.pause.account"),
    ).toHaveLength(0);
    expect((await releaseBrake(db, { actorEmail: ACTOR })).affectedCount).toBe(3);
  });
});

describe("MEDIUM-1: engage cannot steal a merchant paused for cause mid-write", () => {
  // The invariant the whole design exists for, tested in the CONCURRENT
  // direction for the first time. Every other test here seeds a static fixture
  // and then engages, which only ever exercises the eligibility SELECT. The
  // defect was in the UPDATE: engage read its ids once and wrote them in chunks,
  // so a pause landing in that window was overwritten with the brake marker and
  // resumed by the next release.
  //
  // The race is SIMULATED, not asserted around: the runBatch seam is the real
  // pause point between the eligibility read and the chunk write, and the manual
  // pause is a real setProcessingPaused against the real schema.
  it("a for-cause pause landing between the read and the write survives, and release never resumes it", async () => {
    const { db } = createInMemoryDb();
    // 30 eligible accounts spans two chunks at BRAKE_CHUNK_ACCOUNTS=25, so the
    // victim sits in a chunk that has not been written when the pause lands.
    await db.insert(schema.accounts).values(
      Array.from({ length: 30 }, (_, i) => ({
        id: `acc_${String(i).padStart(2, "0")}`,
        name: `M${i}`,
        billingExempt: false,
        processingPaused: false,
      })),
    );
    const VICTIM = "acc_29"; // second chunk

    let batchCalls = 0;
    const result = await engageBrake(
      db,
      { actorEmail: ACTOR },
      {
        runBatch: async (d, statements) => {
          // Operator B pauses a merchant for suspected fraud through
          // /admin/merchants/:id while operator A's engage is mid-flight. It
          // lands after the eligibility read and before the victim's chunk.
          batchCalls += 1;
          if (batchCalls === 1) await setProcessingPaused(d, VICTIM, true);
          return d.batch(statements as never);
        },
      },
    );

    // The pause stands, with ITS OWN reason. Before the write-time guard this
    // read { processingPaused: true, pauseReason: 'brake' }.
    expect(await paused(db, VICTIM)).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });

    // 30 were selected, 29 actually transitioned, and the count says 29.
    expect(result.intendedCount).toBe(30);
    expect(result.affectedCount).toBe(29);
    expect(result.accountIds).not.toContain(VICTIM);
    expect(result.error).toBeUndefined();

    // The whole point: release leaves the for-cause merchant paused. Under the
    // pre-fix write this resumed them and their due retry steps charged cards on
    // the next tick, with operator B never told.
    const released = await releaseBrake(db, { actorEmail: ACTOR });
    expect(released.affectedCount).toBe(29);
    expect(await paused(db, VICTIM)).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });
  });

  it("files no audit evidence for an account it did not actually pause", async () => {
    // A count that excludes the skipped row but a per-account audit row that
    // claims it was paused would just move the lie from the panel to the log.
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    let batchCalls = 0;
    await engageBrake(
      db,
      { actorEmail: ACTOR },
      {
        runBatch: async (d, statements) => {
          batchCalls += 1;
          if (batchCalls === 1) await setProcessingPaused(d, "acc_normal", true);
          return d.batch(statements as never);
        },
      },
    );

    const perAccount = (await db.select().from(schema.adminAuditLog)).filter(
      (r) => r.action === "brake.pause.account",
    );
    expect(perAccount.map((r) => (r.metadata as { accountId: string }).accountId)).toEqual([
      "acc_normal_2",
      "acc_exempt",
    ]);
  });

  it("release skips a merchant resumed by hand mid-release, and does not count them", async () => {
    // The same race in the other direction. Symmetric guard, symmetric count.
    const { db } = createInMemoryDb();
    await seedAccounts(db);
    await engageBrake(db, { actorEmail: ACTOR });

    let batchCalls = 0;
    const released = await releaseBrake(
      db,
      { actorEmail: ACTOR },
      {
        runBatch: async (d, statements) => {
          batchCalls += 1;
          if (batchCalls === 1) await setProcessingPaused(d, "acc_normal", false);
          return d.batch(statements as never);
        },
      },
    );

    expect(released.intendedCount).toBe(3);
    expect(released.affectedCount).toBe(2);
    expect(released.accountIds).toEqual(["acc_normal_2", "acc_exempt"]);
  });
});

describe("release", () => {
  it("resumes ONLY brake-paused accounts; the individually paused merchant stays paused", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);
    await engageBrake(db, { actorEmail: ACTOR });

    const result = await releaseBrake(db, { actorEmail: ACTOR });

    expect(result.affectedCount).toBe(3);
    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: false, pauseReason: null });
    expect(await paused(db, "acc_normal_2")).toEqual({ processingPaused: false, pauseReason: null });
    expect(await paused(db, "acc_exempt")).toEqual({ processingPaused: false, pauseReason: null });
    // THE test. A blanket "unpause everything" release would resume this row and
    // silently undo an operator's deliberate hold.
    expect(await paused(db, "acc_individually_paused")).toEqual({ processingPaused: true, pauseReason: null });
  });

  it("is a no-op when nothing is engaged", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    const result = await releaseBrake(db, { actorEmail: ACTOR });

    expect(result.affectedCount).toBe(0);
    expect(await paused(db, "acc_individually_paused")).toEqual({ processingPaused: true, pauseReason: null });
    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: false, pauseReason: null });
  });

  it("does not reclaim a merchant an operator individually resumed while the brake was engaged", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);
    await engageBrake(db, { actorEmail: ACTOR });

    // A human overrides the hold for one merchant mid-incident.
    await setProcessingPaused(db, "acc_normal", false);
    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: false, pauseReason: null });

    const result = await releaseBrake(db, { actorEmail: ACTOR });

    // Only the still-held ones are resumed by the brake.
    expect(result.accountIds).toEqual(["acc_normal_2", "acc_exempt"]);
  });

  it("re-engaging after a release marks the same accounts again", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    await engageBrake(db, { actorEmail: ACTOR });
    await releaseBrake(db, { actorEmail: ACTOR });
    const again = await engageBrake(db, { actorEmail: ACTOR });

    expect(again.affectedCount).toBe(3);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(3);
  });
});

describe("a manual pause is positively marked and never claimed by release", () => {
  it("pausing an UNPAUSED account stamps 'manual', so release cannot claim the row", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.accounts)
      .values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await setProcessingPaused(db, "acc_1", true);

    expect(await paused(db, "acc_1")).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });
    const result = await releaseBrake(db, { actorEmail: ACTOR });
    expect(result.affectedCount).toBe(0);
    expect(await paused(db, "acc_1")).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });
  });

  it("resuming clears any marker, so no stale marker survives", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.accounts)
      .values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await setProcessingPaused(db, "acc_1", true, BRAKE_PAUSE_REASON);
    await setProcessingPaused(db, "acc_1", false);

    expect(await paused(db, "acc_1")).toEqual({ processingPaused: false, pauseReason: null });
    expect(await countStaleMarkers(db)).toEqual({
      markedButNotPaused: 0,
      pausedWithUnknownReason: 0,
    });
  });
});

describe("LOW-2: a stale per-merchant form cannot strip the brake marker", () => {
  it("re-pausing an already-brake-paused account PRESERVES the marker, and release still resumes it", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);
    await engageBrake(db, { actorEmail: ACTOR });
    expect(await paused(db, "acc_normal")).toEqual({
      processingPaused: true,
      pauseReason: BRAKE_PAUSE_REASON,
    });

    // The exact stale-form replay: /admin/merchants/:id rendered BEFORE the
    // brake engaged carries nextPaused=true, and the operator submits it after.
    // This used to overwrite the marker with null and strand the merchant.
    await setProcessingPaused(db, "acc_normal", true);

    expect(await paused(db, "acc_normal")).toEqual({
      processingPaused: true,
      pauseReason: BRAKE_PAUSE_REASON,
    });

    const result = await releaseBrake(db, { actorEmail: ACTOR });
    expect(result.accountIds.sort()).toEqual(["acc_exempt", "acc_normal", "acc_normal_2"]);
    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: false, pauseReason: null });
  });

  it("a manual pause on an already-manually-paused account is idempotent", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.accounts)
      .values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await setProcessingPaused(db, "acc_1", true);
    await setProcessingPaused(db, "acc_1", true);

    expect(await paused(db, "acc_1")).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });
  });
});

describe("stale-marker probe catches BOTH disagreeing shapes", () => {
  it("flags a reason recorded on a row that is not paused", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({
      id: "acc_1",
      name: "Acme",
      billingExempt: false,
      processingPaused: false,
      pauseReason: BRAKE_PAUSE_REASON,
    });

    expect(await countStaleMarkers(db)).toEqual({
      markedButNotPaused: 1,
      pausedWithUnknownReason: 0,
    });
  });

  it("flags a PAUSED row carrying a reason release will never match", async () => {
    // The shape the first probe missed entirely: release keys on the exact
    // 'brake' string, so this row is paused forever and nothing said so.
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({
      id: "acc_1",
      name: "Acme",
      billingExempt: false,
      processingPaused: true,
      pauseReason: "legacy_import",
    });

    expect(await countStaleMarkers(db)).toEqual({
      markedButNotPaused: 0,
      pausedWithUnknownReason: 1,
    });
    // ...and it is still correctly excluded from release.
    expect((await releaseBrake(db, { actorEmail: ACTOR })).affectedCount).toBe(0);
  });

  it("does not flag either known reason in its correct shape", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values([
      { id: "acc_b", name: "B", billingExempt: false, processingPaused: true, pauseReason: BRAKE_PAUSE_REASON },
      { id: "acc_m", name: "M", billingExempt: false, processingPaused: true, pauseReason: PAUSE_REASON_MANUAL },
      { id: "acc_n", name: "N", billingExempt: false, processingPaused: true, pauseReason: null },
    ]);

    expect(await countStaleMarkers(db)).toEqual({
      markedButNotPaused: 0,
      pausedWithUnknownReason: 0,
    });
  });
});

describe("the tick's account predicate honors the pause", () => {
  // Named for what it asserts. The composed selection query and the real mid-run
  // guard are driven end to end in test/brake-tick-integration.test.ts; this one
  // covers the predicate in isolation (review LOW-3: the old name overclaimed).
  it("a brake-paused account drops out of accountProcessingEligibleCondition", async () => {
    const { db, sqlite } = createInMemoryDb();
    await seedAccounts(db);

    // The tick's own account-level predicate, applied verbatim.
    const eligibleBefore = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(accountProcessingEligibleCondition());
    expect(eligibleBefore.map((r) => r.id).sort()).toEqual(["acc_exempt", "acc_normal", "acc_normal_2"]);

    await engageBrake(db, { actorEmail: ACTOR });

    const eligibleAfter = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(accountProcessingEligibleCondition());
    // Nothing is still processed, INCLUDING the billing-exempt account (review
    // MEDIUM-2). The tick's predicate has always ignored billing_exempt, so the
    // only reason an exempt merchant kept charging cards through an engage was
    // that the brake's own predicate excluded them from being paused at all.
    expect(eligibleAfter.map((r) => r.id)).toEqual([]);

    // And the column the predicate reads is really set on disk.
    const raw = sqlite.prepare("select processing_paused, pause_reason from accounts where id = ?").get("acc_normal");
    expect(raw).toEqual({ processing_paused: 1, pause_reason: BRAKE_PAUSE_REASON });
  });
});

describe("status panel", () => {
  it("reports brake-paused, individually-paused, eligible, and tick state", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    const before = await getBrakeStatus(db);
    expect(before.brakePausedCount).toBe(0);
    expect(before.individuallyPausedCount).toBe(1);
    expect(before.eligibleCount).toBe(3);
    // No cron_config row means ENABLED (gotcha #44), which is the default the
    // panel must render correctly or an operator reads "off" as "on".
    expect(before.tickEnabled).toBe(true);
    expect(before.lastEngage).toBeNull();
    expect(before.lastRelease).toBeNull();

    await engageBrake(db, { actorEmail: ACTOR });

    const after = await getBrakeStatus(db);
    expect(after.brakePausedCount).toBe(3);
    expect(after.individuallyPausedCount).toBe(1);
    expect(after.eligibleCount).toBe(0);
    expect(after.lastEngage?.actorEmail).toBe(ACTOR);
    expect(after.lastEngage?.count).toBe(3);
  });

  it("reads the tick's disabled state from cron_config", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.cronConfig)
      .values({ cronName: RECOVERY_TICK_CRON_NAME, enabled: false, updatedAt: new Date() });

    expect((await getBrakeStatus(db)).tickEnabled).toBe(false);
  });
});

describe("LOW-1: cancelled accounts are outside the brake", () => {
  it("engage skips a cancelled account, so its owed fees are not deferred by the hold", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values([
      { id: "acc_live", name: "Live", billingExempt: false, processingPaused: false },
      {
        id: "acc_cancelled",
        name: "Gone",
        billingExempt: false,
        processingPaused: false,
        cancelledAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);

    const result = await engageBrake(db, { actorEmail: ACTOR });

    expect(result.accountIds).toEqual(["acc_live"]);
    // processing_paused also gates billing, and a cancelled account's matured
    // unbilled fees are deliberately still billable, so the brake must not take
    // ownership of this row.
    expect(await paused(db, "acc_cancelled")).toEqual({
      processingPaused: false,
      pauseReason: null,
    });
  });
});

describe("LOW-D: historical audit rows keep their counts", () => {
  it("reads the legacy metadata keys, so pre-rename engage/release still show a number", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "A", billingExempt: false });
    // Exactly the shape written before the umbrella row became intent-first.
    await db.insert(schema.adminAuditLog).values([
      {
        id: "a1",
        actorEmail: ACTOR,
        action: "brake.engage",
        metadata: { pausedCount: 7 },
        createdAt: new Date("2026-07-26T16:58:00.000Z"),
      },
      {
        id: "a2",
        actorEmail: ACTOR,
        action: "brake.release",
        metadata: { resumedCount: 7 },
        createdAt: new Date("2026-07-26T16:59:00.000Z"),
      },
    ]);

    const status = await getBrakeStatus(db);
    expect(status.lastEngage?.count).toBe(7);
    expect(status.lastRelease?.count).toBe(7);
  });

  it("prefers the current key when both are present", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.adminAuditLog).values({
      id: "a1",
      actorEmail: ACTOR,
      action: "brake.engage",
      metadata: { intendedCount: 3, pausedCount: 99 },
      createdAt: new Date("2026-07-26T17:00:00.000Z"),
    });
    expect((await getBrakeStatus(db)).lastEngage?.count).toBe(3);
  });
});
