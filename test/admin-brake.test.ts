import { chunked } from "@dustinedwards/site-runtime/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { PAUSE_REASON_MANUAL, isConfirmPhraseValid } from "~/lib/admin/brake";
import {
  BRAKE_CHUNK_ACCOUNTS,
  BRAKE_PAUSE_REASON,
  brakeSubrequestCost,
  countStaleMarkers,
  engageBrake,
  getBrakeStatus,
  listBrakePausedAccountIds,
  releaseBrake,
} from "~/lib/admin/brake.server";
import { buildSetProcessingPaused, setProcessingPaused } from "~/lib/admin/merchants.server";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The emergency brake: release resumes only what the brake paused, never a merchant paused for cause.

const ACTOR = "admin@foxhoundapp.com";

async function seedAccounts(db: Awaited<ReturnType<typeof createInMemoryDb>>["db"]) {
  await db.insert(schema.accounts).values([
    // Eligible: a normal, running merchant.
    { id: "acc_normal", name: "Normal", billingExempt: false, processingPaused: false },
    { id: "acc_normal_2", name: "Normal 2", billingExempt: false, processingPaused: false },
    // Billing-exempt is a billing flag, so the brake still reaches it.
    { id: "acc_exempt", name: "Exempt", billingExempt: true, processingPaused: false },
    // Not eligible: demo, the firewall every job honors.
    {
      id: `${DEMO_ACCOUNT_ID_PREFIX}teamflow`,
      name: "Demo",
      billingExempt: false,
      processingPaused: false,
    },
    // Not eligible: already paused by a human.
    { id: "acc_individually_paused", name: "Held", billingExempt: false, processingPaused: true },
  ]);
}

async function paused(db: Awaited<ReturnType<typeof createInMemoryDb>>["db"], id: string) {
  const rows = await db
    .select({
      processingPaused: schema.accounts.processingPaused,
      pauseReason: schema.accounts.pauseReason,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id));
  return rows[0];
}

describe("confirm phrases (pure)", () => {
  it("tolerates surrounding whitespace only", () => {
    expect(isConfirmPhraseValid("release", "  RESUME ALL  ")).toBe(true);
    expect(isConfirmPhraseValid("release", "RESUME  ALL")).toBe(false);
  });
});

describe("engage", () => {
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
    const engages = (await db.select().from(schema.adminAuditLog)).filter(
      (r) => r.action === "brake.engage",
    );
    expect(engages).toHaveLength(2);
  });
});

describe("batching keeps the brake inside the subrequest budget", () => {
  it("chunks cover every account exactly once, with no empty trailing batch", () => {
    const ids = Array.from({ length: 501 }, (_, i) => `acc_${i}`);
    const chunks = chunked(ids, BRAKE_CHUNK_ACCOUNTS);
    expect(chunks.flat()).toEqual(ids);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks).toHaveLength((brakeSubrequestCost(ids.length) - 2) / 2);
  });
});

describe("a mid-engage failure is diagnosable and releasable", () => {
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
    expect((umbrella[0]!.metadata as { intendedCount: number }).intendedCount).toBe(30);

    // Partial pauses are visible and, critically, MARKED.
    const marked = await listBrakePausedAccountIds(db);
    expect(marked).toHaveLength(25);

    // And release cleans up exactly the marked rows, leaving the rest alone.
    const released = await releaseBrake(db, { actorEmail: ACTOR });
    expect(released.affectedCount).toBe(25);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(0);
    expect(await paused(db, "acc_29")).toEqual({ processingPaused: false, pauseReason: null });
  });
});

describe("engage cannot steal a merchant paused for cause mid-write", () => {
  // The race is simulated at the runBatch seam, between the eligibility read and the chunk write.
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

    expect(await paused(db, VICTIM)).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });

    // 30 were selected, 29 actually transitioned, and the count says 29.
    expect(result.intendedCount).toBe(30);
    expect(result.affectedCount).toBe(29);
    expect(result.accountIds).not.toContain(VICTIM);
    expect(result.error).toBeUndefined();

    // Release leaves the for-cause merchant paused.
    const released = await releaseBrake(db, { actorEmail: ACTOR });
    expect(released.affectedCount).toBe(29);
    expect(await paused(db, VICTIM)).toEqual({
      processingPaused: true,
      pauseReason: PAUSE_REASON_MANUAL,
    });
  });

  it("files no audit evidence for an account it did not actually pause", async () => {
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
});

describe("a manual pause is positively marked and never claimed by release", () => {
  it("resuming clears any marker, so no stale marker survives", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.accounts)
      .values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await buildSetProcessingPaused(db, "acc_1", true, BRAKE_PAUSE_REASON);
    await setProcessingPaused(db, "acc_1", false);

    expect(await paused(db, "acc_1")).toEqual({ processingPaused: false, pauseReason: null });
    expect(await countStaleMarkers(db)).toEqual({
      markedButNotPaused: 0,
      pausedWithUnknownReason: 0,
    });
  });
});

describe("a stale per-merchant form cannot strip the brake marker", () => {
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
});

describe("historical audit rows keep their counts", () => {
  it("reads the legacy metadata keys, so pre-rename engage/release still show a number", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "A", billingExempt: false });
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
});
