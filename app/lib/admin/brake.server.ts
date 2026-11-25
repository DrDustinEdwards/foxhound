// The global emergency brake: pause recovery/dispute processing for EVERY
// eligible merchant at once, and lift it again without disturbing merchants who
// were paused for their own reasons.
//
// Each account's pause is the SAME plain, audited write the per-merchant toggle
// already performs (setProcessingPaused + logAdminAction), looped, never a bulk
// UPDATE that would skip the audit trail.

import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  notInArray,
  notLike,
  or,
  type SQL,
} from "drizzle-orm";

import { chunked } from "@dustinedwards/site-runtime/d1";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import { countRows } from "~/db/scope";
import { accounts, adminAuditLog, cronConfig } from "~/db";
import { buildAdminAuditLogInsert, logAdminAction } from "~/lib/admin/audit.server";
import { KNOWN_PAUSE_REASONS, PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { buildSetProcessingPaused } from "~/lib/admin/merchant-controls.server";
import { DEMO_ACCOUNT_ID_PREFIX, RECOVERY_TICK_CRON_NAME } from "~/lib/constants";

/**
 * accounts.pause_reason value meaning "the global brake paused this row".
 * Re-exported from the pure module, which owns the vocabulary because the
 * single-merchant toggle writes it too.
 */
export const BRAKE_PAUSE_REASON = PAUSE_REASON_BRAKE;

const BRAKE_ACTION_ENGAGE = "brake.engage";
const BRAKE_ACTION_RELEASE = "brake.release";
const BRAKE_ACTION_PAUSE_ACCOUNT = "brake.pause.account";
const BRAKE_ACTION_RESUME_ACCOUNT = "brake.resume.account";

/**
 * Accounts the brake will pause: EVERY account except demo-prefixed, already
 * paused, and canceled. Three exclusions, and no others.
 *
 * Already-paused is skipped so the brake never takes ownership of a merchant an
 * operator paused deliberately (see the pause_reason comment in schema.ts).
 *
 * Exempt means Foxhound does not charge THAT MERCHANT fees; it says nothing
 * about whether their customers should keep being charged.
 */
function brakeEligibleCondition(): SQL {
  return and(
    eq(accounts.processingPaused, false),
    isNull(accounts.cancelledAt),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

/** Accounts the brake currently owns: paused AND carrying the brake marker. */
function brakePausedCondition(): SQL {
  return and(
    eq(accounts.processingPaused, true),
    eq(accounts.pauseReason, BRAKE_PAUSE_REASON),
  ) as SQL;
}

/**
 * Accounts paused outside the brake: paused, carrying anything other than the
 * brake marker. Release must never touch these.
 */
function individuallyPausedCondition(): SQL {
  return and(
    eq(accounts.processingPaused, true),
    or(isNull(accounts.pauseReason), ne(accounts.pauseReason, PAUSE_REASON_BRAKE)),
  ) as SQL;
}

async function idsWhere(db: Db, where: SQL): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(where);
  return rows.map((r) => r.id);
}

/**
 * Accounts per db.batch. A chunk now costs TWO batches, not one: the flag
 * writes go first, and only the ids they actually transitioned get audit rows.
 * Each account contributes one statement to each batch, so a chunk is 25
 * statements per batch.
 */
export const BRAKE_CHUNK_ACCOUNTS = 25;

/**
 * The Workers subrequest ceiling this batching is sized against (paid plan).
 */
export const SUBREQUEST_BUDGET = 1000;

/**
 * How many account ids the umbrella row samples into its metadata. The
 * per-account rows carry every id, so this is a readability cap on one blob,
 * not a loss of audit detail.
 */
const AUDIT_ID_SAMPLE_LIMIT = 100;

/**
 * Subrequests one engage/release costs: the eligibility read, the umbrella row,
 * then TWO batches per chunk. Exported so the budget is a computed fact.
 */
export function brakeSubrequestCost(
  accountCount: number,
  size: number = BRAKE_CHUNK_ACCOUNTS,
): number {
  return 2 + 2 * Math.ceil(accountCount / size);
}

function sampleIds(ids: string[]) {
  return {
    accountIds: ids.slice(0, AUDIT_ID_SAMPLE_LIMIT),
    accountIdsTruncated: ids.length > AUDIT_ID_SAMPLE_LIMIT,
  };
}

export interface BrakeResult {
  /**
   * Accounts actually transitioned by this call, counted from the flag writes'
   * RETURNING rows. On a partial failure this is the number that committed, NOT
   * the number intended; on a clean run it can still be lower than
   * `intendedCount`, because a row that stopped matching the guard between the
   * eligibility read and its chunk write is skipped.
   */
  affectedCount: number;
  accountIds: string[];
  /**
   * The umbrella admin_audit_log row id. Written FIRST, so it exists even when
   * the account writes fail partway.
   */
  auditLogId: string;
  /**
   * Accounts this call set out to transition. Differs from affectedCount only
   * on a partial failure.
   */
  intendedCount: number;
  /**
   * Present when a chunk failed. The committed chunks stand and the marker
   * makes them releasable; this says the operator should look.
   */
  error?: string;
}

/**
 * Injectable batch executor, so a chunk failure can be simulated in a test
 * without a broken D1. Defaults to the real db.batch.
 */
export interface BrakeDeps {
  runBatch: (db: Db, statements: BatchStatements) => Promise<unknown>;
}
type BatchStatements = BatchItem<"sqlite">[];

// db.batch's signature demands a non-empty tuple. The caller already guarantees
// that (an empty group is skipped), so the assertion is confined to this one
// line rather than smeared across every call site.
const defaultRunBatch: BrakeDeps["runBatch"] = (db, statements) =>
  db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

/**
 * Ids a flag batch actually changed, read from each statement's RETURNING rows.
 */
function transitionedIds(batchResult: unknown): string[] {
  if (!Array.isArray(batchResult)) {
    throw new Error("brake: batch result was not an array, cannot tell which rows transitioned");
  }
  return batchResult.flatMap((rows) => {
    if (!Array.isArray(rows)) {
      throw new Error("brake: a flag write returned no RETURNING rows");
    }
    return rows.map((row) => {
      const id = (row as { id?: unknown }).id;
      if (typeof id !== "string") throw new Error("brake: a RETURNING row carried no id");
      return id;
    });
  });
}

/**
 * Apply one transition to every id, umbrella-audit-row FIRST, then per chunk a
 * batch of guarded flag writes followed by a batch of audit rows for the ids
 * those writes actually moved.
 *
 * If a chunk then fails, what survives is an intent row, a partial set of
 * marked rows, and a release that resumes exactly the marked ones.
 */
async function applyBrakeTransition(
  db: Db,
  input: {
    accountIds: string[];
    actorEmail: string;
    umbrellaAction: string;
    perAccountAction: string;
    paused: boolean;
    reason: string | null;
    /**
     * Re-applied server-side in each flag write's WHERE, so the predicate that
     * selected an account still has to hold when its row is written.
     */
    guard: SQL;
  },
  deps: Partial<BrakeDeps> = {},
): Promise<BrakeResult> {
  const runBatch = deps.runBatch ?? defaultRunBatch;
  const { accountIds } = input;

  const auditLogId = await logAdminAction(db, {
    actorEmail: input.actorEmail,
    action: input.umbrellaAction,
    metadata: { intendedCount: accountIds.length, ...sampleIds(accountIds) },
  });

  const committed: string[] = [];
  for (const group of chunked(accountIds, BRAKE_CHUNK_ACCOUNTS)) {
    const flagWrites: BatchStatements = group.map((accountId) =>
      buildSetProcessingPaused(db, accountId, input.paused, input.reason, input.guard),
    );
    if (flagWrites.length === 0) continue;
    try {
      const moved = transitionedIds(await runBatch(db, flagWrites));
      // Pushed before the audit batch: these rows ARE written and marked, so
      // they are releasable whether or not their evidence rows land.
      committed.push(...moved);
      if (moved.length > 0) {
        const auditRows: BatchStatements = moved.map(
          (accountId) =>
            buildAdminAuditLogInsert(db, {
              actorEmail: input.actorEmail,
              action: input.perAccountAction,
              metadata: { accountId },
            }).statement,
        );
        await runBatch(db, auditRows);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "brake batch failed";
      console.error(`brake ${input.umbrellaAction} chunk failed:`, message);
      return {
        affectedCount: committed.length,
        accountIds: committed,
        auditLogId,
        intendedCount: accountIds.length,
        error: message,
      };
    }
  }

  return {
    affectedCount: committed.length,
    accountIds: committed,
    auditLogId,
    intendedCount: accountIds.length,
  };
}

/**
 * Engage the brake: pause every eligible account, one audited write each, then
 * one umbrella audit row naming the action, the count and the actor.
 *
 * This is the same shape as the recovery tick's mid-run guard and the fee
 * sweep's pre-charge re-read: re-evaluate the selecting predicate, never a
 * paraphrase of it, so the two can never disagree about what eligible means.
 */
export async function engageBrake(
  db: Db,
  input: { actorEmail: string },
  deps: Partial<BrakeDeps> = {},
): Promise<BrakeResult> {
  const accountIds = await idsWhere(db, brakeEligibleCondition());
  return applyBrakeTransition(
    db,
    {
      accountIds,
      actorEmail: input.actorEmail,
      umbrellaAction: BRAKE_ACTION_ENGAGE,
      perAccountAction: BRAKE_ACTION_PAUSE_ACCOUNT,
      paused: true,
      reason: BRAKE_PAUSE_REASON,
      guard: brakeEligibleCondition(),
    },
    deps,
  );
}

/**
 * Release the brake: resume ONLY the accounts the brake paused.
 *
 * A merchant paused individually before the brake was engaged carries no
 * marker, so they stay paused, and an operator who lifts a platform-wide brake
 * never silently resumes a merchant who was stopped for cause.
 */
export async function releaseBrake(
  db: Db,
  input: { actorEmail: string },
  deps: Partial<BrakeDeps> = {},
): Promise<BrakeResult> {
  const accountIds = await idsWhere(db, brakePausedCondition());
  return applyBrakeTransition(
    db,
    {
      accountIds,
      actorEmail: input.actorEmail,
      umbrellaAction: BRAKE_ACTION_RELEASE,
      perAccountAction: BRAKE_ACTION_RESUME_ACCOUNT,
      paused: false,
      reason: null,
      guard: brakePausedCondition(),
    },
    deps,
  );
}

interface BrakeEvent {
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
  /** recovery-tick's cron_config state. A missing row means enabled. */
  tickEnabled: boolean;
  lastEngage: BrakeEvent | null;
  lastRelease: BrakeEvent | null;
}

/**
 * Metadata keys a count may live under, newest first.
 *
 * The values were never lost, just unreachable from the panel.
 */
const COUNT_KEYS = ["intendedCount", "pausedCount", "resumedCount"] as const;

function readEvent(
  row: { actorEmail: string; createdAt: Date | null; metadata: unknown } | undefined,
): BrakeEvent | null {
  if (!row?.createdAt) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const raw = COUNT_KEYS.map((k) => meta[k]).find((v) => typeof v === "number");
  return {
    actorEmail: row.actorEmail,
    at: row.createdAt,
    count: typeof raw === "number" ? raw : null,
  };
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

/**
 * Everything the panel renders. The last engage/release come from
 * admin_audit_log rather than a second state table: the umbrella rows already
 * carry actor, time and and the audit log is append-only.
 */
export async function getBrakeStatus(db: Db): Promise<BrakeStatus> {
  const [
    brakePausedCount,
    individuallyPausedCount,
    eligibleCount,
    tickConfig,
    engageRow,
    releaseRow,
  ] = await Promise.all([
    countRows(db, accounts, brakePausedCondition()),
    countRows(db, accounts, individuallyPausedCondition()),
    countRows(db, accounts, brakeEligibleCondition()),
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
    lastEngage: readEvent(engageRow),
    lastRelease: readEvent(releaseRow),
  };
}

/** Accounts currently held by the brake, for the panel's detail list. */
export async function listBrakePausedAccountIds(db: Db): Promise<string[]> {
  return idsWhere(db, brakePausedCondition());
}

export interface StaleMarkerCounts {
  /**
   * A reason recorded on a row that is NOT paused. Resume clears the reason in
   * the same statement as the flag, so this should be unreachable; if it ever
   * appears, something wrote processing_paused without going through
   * setProcessingPaused.
   */
  markedButNotPaused: number;
  /**
   * A PAUSED row carrying a reason outside KNOWN_PAUSE_REASONS. Release matches
   * the exact 'brake' string, so an unrecognized value is a row release will
   * silently never touch, and the panel would otherwise report it as merely
   * "paused outside the brake" and hide the drift.
   */
  pausedWithUnknownReason: number;
}

/**
 * Both shapes in which the flag and the reason can disagree.
 *
 * The first version of this probe looked only for a marker on an unpaused row,
 * which is the shape that cannot happen, and missed every shape that can. The
 * point of the probe is to catch a row release will never resume, so it has to
 * look at paused rows too.
 */
export async function countStaleMarkers(db: Db): Promise<StaleMarkerCounts> {
  const [markedButNotPaused, pausedWithUnknownReason] = await Promise.all([
    countRows(
      db,
      accounts,
      and(eq(accounts.processingPaused, false), isNotNull(accounts.pauseReason)) as SQL,
    ),
    countRows(
      db,
      accounts,
      and(
        eq(accounts.processingPaused, true),
        isNotNull(accounts.pauseReason),
        notInArray(accounts.pauseReason, [...KNOWN_PAUSE_REASONS]),
      ) as SQL,
    ),
  ]);
  return { markedButNotPaused, pausedWithUnknownReason };
}
