// The global emergency brake: pause recovery/dispute processing for EVERY
// eligible merchant at once, and lift it again without disturbing merchants who
// were paused for their own reasons.
//
// Why it exists (parity ruling 34): setProcessingPaused is single-account, so
// halting processing during an incident meant clicking through merchants one at
// a time. For a product that sends customer-facing email and force-charges cards
// on a five-minute tick, having no single stop control is the most consequential
// operational gap in the admin surface.
//
// WRITE SHAPE. Each account's pause is the SAME plain, audited write the
// per-merchant toggle already performs (setProcessingPaused + logAdminAction),
// looped, never a bulk UPDATE that would skip the audit trail. Build-notes
// gotcha #25 is explicit that operational writes stay off the money-write DO
// ("routing an operational write through the DO is a mistake in the other
// direction"), and merchants.server.ts records the same reasoning for the
// single-account toggle this batches.
//
// Recorded for the money-path review, because it is a real tension rather than
// an oversight: core.md's standing rule says a write rides the money DO if it
// "gates billing", and processing_paused IS read by app/db/billable.ts, so a
// pause does have a billing effect. It is still not a money write. The DO
// serializes ledger BATCHES (outcomes, invoices, webhook claims); this writes a
// flag on accounts and touches no ledger row. Routing it through the DO would
// also make the brake structurally different from the single-merchant toggle it
// is a batch of, which is worse than either shape on its own.

import { and, count, desc, eq, isNotNull, isNull, ne, notInArray, notLike, or, type SQL } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, adminAuditLog, cronConfig } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { KNOWN_PAUSE_REASONS, PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { setProcessingPaused } from "~/lib/admin/merchants.server";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/cron/registry";

/** accounts.pause_reason value meaning "the global brake paused this row".
 *  Re-exported from the pure module, which owns the vocabulary because the
 *  single-merchant toggle writes it too. */
export const BRAKE_PAUSE_REASON = PAUSE_REASON_BRAKE;

export const BRAKE_ACTION_ENGAGE = "brake.engage";
export const BRAKE_ACTION_RELEASE = "brake.release";
export const BRAKE_ACTION_PAUSE_ACCOUNT = "brake.pause.account";
export const BRAKE_ACTION_RESUME_ACCOUNT = "brake.resume.account";

/**
 * Accounts the brake will pause: not already paused, not billing-exempt, not a
 * demo account.
 *
 * Already-paused is skipped so the brake never takes ownership of a merchant an
 * operator paused deliberately (see the pause_reason comment in schema.ts).
 * billing_exempt is skipped because in practice those are our own and comped
 * accounts, and the brake is a merchant-facing safety control. The demo prefix
 * is the firewall every other job honors (non-negotiable #7), and it is the
 * reason the smoke test asserts ZERO: every live account today is demo or
 * exempt.
 */
export function brakeEligibleCondition(): SQL {
  return and(
    eq(accounts.processingPaused, false),
    eq(accounts.billingExempt, false),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

/** Accounts the brake currently owns: paused AND carrying the brake marker. */
export function brakePausedCondition(): SQL {
  return and(
    eq(accounts.processingPaused, true),
    eq(accounts.pauseReason, BRAKE_PAUSE_REASON),
  ) as SQL;
}

/** Accounts paused outside the brake: paused, carrying anything other than the
 *  brake marker. Release must never touch these.
 *
 *  The null branch is not legacy tolerance, it is required: the demo seeder
 *  writes processing_paused directly, and any row paused before the pause_reason
 *  column existed carries null too. Keying this on "not 'brake'" rather than on
 *  "is 'manual'" means an unrecognised or absent reason is treated as
 *  not-the-brake's, which is the safe direction: the failure mode is a merchant
 *  staying paused, never one being resumed by a release that did not pause it. */
export function individuallyPausedCondition(): SQL {
  return and(
    eq(accounts.processingPaused, true),
    or(isNull(accounts.pauseReason), ne(accounts.pauseReason, PAUSE_REASON_BRAKE)),
  ) as SQL;
}

async function idsWhere(db: Db, where: SQL): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(where);
  return rows.map((r) => r.id);
}

export interface BrakeResult {
  /** Accounts actually transitioned by this call. */
  affectedCount: number;
  accountIds: string[];
  /** The umbrella admin_audit_log row id. */
  auditLogId: string;
}

/**
 * Engage the brake: pause every eligible account, one audited write each, then
 * one umbrella audit row naming the action, the count and the actor.
 *
 * Idempotent by construction rather than by a flag: brakeEligibleCondition
 * excludes already-paused accounts, so a second engage finds an empty set and
 * writes zero account rows. It still records the umbrella entry, because an
 * operator hitting the brake twice during an incident is a fact worth keeping.
 */
export async function engageBrake(
  db: Db,
  input: { actorEmail: string },
): Promise<BrakeResult> {
  const accountIds = await idsWhere(db, brakeEligibleCondition());

  for (const accountId of accountIds) {
    await setProcessingPaused(db, accountId, true, BRAKE_PAUSE_REASON);
    await logAdminAction(db, {
      actorEmail: input.actorEmail,
      action: BRAKE_ACTION_PAUSE_ACCOUNT,
      metadata: { accountId },
    });
  }

  const auditLogId = await logAdminAction(db, {
    actorEmail: input.actorEmail,
    action: BRAKE_ACTION_ENGAGE,
    metadata: { pausedCount: accountIds.length, accountIds },
  });

  return { affectedCount: accountIds.length, accountIds, auditLogId };
}

/**
 * Release the brake: resume ONLY the accounts the brake paused.
 *
 * This asymmetry is the whole design. A merchant paused individually before the
 * brake was engaged carries no marker, so they stay paused, and an operator who
 * lifts a platform-wide brake never silently resumes a merchant who was stopped
 * for cause.
 *
 * A no-op when nothing is engaged, for the same reason engage is: the predicate
 * finds nothing.
 */
export async function releaseBrake(
  db: Db,
  input: { actorEmail: string },
): Promise<BrakeResult> {
  const accountIds = await idsWhere(db, brakePausedCondition());

  for (const accountId of accountIds) {
    await setProcessingPaused(db, accountId, false);
    await logAdminAction(db, {
      actorEmail: input.actorEmail,
      action: BRAKE_ACTION_RESUME_ACCOUNT,
      metadata: { accountId },
    });
  }

  const auditLogId = await logAdminAction(db, {
    actorEmail: input.actorEmail,
    action: BRAKE_ACTION_RELEASE,
    metadata: { resumedCount: accountIds.length, accountIds },
  });

  return { affectedCount: accountIds.length, accountIds, auditLogId };
}

export interface BrakeEvent {
  actorEmail: string;
  at: Date;
  count: number | null;
}

export interface BrakeStatus {
  /** Accounts currently held by the brake. Greater than zero means engaged. */
  brakePausedCount: number;
  /** Accounts paused one at a time; release will not touch these. */
  individuallyPausedCount: number;
  /** Accounts a fresh engage would pause right now. */
  eligibleCount: number;
  /** recovery-tick's cron_config state. A missing row means enabled (gotcha #44). */
  tickEnabled: boolean;
  lastEngage: BrakeEvent | null;
  lastRelease: BrakeEvent | null;
}

function readEvent(
  row: { actorEmail: string; createdAt: Date | null; metadata: unknown } | undefined,
  countKey: "pausedCount" | "resumedCount",
): BrakeEvent | null {
  if (!row?.createdAt) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const raw = meta[countKey];
  return {
    actorEmail: row.actorEmail,
    at: row.createdAt,
    count: typeof raw === "number" ? raw : null,
  };
}

async function countWhere(db: Db, where: SQL): Promise<number> {
  const rows = await db.select({ n: count() }).from(accounts).where(where);
  return rows[0]?.n ?? 0;
}

async function lastAction(db: Db, action: string) {
  const rows = await db
    .select({
      actorEmail: adminAuditLog.actorEmail,
      createdAt: adminAuditLog.createdAt,
      metadata: adminAuditLog.metadata,
    })
    .from(adminAuditLog)
    .where(eq(adminAuditLog.action, action))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(1);
  return rows[0];
}

/** Everything the panel renders. The last engage/release come from
 *  admin_audit_log rather than a second state table: the umbrella rows already
 *  carry actor, time and count, and the audit log is append-only. */
export async function getBrakeStatus(db: Db): Promise<BrakeStatus> {
  const [brakePausedCount, individuallyPausedCount, eligibleCount, tickConfig, engageRow, releaseRow] =
    await Promise.all([
      countWhere(db, brakePausedCondition()),
      countWhere(db, individuallyPausedCondition()),
      countWhere(db, brakeEligibleCondition()),
      db.select().from(cronConfig).where(eq(cronConfig.cronName, RECOVERY_TICK_CRON_NAME)).limit(1),
      lastAction(db, BRAKE_ACTION_ENGAGE),
      lastAction(db, BRAKE_ACTION_RELEASE),
    ]);

  return {
    brakePausedCount,
    individuallyPausedCount,
    eligibleCount,
    // A missing cron_config row means ENABLED (app/lib/cron/gating.ts).
    tickEnabled: tickConfig[0]?.enabled ?? true,
    lastEngage: readEvent(engageRow, "pausedCount"),
    lastRelease: readEvent(releaseRow, "resumedCount"),
  };
}

/** Accounts currently held by the brake, for the panel's detail list. */
export async function listBrakePausedAccountIds(db: Db): Promise<string[]> {
  return idsWhere(db, brakePausedCondition());
}

export interface StaleMarkerCounts {
  /** A reason recorded on a row that is NOT paused. Resume clears the reason in
   *  the same statement as the flag, so this should be unreachable; if it ever
   *  appears, something wrote processing_paused without going through
   *  setProcessingPaused. */
  markedButNotPaused: number;
  /** A PAUSED row carrying a reason outside KNOWN_PAUSE_REASONS. Release matches
   *  the exact 'brake' string, so an unrecognised value is a row release will
   *  silently never touch, and the panel would otherwise report it as merely
   *  "paused outside the brake" and hide the drift. */
  pausedWithUnknownReason: number;
}

/**
 * Both shapes in which the flag and the reason can disagree (review LOW-2).
 *
 * The first version of this probe looked only for a marker on an unpaused row,
 * which is the shape that cannot happen, and missed every shape that can. The
 * point of the probe is to catch a row release will never resume, so it has to
 * look at paused rows too.
 */
export async function countStaleMarkers(db: Db): Promise<StaleMarkerCounts> {
  const [markedButNotPaused, pausedWithUnknownReason] = await Promise.all([
    countWhere(
      db,
      and(eq(accounts.processingPaused, false), isNotNull(accounts.pauseReason)) as SQL,
    ),
    countWhere(
      db,
      and(
        eq(accounts.processingPaused, true),
        isNotNull(accounts.pauseReason),
        notInArray(accounts.pauseReason, [...KNOWN_PAUSE_REASONS]),
      ) as SQL,
    ),
  ]);
  return { markedButNotPaused, pausedWithUnknownReason };
}
