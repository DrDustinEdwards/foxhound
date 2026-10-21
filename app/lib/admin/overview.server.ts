// Platform-wide health summary for /admin (overview). Every query here is
// GLOBAL (no account_id scope, this is the operator surface, not a tenant
// surface) and excludes demo accounts (DEMO_ACCOUNT_ID_PREFIX), matching the
// accountBillingEligibleCondition demo-exclusion convention in app/db/billable.ts.

import { and, asc, count, desc, eq, gte, inArray, isNull, lt, notInArray, notLike, sql } from "drizzle-orm";

import type { Db } from "~/db";
import {
  accounts,
  billingInvoices,
  cronConfig,
  cronRunHistory,
  disputes,
  failedPayments,
  mrrSnapshots,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { auditTarget, describeAuditAction, type AuditTarget } from "~/lib/admin/audit-describe";
import { listAuditLog, loadAuditLookups } from "~/lib/admin/audit-log.server";
import { groupSumByCurrency, startOfUtcMonthMs, type CurrencyAmount } from "~/lib/billing/preview.server";
import { BILLABLE_ATTRIBUTION_KINDS, DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

const NOT_DEMO = notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** How old an open dispute with no response is before it needs attention, and
 *  how far back a connection counts as new: Recova's overview (app/admin/page.tsx)
 *  used seven days for both. */
const STALE_DISPUTE_DAYS = 7;
const NEW_CONNECTION_DAYS = 7;

/** A ceiling on the dispute and fee attention rows. The list shows five of a
 *  group; their groups have no page to link on to, so the titles carry the
 *  real counts and nothing says "All N". */
const ATTENTION_LIMIT = 50;

/** Recova's Recent admin actions showed the newest ten audit rows. */
const RECENT_ACTIONS_LIMIT = 10;

export interface PausedMerchant {
  id: string;
  name: string | null;
  /** PAUSE_REASON_BRAKE when the emergency brake paused it, PAUSE_REASON_MANUAL
   *  (or null on an older row) when an operator did (app/lib/admin/brake.ts). */
  pauseReason: string | null;
}

export interface StaleDispute {
  id: string;
  accountId: string;
  merchantName: string | null;
  amountCents: number;
  currency: string;
  reason: string;
  createdAt: Date;
  evidenceDeadline: Date | null;
}

export interface FailedFeeInvoice {
  id: string;
  accountId: string;
  merchantName: string | null;
  totalCents: number;
  currency: string;
  /** payment_failed, gave_up or uncollectible. */
  status: string;
  chargeAttemptCount: number;
  /** The last charge attempt, or when the invoice was made if none is stamped. */
  failedAt: Date;
}

/** What GET /platform (the admin API, foxhound_admin_get_platform) returns:
 *  the four fields it always had. The /admin page reads AdminOverview. */
export interface PlatformOverview {
  merchantCount: number;
  activeRecoveriesCount: number;
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  cronHealth: {
    failedLast24h: number;
    /** The failed runs themselves (newest first), so the Overview can link to
     *  each one on /admin/platform/crons. */
    failedRuns: Array<{ id: string; cronName: string; finishedAt: Date; message: string | null }>;
    lastRunAt: Date | null;
    disabledCount: number;
  };
}

/** The /admin Overview's read: the platform overview plus Recova's overview
 *  inventory (app/admin/page.tsx), each computed by Foxhound's engine. */
export interface AdminOverview extends PlatformOverview {
  /** Merchants whose processing is paused and who could be resumed (not
   *  cancelled or deleted, where processing is gated anyway). */
  pausedCount: number;
  billingExemptCount: number;
  /** Stripe connections made in the last NEW_CONNECTION_DAYS and still live. */
  newConnectionsCount: number;
  /** Disputes not yet resolved, by Foxhound's dispute state machine. */
  openDisputesCount: number;
  /** How many of those are older than STALE_DISPUTE_DAYS with no response
   *  submitted, counted rather than read, so it holds past ATTENTION_LIMIT. */
  staleDisputesCount: number;
  /** Fee invoices that need a person (FEE_ATTENTION_STATUSES, last
   *  FEE_ATTENTION_DAYS), counted. */
  failedFeeInvoicesCount: number;
  /** Attributed recoveries (BILLABLE_ATTRIBUTION_KINDS) since the first of this
   *  UTC month, per currency: what /billing's "Recovered this month" shows one
   *  merchant (attributedThisMonth), across all of them. */
  recoveredThisMonth: { byCurrency: CurrencyAmount[]; paymentCount: number };
  attention: {
    /** Every one, not capped, so a group's "All N" link count is true. */
    pausedMerchants: PausedMerchant[];
    /** Open, no response submitted, older than STALE_DISPUTE_DAYS; those still
     *  answerable first, soonest evidence deadline first. */
    staleDisputes: StaleDispute[];
    /** Newest first. */
    failedFeeInvoices: FailedFeeInvoice[];
  };
}

async function countMerchants(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(accounts).where(NOT_DEMO);
  return rows[0]?.n ?? 0;
}

/** Failed payments in an active recovery sequence, demo accounts and
 *  soft-deleted rows not counted (Recova's queue read: deleted_at is null).
 *  The Overview's "Active recoveries", the Operations page's queue depth and
 *  /admin/merchants' "Payments in queue" read this one count, so they agree. */
export async function countActiveRecoveries(db: Db): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(failedPayments)
    .innerJoin(accounts, eq(accounts.id, failedPayments.accountId))
    .where(and(eq(failedPayments.status, "active"), isNull(failedPayments.deletedAt), NOT_DEMO));
  return rows[0]?.n ?? 0;
}

/** Latest mrr_snapshots row per (non-demo) account, summed by currency. Simple
 *  per-account "latest snapshot date" read; platform scale (~hundreds of
 *  accounts pre-launch) makes an in-app group-by-max fine without a window
 *  function, matching the "small volume" posture the rest of the admin
 *  surface takes (SCHEMA.md target scale ~300 merchants). The Merchants
 *  page's "Estimated MRR" reads the same figure. */
export async function mrrUnderManagement(db: Db): Promise<PlatformOverview["mrrByCurrency"]> {
  const rows = await db
    .select({
      accountId: mrrSnapshots.accountId,
      snapshotDate: mrrSnapshots.snapshotDate,
      totalMrrCents: mrrSnapshots.totalMrrCents,
      currency: mrrSnapshots.currency,
    })
    .from(mrrSnapshots)
    .innerJoin(accounts, eq(accounts.id, mrrSnapshots.accountId))
    .where(NOT_DEMO)
    .orderBy(desc(mrrSnapshots.snapshotDate));

  const latestByAccount = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByAccount.has(row.accountId)) latestByAccount.set(row.accountId, row);
  }

  const byCurrency = new Map<string, { totalCents: number; accountCount: number }>();
  for (const row of latestByAccount.values()) {
    const entry = byCurrency.get(row.currency) ?? { totalCents: 0, accountCount: 0 };
    entry.totalCents += row.totalMrrCents;
    entry.accountCount += 1;
    byCurrency.set(row.currency, entry);
  }
  return [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v }));
}

async function cronHealth(db: Db, nowMs: number): Promise<PlatformOverview["cronHealth"]> {
  const since = new Date(nowMs - DAY_MS);
  const [failedRuns, lastRunRows, disabledRows] = await Promise.all([
    db
      .select({
        id: cronRunHistory.id,
        cronName: cronRunHistory.cronName,
        finishedAt: cronRunHistory.finishedAt,
        message: cronRunHistory.message,
      })
      .from(cronRunHistory)
      .where(and(eq(cronRunHistory.status, "failed"), gte(cronRunHistory.finishedAt, since)))
      .orderBy(desc(cronRunHistory.finishedAt)),
    db.select({ finishedAt: cronRunHistory.finishedAt }).from(cronRunHistory).orderBy(desc(cronRunHistory.finishedAt)).limit(1),
    db.select({ n: count() }).from(cronConfig).where(eq(cronConfig.enabled, false)),
  ]);
  return {
    failedLast24h: failedRuns.length,
    failedRuns,
    lastRunAt: lastRunRows[0]?.finishedAt ?? null,
    disabledCount: disabledRows[0]?.n ?? 0,
  };
}

const RESUMABLE = and(eq(accounts.processingPaused, true), isNull(accounts.cancelledAt), isNull(accounts.deletedAt));

/** Every paused merchant, uncapped: the group links on to /admin/merchants
 *  with Capsomer's "All N", which counts the rows given, so they must all be
 *  given. Bounded by the merchant count (SCHEMA.md target ~300). */
async function pausedMerchants(db: Db): Promise<PausedMerchant[]> {
  return db
    .select({ id: accounts.id, name: accounts.name, pauseReason: accounts.pauseReason })
    .from(accounts)
    .where(and(RESUMABLE, NOT_DEMO))
    .orderBy(asc(accounts.name), asc(accounts.id));
}

async function countBillingExempt(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(accounts).where(and(eq(accounts.billingExempt, true), NOT_DEMO));
  return rows[0]?.n ?? 0;
}

async function countNewConnections(db: Db, nowMs: number): Promise<number> {
  const since = new Date(nowMs - NEW_CONNECTION_DAYS * DAY_MS);
  const rows = await db
    .select({ n: count() })
    .from(stripeConnections)
    .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
    .where(and(gte(stripeConnections.connectedAt, since), isNull(stripeConnections.disconnectedAt), NOT_DEMO));
  return rows[0]?.n ?? 0;
}

const OPEN_DISPUTE = notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]);

async function openDisputes(
  db: Db,
  nowMs: number,
): Promise<{ count: number; staleCount: number; stale: StaleDispute[] }> {
  const staleBefore = new Date(nowMs - STALE_DISPUTE_DAYS * DAY_MS);
  const STALE = and(OPEN_DISPUTE, isNull(disputes.submittedAt), lt(disputes.createdAt, staleBefore), NOT_DEMO);
  const [countRows, staleCountRows, stale] = await Promise.all([
    db
      .select({ n: count() })
      .from(disputes)
      .innerJoin(accounts, eq(accounts.id, disputes.accountId))
      .where(and(OPEN_DISPUTE, NOT_DEMO)),
    db.select({ n: count() }).from(disputes).innerJoin(accounts, eq(accounts.id, disputes.accountId)).where(STALE),
    db
      .select({
        id: disputes.id,
        accountId: disputes.accountId,
        merchantName: accounts.name,
        amountCents: disputes.amountCents,
        currency: disputes.currency,
        reason: disputes.reason,
        createdAt: disputes.createdAt,
        evidenceDeadline: disputes.evidenceDeadline,
      })
      .from(disputes)
      .innerJoin(accounts, eq(accounts.id, disputes.accountId))
      .where(STALE)
      // Those that can still be answered first, soonest deadline first; then
      // those past their deadline or with none, oldest first.
      .orderBy(
        sql`case when ${disputes.evidenceDeadline} >= ${nowMs} then 0 else 1 end`,
        asc(disputes.evidenceDeadline),
        asc(disputes.createdAt),
      )
      .limit(ATTENTION_LIMIT),
  ]);
  return { count: countRows[0]?.n ?? 0, staleCount: staleCountRows[0]?.n ?? 0, stale };
}

/** Fee invoices that need a person: a charge that failed and is still being
 *  chased (payment_failed), and fees owed that nobody will collect without one
 *  (gave_up, written by the retry sweep when it stops; uncollectible, from
 *  Stripe). void is left out: a voided invoice was cancelled on purpose.
 *  billing/labels.ts counts all four as failed. */
const FEE_ATTENTION_STATUSES = ["payment_failed", "gave_up", "uncollectible"] as const;
/** Recova's window for failed billing charges; an older write-off has had
 *  its month on the Overview. */
const FEE_ATTENTION_DAYS = 30;

async function failedFeeInvoices(db: Db, nowMs: number): Promise<{ count: number; rows: FailedFeeInvoice[] }> {
  const failedAt = sql<number>`coalesce(${billingInvoices.lastChargeAttemptAt}, ${billingInvoices.createdAt})`;
  const FAILED = and(
    inArray(billingInvoices.status, [...FEE_ATTENTION_STATUSES]),
    sql`${failedAt} >= ${nowMs - FEE_ATTENTION_DAYS * DAY_MS}`,
    NOT_DEMO,
  );
  const [countRows, rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(billingInvoices)
      .innerJoin(accounts, eq(accounts.id, billingInvoices.accountId))
      .where(FAILED),
    db
      .select({
        id: billingInvoices.id,
        accountId: billingInvoices.accountId,
        merchantName: accounts.name,
        totalCents: billingInvoices.totalCents,
        currency: billingInvoices.currency,
        status: billingInvoices.status,
        chargeAttemptCount: billingInvoices.chargeAttemptCount,
        failedAtMs: failedAt,
      })
      .from(billingInvoices)
      .innerJoin(accounts, eq(accounts.id, billingInvoices.accountId))
      .where(FAILED)
      .orderBy(desc(failedAt))
      .limit(ATTENTION_LIMIT),
  ]);
  return {
    count: countRows[0]?.n ?? 0,
    rows: rows.map(({ failedAtMs, ...row }) => ({ ...row, failedAt: new Date(Number(failedAtMs)) })),
  };
}

async function recoveredThisMonth(db: Db, nowMs: number): Promise<AdminOverview["recoveredThisMonth"]> {
  // Summed and counted per currency in SQL; the per-currency rows still pass
  // through groupSumByCurrency, the one money-total path (RULES.md 3.20).
  const rows = await db
    .select({
      currency: recoveredPayments.currency,
      cents: sql<number>`coalesce(sum(${recoveredPayments.amountCents}), 0)`,
      n: count(),
    })
    .from(recoveredPayments)
    .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
    .where(
      and(
        isNull(recoveredPayments.deletedAt),
        gte(recoveredPayments.recoveredAt, new Date(startOfUtcMonthMs(nowMs))),
        inArray(recoveredPayments.attributionKind, [...BILLABLE_ATTRIBUTION_KINDS]),
        NOT_DEMO,
      ),
    )
    .groupBy(recoveredPayments.currency);
  return {
    byCurrency: groupSumByCurrency(rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) }))),
    paymentCount: rows.reduce((n, r) => n + r.n, 0),
  };
}

/** GET /platform's read (the admin API): unchanged in shape, four fields. */
export async function getPlatformOverview(db: Db, nowMs: number = Date.now()): Promise<PlatformOverview> {
  const [merchantCount, activeRecoveriesCount, mrrByCurrency, cronHealthSummary] = await Promise.all([
    countMerchants(db),
    countActiveRecoveries(db),
    mrrUnderManagement(db),
    cronHealth(db, nowMs),
  ]);
  return { merchantCount, activeRecoveriesCount, mrrByCurrency, cronHealth: cronHealthSummary };
}

/** The /admin Overview's read, all of it from one clock. */
export async function getAdminOverview(db: Db, nowMs: number): Promise<AdminOverview> {
  const [platform, paused, billingExemptCount, newConnectionsCount, disputeSummary, feeInvoices, recovered] =
    await Promise.all([
      getPlatformOverview(db, nowMs),
      pausedMerchants(db),
      countBillingExempt(db),
      countNewConnections(db, nowMs),
      openDisputes(db, nowMs),
      failedFeeInvoices(db, nowMs),
      recoveredThisMonth(db, nowMs),
    ]);
  return {
    ...platform,
    pausedCount: paused.length,
    billingExemptCount,
    newConnectionsCount,
    openDisputesCount: disputeSummary.count,
    staleDisputesCount: disputeSummary.staleCount,
    failedFeeInvoicesCount: feeInvoices.count,
    recoveredThisMonth: recovered,
    attention: {
      pausedMerchants: paused,
      staleDisputes: disputeSummary.stale,
      failedFeeInvoices: feeInvoices.rows,
    },
  };
}

export interface RecentAdminAction {
  id: string;
  createdAt: Date;
  actorEmail: string;
  /** The action as a sentence (audit-describe.ts), the same words /admin/platform/audit-log uses. */
  action: string;
  target: AuditTarget | null;
}

/** The newest audit rows, described as /admin/platform/audit-log describes them. */
export async function listRecentAdminActions(db: Db): Promise<RecentAdminAction[]> {
  const rows = await listAuditLog(db, RECENT_ACTIONS_LIMIT);
  const lookups = await loadAuditLookups(db, rows);
  return rows.map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    actorEmail: e.actorEmail,
    action: describeAuditAction(e.action),
    target: auditTarget(e, lookups),
  }));
}
