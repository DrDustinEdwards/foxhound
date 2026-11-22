// /admin/merchants data layer: list + figures + detail (read-only) and the
// money-adjacent write actions (Pass 2): billing_exempt / processing_paused
// toggles and merchant cancel/disconnect. Adjustment creation lives in
// app/lib/billing/adjustment.ts (it flows through the billing ledger, not this
// file).

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNull,
  ne,
  notExists,
  notLike,
  sql,
  type SQL,
} from "drizzle-orm";
import { buildAdminAuditLogInsert, type LogAdminActionInput } from "~/lib/admin/audit.server";
import type { MoneyWriteBatch } from "~/db/money-write";
import {
  type Db,
  accountMembers,
  accountSubscriptions,
  accounts,
  billingExemptionPeriods,
  billingInvoices,
  billingLineItems,
  disputes,
  getDb,
  failedPayments,
  recoveredPayments,
  stripeConnections,
  user,
} from "~/db";
import { PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { countActiveRecoveries, mrrUnderManagement } from "~/lib/admin/overview.server";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";
import { executeMoneyWrite } from "~/lib/money/execute";
import { startOfUtcMonthMs } from "~/lib/billing/preview.server";
import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { percent } from "capsomer/behavior/meter";

export interface MerchantListRow {
  id: string;
  name: string | null;
  createdAt: Date | null;
  billingExempt: boolean;
  processingPaused: boolean;
  cancelledAt: Date | null;
  connectionStatus: "connected" | "disconnected" | "never_connected";
  activeRecoveriesCount: number;
}

export interface AdminMerchantRow extends MerchantListRow {
  /** PAUSE_REASON_BRAKE or PAUSE_REASON_MANUAL while paused (brake.ts). */
  pauseReason: string | null;
  ownerEmail: string | null;
  /**
   * The live connection's Stripe account: the live primary, else the oldest
   * live one. A disconnected primary stops counting as the primary one
   * (APPROVED-DIFFERENCES, 2026-09-19). Null with no live connection.
   */
  stripeUserId: string | null;
  /** That connection's last webhook. */
  lastWebhookAt: Date | null;
  recoveryRatePct: number | null;
  /** Everything recovered for this merchant, per currency. */
  recovered: CurrencyAmount[];
}

export async function listAdminMerchants(db: Db): Promise<AdminMerchantRow[]> {
  const [rows, owners, connections, activeCounts, failedCounts, recoveredRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        createdAt: accounts.createdAt,
        billingExempt: accounts.billingExempt,
        processingPaused: accounts.processingPaused,
        pauseReason: accounts.pauseReason,
        cancelledAt: accounts.cancelledAt,
      })
      .from(accounts)
      .orderBy(desc(accounts.createdAt)),
    db
      .select({ accountId: accountMembers.accountId, email: user.email })
      .from(accountMembers)
      .innerJoin(user, eq(user.id, accountMembers.userId))
      .where(
        and(
          eq(accountMembers.role, MEMBER_ROLE.OWNER),
          eq(accountMembers.status, MEMBER_STATUS.ACTIVE),
        ),
      )
      .orderBy(asc(accountMembers.createdAt)),
    db
      .select({
        accountId: stripeConnections.accountId,
        stripeUserId: stripeConnections.stripeUserId,
        isPrimary: stripeConnections.isPrimary,
        disconnectedAt: stripeConnections.disconnectedAt,
        lastWebhookAt: stripeConnections.lastWebhookAt,
      })
      .from(stripeConnections)
      .orderBy(asc(stripeConnections.connectedAt), asc(stripeConnections.createdAt)),
    db
      .select({ accountId: failedPayments.accountId, n: count() })
      .from(failedPayments)
      .where(and(eq(failedPayments.status, "active"), isNull(failedPayments.deletedAt)))
      .groupBy(failedPayments.accountId),
    db
      .select({ accountId: failedPayments.accountId, n: count() })
      .from(failedPayments)
      .where(isNull(failedPayments.deletedAt))
      .groupBy(failedPayments.accountId),
    db
      .select({
        accountId: recoveredPayments.accountId,
        currency: recoveredPayments.currency,
        cents: sql<number>`coalesce(sum(${recoveredPayments.amountCents}), 0)`,
        n: count(),
      })
      .from(recoveredPayments)
      .where(isNull(recoveredPayments.deletedAt))
      .groupBy(recoveredPayments.accountId, recoveredPayments.currency),
  ]);

  const ownerByAccount = new Map<string, string>();
  for (const o of owners)
    if (!ownerByAccount.has(o.accountId)) ownerByAccount.set(o.accountId, o.email);

  const connectionsByAccount = new Map<string, typeof connections>();
  for (const c of connections) {
    const list = connectionsByAccount.get(c.accountId) ?? [];
    list.push(c);
    connectionsByAccount.set(c.accountId, list);
  }

  const activeByAccount = new Map(activeCounts.map((r) => [r.accountId, r.n]));
  const failedByAccount = new Map(failedCounts.map((r) => [r.accountId, r.n]));
  const recoveredByAccount = new Map<
    string,
    { n: number; amounts: Array<{ currency: string; cents: number }> }
  >();
  for (const r of recoveredRows) {
    const entry = recoveredByAccount.get(r.accountId) ?? { n: 0, amounts: [] };
    entry.n += r.n;
    entry.amounts.push({ currency: r.currency, cents: Number(r.cents) });
    recoveredByAccount.set(r.accountId, entry);
  }

  return rows.map((row) => {
    const own = connectionsByAccount.get(row.id) ?? [];
    const live = own.filter((c) => c.disconnectedAt === null);
    const shown = live.find((c) => c.isPrimary) ?? live[0] ?? null;
    const failedCount = failedByAccount.get(row.id) ?? 0;
    const recovered = recoveredByAccount.get(row.id);
    return {
      ...row,
      connectionStatus:
        live.length > 0 ? "connected" : own.length > 0 ? "disconnected" : "never_connected",
      activeRecoveriesCount: activeByAccount.get(row.id) ?? 0,
      ownerEmail: ownerByAccount.get(row.id) ?? null,
      stripeUserId: shown?.stripeUserId ?? null,
      lastWebhookAt: shown?.lastWebhookAt ?? null,
      recoveryRatePct: failedCount > 0 ? percent(recovered?.n ?? 0, failedCount) : null,
      recovered: groupSumByCurrency(recovered?.amounts ?? []),
    };
  });
}

/**
 * The admin API's merchants list (GET /merchants): the same rows, with the
 * fields it has always returned and no more.
 */
export async function listMerchants(db: Db): Promise<MerchantListRow[]> {
  const rows = await listAdminMerchants(db);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    billingExempt: r.billingExempt,
    processingPaused: r.processingPaused,
    cancelledAt: r.cancelledAt,
    connectionStatus: r.connectionStatus,
    activeRecoveriesCount: r.activeRecoveriesCount,
  }));
}

export interface MerchantFigures {
  /** Accounts, demo ones not counted: the denominator for connectedCount. */
  merchantCount: number;
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  connectedCount: number;
  totalRecovered: CurrencyAmount[];
  recoveryFeesThisMonth: CurrencyAmount[];
  paymentsInQueue: number;
}

const NOT_DEMO = notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`);

export async function getMerchantFigures(db: Db, nowMs: number): Promise<MerchantFigures> {
  const monthStart = new Date(startOfUtcMonthMs(nowMs));
  const [merchantRows, mrrByCurrency, connectedRows, recoveredRows, feeRows, paymentsInQueue] =
    await Promise.all([
      db.select({ n: count() }).from(accounts).where(NOT_DEMO),
      mrrUnderManagement(db),
      db
        .select({ n: sql<number>`count(distinct ${stripeConnections.accountId})` })
        .from(stripeConnections)
        .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
        .where(and(isNull(stripeConnections.disconnectedAt), NOT_DEMO)),
      db
        .select({
          currency: recoveredPayments.currency,
          cents: sql<number>`coalesce(sum(${recoveredPayments.amountCents}), 0)`,
        })
        .from(recoveredPayments)
        .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
        .where(and(isNull(recoveredPayments.deletedAt), NOT_DEMO))
        .groupBy(recoveredPayments.currency),
      db
        .select({
          currency: billingLineItems.currency,
          cents: sql<number>`coalesce(sum(coalesce(${billingLineItems.feeCents}, ${billingLineItems.amountCents})), 0)`,
        })
        .from(billingLineItems)
        .innerJoin(billingInvoices, eq(billingInvoices.id, billingLineItems.invoiceId))
        .innerJoin(accounts, eq(accounts.id, billingLineItems.accountId))
        .where(
          and(
            eq(billingLineItems.type, "recovery_fee"),
            gte(billingInvoices.createdAt, monthStart),
            ne(billingInvoices.status, "void"),
            NOT_DEMO,
          ),
        )
        .groupBy(billingLineItems.currency),
      // The Overview's own count, so "Payments in queue" and "Active
      // recoveries" can never disagree.
      countActiveRecoveries(db),
    ]);
  const money = (rows: Array<{ currency: string; cents: number }>) =>
    groupSumByCurrency(rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) }))).filter(
      (m) => m.cents !== 0,
    );
  return {
    merchantCount: merchantRows[0]?.n ?? 0,
    mrrByCurrency,
    connectedCount: Number(connectedRows[0]?.n ?? 0),
    totalRecovered: money(recoveredRows),
    recoveryFeesThisMonth: money(feeRows),
    paymentsInQueue,
  };
}

export interface MerchantDetail {
  account: typeof accounts.$inferSelect;
  connections: Array<typeof stripeConnections.$inferSelect>;
  subscriptions: Array<typeof accountSubscriptions.$inferSelect>;
  recoveryActivity: {
    activeCount: number;
    recoveredCount: number;
  };
  disputeActivity: {
    openCount: number;
    resolvedWonCount: number;
    resolvedLostCount: number;
  };
  recentInvoices: Array<typeof billingInvoices.$inferSelect>;
}

const DISPUTE_OPEN_STATES = ["draft", "pending_review", "approved", "submitted"] as const;

/**
 * The currencies an admin adjustment may be in for this account: its home
 * currency and every currency it has a fee invoice in, lowercase. An adjustment
 * lands on an invoice in its currency, so any other is a typo, and the amount
 * is read in that currency's minor units.
 */
export async function listAdjustmentCurrencies(db: Db, accountId: string): Promise<Set<string>> {
  const [account, invoices] = await Promise.all([
    db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)),
    db
      .selectDistinct({ currency: billingInvoices.currency })
      .from(billingInvoices)
      .where(eq(billingInvoices.accountId, accountId)),
  ]);
  const found = [account[0]?.currency, ...invoices.map((r) => r.currency)].flatMap((c) =>
    c ? [c.toLowerCase()] : [],
  );
  // No home currency and never billed: the form's own default.
  return new Set(found.length > 0 ? found : ["usd"]);
}

export async function getMerchantDetail(db: Db, accountId: string): Promise<MerchantDetail | null> {
  const accountRows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const account = accountRows[0];
  if (!account) return null;

  const [connections, subscriptions, activeCount, recoveredCount, allDisputes, recentInvoices] =
    await Promise.all([
      db.select().from(stripeConnections).where(eq(stripeConnections.accountId, accountId)),
      db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, accountId)),
      db
        .select({ n: count() })
        .from(failedPayments)
        .where(and(eq(failedPayments.accountId, accountId), eq(failedPayments.status, "active")))
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: count() })
        .from(recoveredPayments)
        .where(and(eq(recoveredPayments.accountId, accountId), isNull(recoveredPayments.deletedAt)))
        .then((r) => r[0]?.n ?? 0),
      db.select({ state: disputes.state }).from(disputes).where(eq(disputes.accountId, accountId)),
      db
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.accountId, accountId))
        .orderBy(desc(billingInvoices.createdAt))
        .limit(10),
    ]);

  const openStates = new Set<string>(DISPUTE_OPEN_STATES);
  const disputeActivity = {
    openCount: allDisputes.filter((d) => openStates.has(d.state)).length,
    resolvedWonCount: allDisputes.filter((d) => d.state === "resolved_won").length,
    resolvedLostCount: allDisputes.filter((d) => d.state === "resolved_lost").length,
  };

  return {
    account,
    connections,
    subscriptions,
    recoveryActivity: { activeCount, recoveredCount },
    disputeActivity,
    recentInvoices,
  };
}

/**
 * What the Merchants page's action needs to know before it writes: that the
 * account exists, its name for the result, and whether the brake owns its pause
 * (a resume of that has no Undo). Null when there is no such account.
 */
export async function getMerchantActionTarget(
  db: Db,
  accountId: string,
): Promise<{
  id: string;
  name: string | null;
  billingExempt: boolean;
  processingPaused: boolean;
  pauseReason: string | null;
  cancelledAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      billingExempt: accounts.billingExempt,
      processingPaused: accounts.processingPaused,
      pauseReason: accounts.pauseReason,
      cancelledAt: accounts.cancelledAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}

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
