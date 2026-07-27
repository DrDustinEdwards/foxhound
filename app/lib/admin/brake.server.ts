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
// WHERE THE MARKER INVARIANT ACTUALLY LIVES. "Release never resumes a merchant
// paused for cause" is enforced in the WHERE of each flag write, not in the
// eligibility SELECT. Two reviews certified the leak unreachable on the grounds
// that engage skips already-paused rows; that is true of the SELECT and was
// false of the UPDATE, which wrote the brake marker over whatever an operator
// had set in between (review MEDIUM-1). If you find yourself arguing this is
// safe because of what the select returns, the argument is the one that failed
// twice: check the write.
//
// Recorded because it is a real tension rather than an oversight: core.md's
// standing rule says a write rides the money DO if it "gates billing", and
// processing_paused IS read by app/db/billable.ts, so a pause does have a
// billing effect.
//
// The decisive argument is not precedent, it is that the DO CANNOT CLOSE THIS
// RACE. executeMoneyWrite serializes on idFromName(accountId): it orders WRITES
// to one account. The hazard here is read-then-act across two modules
// (getBillableRecoveries reads, then executeMoneyWrite commits), and serializing
// the pause write cannot make a foreign module's earlier read atomic with its
// later commit. Routing the pause through the DO would cost consistency with the
// single-merchant toggle this is a batch of, and buy nothing.
//
// What actually makes the race safe is a second gate: each per-account billable
// query re-applies accountBillingEligibleCondition as an INNER JOIN, so a pause
// landing before the query yields zero rows and no invoice. A pause landing after
// the build produces an invoice of matured, attributed, unrefunded recoveries
// that were genuinely owed, which is not an overcharge. Double-billing is
// impossible in any interleaving: the not-already-billed left join is structural
// and the idempotency key is pause-independent. A pause only ever defers.

import { and, count, desc, eq, isNotNull, isNull, ne, notInArray, notLike, or, type SQL } from "drizzle-orm";

import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import { accounts, adminAuditLog, cronConfig } from "~/db";
import { buildAdminAuditLogInsert, logAdminAction } from "~/lib/admin/audit.server";
import { KNOWN_PAUSE_REASONS, PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { buildSetProcessingPaused } from "~/lib/admin/merchants.server";
import { DEMO_ACCOUNT_ID_PREFIX, RECOVERY_TICK_CRON_NAME } from "~/lib/constants";


/** accounts.pause_reason value meaning "the global brake paused this row".
 *  Re-exported from the pure module, which owns the vocabulary because the
 *  single-merchant toggle writes it too. */
export const BRAKE_PAUSE_REASON = PAUSE_REASON_BRAKE;

export const BRAKE_ACTION_ENGAGE = "brake.engage";
export const BRAKE_ACTION_RELEASE = "brake.release";
export const BRAKE_ACTION_PAUSE_ACCOUNT = "brake.pause.account";
export const BRAKE_ACTION_RESUME_ACCOUNT = "brake.resume.account";

/**
 * Accounts the brake will pause: EVERY account except demo-prefixed, already
 * paused, and cancelled. Three exclusions, and no others.
 *
 * Already-paused is skipped so the brake never takes ownership of a merchant an
 * operator paused deliberately (see the pause_reason comment in schema.ts). The
 * demo prefix is the firewall every other job honors (non-negotiable #7).
 *
 * billing_exempt is NOT an exclusion (review MEDIUM-2). It used to be, defended
 * as "those are our own and comped accounts, and the brake is a merchant-facing
 * safety control". That is an argument about BILLING applied to a flag this repo
 * insists elsewhere is not a processing gate: recovery-tick.ts states outright
 * that "billing_exempt is NOT a processing gate: an exempt merchant still gets
 * their money recovered", and a test pins it out of the tick's WHERE. Excluding
 * exempt accounts here meant a comped merchant's customers kept being dunned and
 * card-charged through an incident the operator had just declared stopped, with
 * the panel reporting a fully successful engage. Exempt means Foxhound does not
 * charge THAT MERCHANT fees; it says nothing about whether their customers
 * should keep being charged. The brake is an incident control, not a billing one.
 *
 * Cancelled accounts ARE skipped (review LOW-1), and this is the half that has
 * to compose with the ruling in charge-retry.ts's queryStrandedInvoices.
 * Cancellation already halts processing, so pausing adds nothing operationally,
 * but processing_paused ALSO gates billing: pausing would flip
 * accountBillingEligibleCondition false and defer the pre-cancellation fees that
 * are deliberately still owed ("cancel never silently forgives owed fees",
 * merchants.server.ts) for as long as the brake stayed engaged. So the brake
 * leaves them alone and the sweep keeps collecting what they already owe.
 */
export function brakeEligibleCondition(): SQL {
  return and(
    eq(accounts.processingPaused, false),
    isNull(accounts.cancelledAt),
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

/**
 * Accounts per db.batch. A chunk now costs TWO batches, not one: the flag writes
 * go first, and only the ids they actually transitioned get audit rows (review
 * MEDIUM-1 made the flag write conditional, so group membership stopped being
 * proof that anything moved). Each account contributes one statement to each
 * batch, so a chunk is 25 statements per batch.
 *
 * The number exists because the first version awaited two round trips per
 * account inside a `for`. At 500 merchants that was ~1002 sequential D1 calls in
 * one invocation, against a 1000-subrequest ceiling: the control built for a
 * platform-wide incident was least likely to complete at the scale where an
 * incident is worst. Splitting the audit rows off doubles the batch count and
 * still lands nowhere near that ceiling (42 subrequests at 500 accounts).
 * test/admin-brake.test.ts asserts the arithmetic rather than trusting this
 * comment.
 */
export const BRAKE_CHUNK_ACCOUNTS = 25;

/** The Workers subrequest ceiling this batching is sized against (paid plan). */
export const SUBREQUEST_BUDGET = 1000;

/** How many account ids the umbrella row samples into its metadata. The
 *  per-account rows carry every id, so this is a readability cap on one blob,
 *  not a loss of audit detail. */
export const AUDIT_ID_SAMPLE_LIMIT = 100;

/** Split ids into batch-sized groups. Pure, so the subrequest arithmetic is
 *  assertable in a test instead of argued in a comment. */
export function chunkAccountIds(ids: string[], size: number = BRAKE_CHUNK_ACCOUNTS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Subrequests one engage/release costs: the eligibility read, the umbrella row,
 *  then TWO batches per chunk (flag writes, then audit rows for the ids those
 *  writes actually transitioned). Exported so the budget is a computed fact.
 *
 *  The audit batch is skipped when a chunk transitioned nothing, so this is the
 *  worst case rather than the exact cost. */
export function brakeSubrequestCost(accountCount: number, size: number = BRAKE_CHUNK_ACCOUNTS): number {
  return 2 + 2 * Math.ceil(accountCount / size);
}

function sampleIds(ids: string[]) {
  return {
    accountIds: ids.slice(0, AUDIT_ID_SAMPLE_LIMIT),
    accountIdsTruncated: ids.length > AUDIT_ID_SAMPLE_LIMIT,
  };
}

export interface BrakeResult {
  /** Accounts actually transitioned by this call, counted from the flag writes'
   *  RETURNING rows. On a partial failure this is the number that committed, NOT
   *  the number intended; on a clean run it can still be lower than
   *  `intendedCount`, because a row that stopped matching the guard between the
   *  eligibility read and its chunk write is skipped (review MEDIUM-1/INFO-2). */
  affectedCount: number;
  accountIds: string[];
  /** The umbrella admin_audit_log row id. Written FIRST, so it exists even when
   *  the account writes fail partway. */
  auditLogId: string;
  /** Accounts this call set out to transition. Differs from affectedCount only
   *  on a partial failure. */
  intendedCount: number;
  /** Present when a chunk failed. The committed chunks stand and the marker makes
   *  them releasable; this says the operator should look. */
  error?: string;
}

/** Injectable batch executor, so a chunk failure can be simulated in a test
 *  without a broken D1. Defaults to the real db.batch. */
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
 *
 * Throws rather than defaulting to empty on an unexpected shape. A silent []
 * here would report "the brake paused 0 accounts" while the rows were in fact
 * paused, which is the worst possible lie for this control to tell; the recovery
 * tick's guard takes the same throw-on-unexpected-result line.
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
 * Umbrella-first is the ordering that makes a partial failure diagnosable. The
 * umbrella row is the INTENT record: it names the actor, the time and how many
 * accounts the operator meant to move. If a chunk then fails, what survives is
 * an intent row, a partial set of marked rows, and a release that resumes
 * exactly the marked ones. Writing it last, as the first version did, meant a
 * mid-loop failure left paused accounts with no record that anyone had engaged.
 *
 * The flag writes and the audit rows are two batches rather than one interleaved
 * batch because `guard` can skip a row (review MEDIUM-1). The audit rows have to
 * be built from what the flag writes RETURNED, or the brake would file evidence
 * that it paused a merchant it deliberately left alone, which is the same class
 * of defect as reporting a count of rows it merely selected.
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
    /** Re-applied server-side in each flag write's WHERE, so the predicate that
     *  selected an account still has to hold when its row is written. */
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
  for (const group of chunkAccountIds(accountIds)) {
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
 * Idempotent by construction rather than by a flag: brakeEligibleCondition
 * excludes already-paused accounts, so a second engage finds an empty set and
 * writes zero account rows. It still records the umbrella entry, because an
 * operator hitting the brake twice during an incident is a fact worth keeping.
 *
 * The SAME predicate is passed as the write-time guard, so idempotence stops
 * depending on the select being the last word. Reading eligibility once and then
 * writing in chunks left a window in which an operator could pause a merchant
 * for cause and have the brake overwrite that pause with its own marker, so the
 * next release resumed a merchant nobody meant to resume (review MEDIUM-1). This
 * is the same shape as the recovery tick's mid-run guard and the fee sweep's
 * pre-charge re-read: re-evaluate the selecting predicate, never a paraphrase of
 * it, so the two can never disagree about what eligible means.
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
 * This asymmetry is the whole design. A merchant paused individually before the
 * brake was engaged carries no marker, so they stay paused, and an operator who
 * lifts a platform-wide brake never silently resumes a merchant who was stopped
 * for cause.
 *
 * A no-op when nothing is engaged, for the same reason engage is: the predicate
 * finds nothing.
 *
 * Guarded at write time on the same predicate as engage is, for the same reason.
 * A merchant resumed by hand between the read and their chunk is skipped rather
 * than resumed twice, and the reported count says so.
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

/** Metadata keys a count may live under, newest first.
 *
 *  `intendedCount` is what the umbrella row records now that it is written
 *  BEFORE the account writes. Rows written before that change carry
 *  `pausedCount` / `resumedCount`, and reading only the new key left every
 *  historical engage and release rendering with no number at all (review
 *  LOW-D). The values were never lost, just unreachable from the panel. */
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
    lastEngage: readEvent(engageRow),
    lastRelease: readEvent(releaseRow),
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
