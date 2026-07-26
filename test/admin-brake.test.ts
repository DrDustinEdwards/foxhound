import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { BRAKE_CONFIRM_PHRASES, isBrakeIntent, isConfirmPhraseValid } from "~/lib/admin/brake";
import {
  BRAKE_PAUSE_REASON,
  countStaleBrakeMarkers,
  engageBrake,
  getBrakeStatus,
  listBrakePausedAccountIds,
  releaseBrake,
} from "~/lib/admin/brake.server";
import { setProcessingPaused } from "~/lib/admin/merchants.server";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/cron/registry";
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
    // Not eligible: billing-exempt (ours / comped).
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
  it("pauses exactly the eligible set and leaves demo, exempt and already-paused untouched", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    const result = await engageBrake(db, { actorEmail: ACTOR });

    expect(result.affectedCount).toBe(2);
    expect(result.accountIds.sort()).toEqual(["acc_normal", "acc_normal_2"]);

    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: true, pauseReason: BRAKE_PAUSE_REASON });
    expect(await paused(db, "acc_normal_2")).toEqual({ processingPaused: true, pauseReason: BRAKE_PAUSE_REASON });
    // Untouched, and critically NOT marked, so release cannot claim them.
    expect(await paused(db, "acc_exempt")).toEqual({ processingPaused: false, pauseReason: null });
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

    expect(perAccount).toHaveLength(2);
    expect(umbrella).toHaveLength(1);
    expect(umbrella[0]?.actorEmail).toBe(ACTOR);
    expect((umbrella[0]?.metadata as { pausedCount: number }).pausedCount).toBe(2);
    expect(rows.every((r) => r.actorEmail === ACTOR)).toBe(true);
  });

  it("is idempotent: a second engage pauses nothing more", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    await engageBrake(db, { actorEmail: ACTOR });
    const second = await engageBrake(db, { actorEmail: ACTOR });

    expect(second.affectedCount).toBe(0);
    expect(second.accountIds).toEqual([]);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(2);
    // The umbrella row is still written: hitting the brake twice in an incident
    // is a fact worth keeping, even when it changed nothing.
    const engages = (await db.select().from(schema.adminAuditLog)).filter((r) => r.action === "brake.engage");
    expect(engages).toHaveLength(2);
  });
});

describe("release", () => {
  it("resumes ONLY brake-paused accounts; the individually paused merchant stays paused", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);
    await engageBrake(db, { actorEmail: ACTOR });

    const result = await releaseBrake(db, { actorEmail: ACTOR });

    expect(result.affectedCount).toBe(2);
    expect(await paused(db, "acc_normal")).toEqual({ processingPaused: false, pauseReason: null });
    expect(await paused(db, "acc_normal_2")).toEqual({ processingPaused: false, pauseReason: null });
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

    // Only the still-held one is resumed by the brake.
    expect(result.accountIds).toEqual(["acc_normal_2"]);
  });

  it("re-engaging after a release marks the same accounts again", async () => {
    const { db } = createInMemoryDb();
    await seedAccounts(db);

    await engageBrake(db, { actorEmail: ACTOR });
    await releaseBrake(db, { actorEmail: ACTOR });
    const again = await engageBrake(db, { actorEmail: ACTOR });

    expect(again.affectedCount).toBe(2);
    expect(await listBrakePausedAccountIds(db)).toHaveLength(2);
  });
});

describe("an individual pause never carries the brake marker", () => {
  it("setProcessingPaused(true) leaves pause_reason null, so release cannot claim the row", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.accounts)
      .values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await setProcessingPaused(db, "acc_1", true);

    expect(await paused(db, "acc_1")).toEqual({ processingPaused: true, pauseReason: null });
    const result = await releaseBrake(db, { actorEmail: ACTOR });
    expect(result.affectedCount).toBe(0);
    expect(await paused(db, "acc_1")).toEqual({ processingPaused: true, pauseReason: null });
  });

  it("resuming clears any marker, so no stale marker survives", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.accounts)
      .values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });

    await setProcessingPaused(db, "acc_1", true, BRAKE_PAUSE_REASON);
    await setProcessingPaused(db, "acc_1", false);

    expect(await paused(db, "acc_1")).toEqual({ processingPaused: false, pauseReason: null });
    expect(await countStaleBrakeMarkers(db)).toBe(0);
  });
});

describe("the tick actually honors the pause (the gate the brake depends on)", () => {
  it("a brake-paused account's due steps are not selected by the recovery tick", async () => {
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
    // Only the billing-exempt account is still processed, which is correct:
    // exempt means "never billed", not "never recovered".
    expect(eligibleAfter.map((r) => r.id)).toEqual(["acc_exempt"]);

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
    expect(before.eligibleCount).toBe(2);
    // No cron_config row means ENABLED (gotcha #44), which is the default the
    // panel must render correctly or an operator reads "off" as "on".
    expect(before.tickEnabled).toBe(true);
    expect(before.lastEngage).toBeNull();
    expect(before.lastRelease).toBeNull();

    await engageBrake(db, { actorEmail: ACTOR });

    const after = await getBrakeStatus(db);
    expect(after.brakePausedCount).toBe(2);
    expect(after.individuallyPausedCount).toBe(1);
    expect(after.eligibleCount).toBe(0);
    expect(after.lastEngage?.actorEmail).toBe(ACTOR);
    expect(after.lastEngage?.count).toBe(2);
  });

  it("reads the tick's disabled state from cron_config", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(schema.cronConfig)
      .values({ cronName: RECOVERY_TICK_CRON_NAME, enabled: false, updatedAt: new Date() });

    expect((await getBrakeStatus(db)).tickEnabled).toBe(false);
  });
});
