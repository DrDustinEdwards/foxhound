import { and, eq, exists, isNull, notExists, sql, type SQL } from "drizzle-orm";
import { buildAdminAuditLogInsert, type LogAdminActionInput } from "~/lib/admin/audit.server";
import type { MoneyWriteBatch } from "~/db/money-write";
import { type Db, accounts, billingExemptionPeriods, getDb } from "~/db";
import { PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { executeMoneyWrite } from "~/lib/money/execute";

/**
 * Exempt or un-exempt an account from billing, and record the stretch.
 *
 * An exemption forgives: a fee earned or due while the account is exempt is
 * never billed. app/db/billable.ts reads billing_exemption_periods for that, so
 * the flag and its stretch are one money write, through the account's money
 * Durable Object, which also orders it against that account's billing batches.
 * Returns whether it changed, so the Merchants page offers Undo only for a real
 * change: a stale row's "Set exempt" on a merchant someone else exempted
 * changes nothing, and its Undo must not un-exempt them.
 */
export async function setBillingExempt(
  env: Env,
  accountId: string,
  exempt: boolean,
  now: Date,
  /** The admin's audit row, committed in the same batch as the change. */
  audit?: LogAdminActionInput,
): Promise<boolean> {
  const db = getDb(env);
  const changeId = crypto.randomUUID();
  const nowMs = now.getTime();
  const openPeriod = (bdb: Db) =>
    bdb
      .select({ one: sql`1` })
      .from(billingExemptionPeriods)
      .where(
        and(
          eq(billingExemptionPeriods.accountId, accountId),
          isNull(billingExemptionPeriods.endedAt),
        ),
      );
  const flagIs = (value: boolean) =>
    and(eq(accounts.id, accountId), eq(accounts.billingExempt, value));
  // A new stretch, projected in the table's column order (insert-select needs
  // every column, and the id default does not fire on one).
  const newPeriod = (bdb: Db, periodId: string, where: SQL | undefined) =>
    bdb.insert(billingExemptionPeriods).select(
      bdb
        .select({
          id: sql<string>`${periodId}`.as("id"),
          accountId: accounts.id,
          startedAt: sql<number>`${nowMs}`.as("started_at"),
          endedAt: sql<number | null>`null`.as("ended_at"),
          endedByChangeId: sql<string | null>`null`.as("ended_by_change_id"),
        })
        .from(accounts)
        .where(where),
    );

  await executeMoneyWrite(env, {
    accountId,
    idempotencyKey: `billing-exempt:${accountId}:${changeId}`,
    build: (bdb) => {
      const batch: MoneyWriteBatch = exempt
        ? [
            newPeriod(bdb, changeId, flagIs(false)),
            bdb.update(accounts).set({ billingExempt: true }).where(flagIs(false)),
          ]
        : [
            // An exempt account with no open stretch (none should exist after
            // migration 0039) gets one now, so ending it is still recorded.
            newPeriod(bdb, crypto.randomUUID(), and(flagIs(true), notExists(openPeriod(bdb)))),
            bdb
              .update(billingExemptionPeriods)
              .set({ endedAt: now, endedByChangeId: changeId })
              .where(
                and(
                  eq(billingExemptionPeriods.accountId, accountId),
                  isNull(billingExemptionPeriods.endedAt),
                  exists(
                    bdb
                      .select({ one: sql`1` })
                      .from(accounts)
                      .where(flagIs(true)),
                  ),
                ),
              ),
            bdb.update(accounts).set({ billingExempt: false }).where(flagIs(true)),
          ];
      if (audit) batch.push(buildAdminAuditLogInsert(bdb, audit).statement);
      return batch;
    },
  });

  const landed = await db
    .select({ id: billingExemptionPeriods.id })
    .from(billingExemptionPeriods)
    .where(
      exempt
        ? eq(billingExemptionPeriods.id, changeId)
        : eq(billingExemptionPeriods.endedByChangeId, changeId),
    )
    .limit(1);
  return landed.length > 0;
}

/**
 * Pause or resume recovery/dispute processing. Honored by
 * app/lib/cron/recovery-tick.ts's accountProcessingEligibleCondition and
 * app/lib/intelligence/sync.server.ts's accountProcessingEligible, and (per
 * PRICING.md) ALSO by the billing gate (app/db/billable.ts): a paused merchant
 * is not billed while paused, which is deliberate and distinct from cancel (see
 * cancelMerchant).
 */
export function buildSetProcessingPaused(
  db: Db,
  accountId: string,
  paused: boolean,
  reason: string | null = null,
  guard?: SQL,
) {
  const target = guard
    ? (and(eq(accounts.id, accountId), guard) as SQL)
    : eq(accounts.id, accountId);

  if (!paused) {
    return db
      .update(accounts)
      .set({ processingPaused: false, pauseReason: null })
      .where(target)
      .returning({ id: accounts.id });
  }

  if (reason !== null) {
    return db
      .update(accounts)
      .set({ processingPaused: true, pauseReason: reason })
      .where(target)
      .returning({ id: accounts.id });
  }

  return db
    .update(accounts)
    .set({
      processingPaused: true,
      pauseReason: sql`case when ${accounts.processingPaused} = 1 then ${accounts.pauseReason} else ${PAUSE_REASON_MANUAL} end`,
    })
    .where(target)
    .returning({ id: accounts.id });
}

export async function setProcessingPaused(
  db: Db,
  accountId: string,
  paused: boolean,
  /** The admin's audit row, committed in the same batch as the change. */
  audit?: LogAdminActionInput,
): Promise<void> {
  await withAudit(db, buildSetProcessingPaused(db, accountId, paused), audit);
}

/**
 * Run one write, and the admin's audit row with it in one batch when there is
 * one, so a change never stands without its record. Returns the write's
 * RETURNING rows.
 */
async function withAudit(
  db: Db,
  write: ReturnType<typeof buildSetProcessingPaused>,
  audit: LogAdminActionInput | undefined,
): Promise<{ id: string }[]> {
  if (!audit) return write;
  const [rows] = await db.batch([write, buildAdminAuditLogInsert(db, audit).statement]);
  return rows;
}

/**
 * Pauses or resumes one merchant only when the flag holds the other value, and
 * says whether it moved, so the merchants page offers Undo only for a real
 * change. With `undoOfPause`, a resume matches only a manual pause: an Undo of
 * a pause can never take a merchant off the emergency brake, whose pause may
 * have landed on the row since.
 */
export async function setProcessingPausedIfChanged(
  db: Db,
  accountId: string,
  paused: boolean,
  { undoOfPause = false, audit }: { undoOfPause?: boolean; audit?: LogAdminActionInput } = {},
): Promise<boolean> {
  const from = eq(accounts.processingPaused, !paused);
  const guard =
    !paused && undoOfPause
      ? (and(from, eq(accounts.pauseReason, PAUSE_REASON_MANUAL)) as SQL)
      : from;
  const rows = await withAudit(
    db,
    buildSetProcessingPaused(db, accountId, paused, null, guard),
    audit,
  );
  return rows.length > 0;
}
