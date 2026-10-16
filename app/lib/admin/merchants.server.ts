// /admin/merchants data layer: list + figures + detail (read-only) and the
// money-adjacent write actions (Pass 2): billing_exempt / processing_paused
// toggles and merchant cancel/disconnect. Adjustment creation lives in
// app/lib/billing/adjustment.ts (it flows through the billing ledger, not
// this file). Every write here is a plain, account-scoped db operation, not a
// money write (ARCHITECTURE.md's DO rule covers outcome recording, attributed
// billing, and webhook claims; a flag toggle or a connection-disconnect stamp
// is operational, matching the brand-voice-update / cron-toggle precedent).

import { and, asc, count, desc, eq, gte, isNull, ne, notLike, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import {
  accountMembers,
  accountSubscriptions,
  accounts,
  billingInvoices,
  billingLineItems,
  disputes,
  failedPayments,
  getDb,
  recoveredPayments,
  stripeConnections,
  user,
} from "~/db";
import { PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { countActiveRecoveries, mrrUnderManagement } from "~/lib/admin/overview.server";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";
import { groupSumByCurrency, startOfUtcMonthMs, type CurrencyAmount } from "~/lib/billing/preview.server";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  INTELLIGENCE_PRODUCT,
  SUBSCRIPTION_STATUS_ACTIVE,
  SUBSCRIPTION_STATUS_CANCELED,
} from "~/lib/constants";
import { deauthorizeConnectedAccount } from "~/lib/stripe/connect";

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

/** The /admin/merchants row: the admin API's MerchantListRow plus Recova's
 *  inventory (app/admin/AdminClient.tsx, blob df4b3713, and the
 *  /api/admin/users route that fed it), each read from Foxhound's engine. */
export interface AdminMerchantRow extends MerchantListRow {
  /** PAUSE_REASON_BRAKE or PAUSE_REASON_MANUAL while paused (brake.ts). */
  pauseReason: string | null;
  /** The active owner's sign-in email (Recova: the owner member's auth email). */
  ownerEmail: string | null;
  /** The live connection's Stripe account: the live primary, else the oldest
   *  live one. A disconnected primary stops counting as the primary one
   *  (APPROVED-DIFFERENCES, 2026-09-19). Null with no live connection. */
  stripeUserId: string | null;
  /** That connection's last webhook. */
  lastWebhookAt: Date | null;
  /** Recova's rate: recoveries over failures, both with deleted rows left
   *  out, rounded to a whole percent. Null when nothing has failed. */
  recoveryRatePct: number | null;
  /** Everything recovered for this merchant, per currency (RULES.md 3.20). */
  recovered: CurrencyAmount[];
}

/** One row per account, newest first, demo accounts included as Recova's list
 *  included them. Each column is one grouped read over every account (six
 *  reads in all, whatever the merchant count), joined here. */
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
      .where(and(eq(accountMembers.role, MEMBER_ROLE.OWNER), eq(accountMembers.status, MEMBER_STATUS.ACTIVE)))
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
      // Soft-deleted rows are not in a sequence (Recova's queue read: deleted_at is null).
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
  for (const o of owners) if (!ownerByAccount.has(o.accountId)) ownerByAccount.set(o.accountId, o.email);

  const connectionsByAccount = new Map<string, typeof connections>();
  for (const c of connections) {
    const list = connectionsByAccount.get(c.accountId) ?? [];
    list.push(c);
    connectionsByAccount.set(c.accountId, list);
  }

  const activeByAccount = new Map(activeCounts.map((r) => [r.accountId, r.n]));
  const failedByAccount = new Map(failedCounts.map((r) => [r.accountId, r.n]));
  const recoveredByAccount = new Map<string, { n: number; amounts: Array<{ currency: string; cents: number }> }>();
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
      connectionStatus: live.length > 0 ? "connected" : own.length > 0 ? "disconnected" : "never_connected",
      activeRecoveriesCount: activeByAccount.get(row.id) ?? 0,
      ownerEmail: ownerByAccount.get(row.id) ?? null,
      stripeUserId: shown?.stripeUserId ?? null,
      lastWebhookAt: shown?.lastWebhookAt ?? null,
      recoveryRatePct: failedCount > 0 ? Math.round(((recovered?.n ?? 0) / failedCount) * 100) : null,
      recovered: groupSumByCurrency(recovered?.amounts ?? []),
    };
  });
}

/** The admin API's merchants list (GET /merchants): the same rows, with the
 *  fields it has always returned and no more. */
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

/** Recova's five stat cards on its merchants page, from Foxhound's engine.
 *  Demo accounts are not counted, as Recova's platform figures left them out. */
export interface MerchantFigures {
  /** Accounts, demo ones not counted: the denominator for connectedCount. */
  merchantCount: number;
  /** Recova's "Est. MRR": each merchant's latest MRR snapshot, per currency
   *  (the Overview's "MRR under management"). */
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  /** Recova's "Stripe Connected": merchants with a live connection. */
  connectedCount: number;
  /** Recova's "Total Recovered": all time, every currency, deleted rows out. */
  totalRecovered: CurrencyAmount[];
  /** Recova's "Revenue (MTD)": recovery fees on invoices made since the first
   *  of this UTC month, a voided invoice left out. */
  recoveryFeesThisMonth: CurrencyAmount[];
  /** Recova's "Payments in Queue": failed payments in an active sequence,
   *  soft-deleted ones left out as Recova's read left them out. */
  paymentsInQueue: number;
}

const NOT_DEMO = notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`);

export async function getMerchantFigures(db: Db, nowMs: number): Promise<MerchantFigures> {
  const monthStart = new Date(startOfUtcMonthMs(nowMs));
  const [merchantRows, mrrByCurrency, connectedRows, recoveredRows, feeRows, paymentsInQueue] = await Promise.all([
    db.select({ n: count() }).from(accounts).where(NOT_DEMO),
    mrrUnderManagement(db),
    db
      .select({ n: sql<number>`count(distinct ${stripeConnections.accountId})` })
      .from(stripeConnections)
      .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
      .where(and(isNull(stripeConnections.disconnectedAt), NOT_DEMO)),
    db
      .select({ currency: recoveredPayments.currency, cents: sql<number>`coalesce(sum(${recoveredPayments.amountCents}), 0)` })
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
    // recoveries" can never disagree (PR 140 review).
    countActiveRecoveries(db),
  ]);
  const money = (rows: Array<{ currency: string; cents: number }>) =>
    groupSumByCurrency(rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) }))).filter((m) => m.cents !== 0);
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

/** What the Merchants page's action needs to know before it writes: that the
 *  account exists, its name for the result, and whether the brake owns its
 *  pause (a resume of that has no Undo). Null when there is no such account. */
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

// ============================================================================
// Pass 2: money-adjacent operator actions
// ============================================================================

/** Exempt or un-exempt an account from billing. Routes through the existing
 *  billing predicate: app/db/billable.ts's accountBillingEligibleCondition
 *  already checks billing_exempt, so this toggle alone is sufficient - there
 *  is no separate billing path to keep in sync. */
export async function setBillingExempt(db: Db, accountId: string, exempt: boolean): Promise<void> {
  await db.update(accounts).set({ billingExempt: exempt }).where(eq(accounts.id, accountId));
}

/** setBillingExempt, written only where the flag still holds the other value,
 *  in the same statement. Returns whether it changed, so the Merchants page
 *  offers Undo only for a real change: a stale row's "Set exempt" on a
 *  merchant someone else exempted changes nothing, and its Undo must not
 *  un-exempt them. */
export async function setBillingExemptIfChanged(db: Db, accountId: string, exempt: boolean): Promise<boolean> {
  const rows = await db
    .update(accounts)
    .set({ billingExempt: exempt })
    .where(and(eq(accounts.id, accountId), eq(accounts.billingExempt, !exempt)))
    .returning({ id: accounts.id });
  return rows.length > 0;
}

/** Pause or resume recovery/dispute processing. Honored by
 *  app/lib/cron/recovery-tick.ts's accountProcessingEligibleCondition and
 *  app/lib/intelligence/sync.server.ts's accountProcessingEligible, and (per
 *  PRICING.md) ALSO by the billing gate (app/db/billable.ts): a paused
 *  merchant is not billed while paused, which is deliberate and distinct from
 *  cancel (see cancelMerchant).
 *
 *  `reason` records WHY, and only the global emergency brake passes one
 *  (PAUSE_REASON_BRAKE). It is written in the same statement as the flag so the
 *  two can never disagree.
 *
 *  Three cases, and the middle one is a fix for review LOW-2:
 *
 *  - **Resume** always clears the reason. A human resuming a brake-paused
 *    merchant takes that row off the brake's books, which is the correct reading
 *    of a person overriding an automated hold.
 *  - **Pause with no explicit reason** (the single-merchant toggle) PRESERVES an
 *    existing reason and stamps 'manual' only when the row was actually
 *    unpaused. It used to overwrite unconditionally, so a stale
 *    /admin/merchants/:id form (rendered before the brake engaged, carrying
 *    nextPaused=true) silently converted a brake pause into a manual one and
 *    stranded that merchant paused after the next release. The CASE runs
 *    server-side in the same UPDATE rather than as a read-then-write, so two
 *    concurrent operators cannot interleave into a lost marker.
 *  - **Pause with an explicit reason** (the brake) sets it outright, but only
 *    where `guard` still holds. See the guard parameter.
 *
 *  `guard` is an optional extra condition ANDed into the WHERE, so the caller's
 *  OWN selection predicate is re-evaluated server-side at write time. The brake
 *  passes it and nothing else does (review MEDIUM-1): engage reads its eligible
 *  ids once and then writes them in chunks, so an account paused for cause
 *  between the read and its chunk was overwritten with the brake marker and
 *  resumed by the next release. That is the exact hazard the no-reason branch's
 *  CASE was added for, and the explicit-reason branch three lines up had kept
 *  the read-then-write shape that reasoning rejects.
 *
 *  The guard is a WHERE clause rather than a preserve-existing CASE on purpose.
 *  A CASE would keep the right reason but still write the row, leaving the
 *  caller unable to tell a real transition from a no-op; the WHERE skips the row
 *  outright, which is what makes the RETURNING count below honest.
 *
 *  Every branch RETURNs the id it changed. A guarded write that matched nothing
 *  returns no rows, so a caller can count rows actually TRANSITIONED rather than
 *  rows it selected (review INFO-2). */
export function buildSetProcessingPaused(
  db: Db,
  accountId: string,
  paused: boolean,
  reason: string | null = null,
  guard?: SQL,
) {
  const target = guard ? (and(eq(accounts.id, accountId), guard) as SQL) : eq(accounts.id, accountId);

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
  reason: string | null = null,
  guard?: SQL,
): Promise<void> {
  await buildSetProcessingPaused(db, accountId, paused, reason, guard);
}

/** Pauses or resumes one merchant only when the flag holds the other value,
 *  and says whether it moved, so the merchants page offers Undo only for a
 *  real change. With `undoOfPause`, a resume matches only a manual pause: an
 *  Undo of a pause can never take a merchant off the emergency brake, whose
 *  pause may have landed on the row since. */
export async function setProcessingPausedIfChanged(
  db: Db,
  accountId: string,
  paused: boolean,
  { undoOfPause = false }: { undoOfPause?: boolean } = {},
): Promise<boolean> {
  const from = eq(accounts.processingPaused, !paused);
  const guard = !paused && undoOfPause ? (and(from, eq(accounts.pauseReason, PAUSE_REASON_MANUAL)) as SQL) : from;
  const rows = await buildSetProcessingPaused(db, accountId, paused, null, guard);
  return rows.length > 0;
}

/** Whether an account currently holds an active Intelligence subscription row.
 *  Mirrors isIntelligenceEntitled's predicate (intelligence/views.server.ts)
 *  through the SAME constants, so a granted row provably flips that read-side gate. */
async function hasActiveIntelligence(db: Db, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ id: accountSubscriptions.id })
    .from(accountSubscriptions)
    .where(
      and(
        eq(accountSubscriptions.accountId, accountId),
        eq(accountSubscriptions.product, INTELLIGENCE_PRODUCT),
        eq(accountSubscriptions.status, SUBSCRIPTION_STATUS_ACTIVE),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Admin-grant the paid Intelligence tier to an account: one account_subscriptions
 * row (product='intelligence', status='active', admin_granted=true, NO stripe
 * fields). This is the minimum honest way to make the tier reachable (for a comped
 * merchant, for testing, for ourselves) WITHOUT faking a purchase; the self-serve
 * $199/mo Stripe flow + platform-subscription webhook is a separate, larger slice.
 *
 * PRICING.md: "admin-granted rows never touch Stripe APIs." And app/db/billable.ts
 * never reads account_subscriptions (it gates on accounts.billing_exempt), so this
 * write has ZERO billing-ledger effect: it flips isIntelligenceEntitled and nothing
 * else. Plain, account-scoped write, matching the billing_exempt/processing_paused
 * precedent above, deliberately NOT the money-write DO: that DO serializes
 * ledger BATCHES (outcomes, invoices, webhook claims); createAdjustment uses it
 * because it writes billing_invoices/line_items, this writes none. admin_granted=true
 * is the flag any future subscription-billing must honor to never charge a comp.
 *
 * Idempotent: account_subscriptions has no unique constraint, so an existing active
 * row makes this a no-op (checked in-function) rather than a duplicate. Returns
 * whether a new row was written, for the admin-audit metadata.
 */
export async function grantIntelligence(
  db: Db,
  accountId: string,
  now: Date,
): Promise<{ granted: boolean }> {
  if (await hasActiveIntelligence(db, accountId)) return { granted: false };
  await db.insert(accountSubscriptions).values({
    accountId,
    product: INTELLIGENCE_PRODUCT,
    status: SUBSCRIPTION_STATUS_ACTIVE,
    adminGranted: true,
    createdAt: now,
  });
  return { granted: true };
}

/** Revoke a granted Intelligence entitlement: deactivate every active intelligence
 *  row for the account (status='canceled', canceled_at stamped), so
 *  isIntelligenceEntitled returns false again. Idempotent by the WHERE clause (no
 *  active row means zero updates, never an error). Same plain-write rationale as
 *  grantIntelligence. Returns whether anything was deactivated, for the audit metadata. */
export async function revokeIntelligence(
  db: Db,
  accountId: string,
  now: Date,
): Promise<{ revoked: boolean }> {
  const wasActive = await hasActiveIntelligence(db, accountId);
  if (!wasActive) return { revoked: false };
  await db
    .update(accountSubscriptions)
    .set({ status: SUBSCRIPTION_STATUS_CANCELED, canceledAt: now })
    .where(
      and(
        eq(accountSubscriptions.accountId, accountId),
        eq(accountSubscriptions.product, INTELLIGENCE_PRODUCT),
        eq(accountSubscriptions.status, SUBSCRIPTION_STATUS_ACTIVE),
      ),
    );
  return { revoked: true };
}

export interface CancelledConnection {
  id: string;
  stripeUserId: string;
}

// Not a MoneyWriteBatch (app/db/money-write.ts): this batch is plain, not
// DO-routed (mirrors app/lib/disputes/approval.ts's OperationalBatch - a
// cancel is an account-state write, not outcome recording/attributed
// billing/a webhook claim).
type CancelBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/** Pure batch builder for the local half of cancel: stamps accounts.cancelledAt
 *  and disconnects every given connection, as ONE atomic batch. Compile-testable
 *  via .toSQL() like buildBillingInvoiceBatch (billing/run.ts), independent of
 *  whether a live D1 batch executor is available. */
export function buildCancelMerchantBatch(
  db: Db,
  accountId: string,
  connections: CancelledConnection[],
  now: Date,
): CancelBatch {
  return [
    db.update(accounts).set({ cancelledAt: now }).where(eq(accounts.id, accountId)),
    ...connections.map((c) =>
      db.update(stripeConnections).set({ disconnectedAt: now }).where(eq(stripeConnections.id, c.id)),
    ),
  ];
}

/**
 * The local half of cancel, wired to a real db: reads the active connections,
 * then commits buildCancelMerchantBatch atomically. Isolated from the Stripe
 * call so cancelMerchant can inject a fake here in tests without touching a
 * live D1 binding. Returns the connections that were just disconnected, so the
 * caller knows which ones still need a Stripe oauth.deauthorize call.
 */
export async function cancelMerchantLocal(db: Db, accountId: string, now: Date): Promise<CancelledConnection[]> {
  const activeConnections = await db
    .select({ id: stripeConnections.id, stripeUserId: stripeConnections.stripeUserId })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)));

  await db.batch(buildCancelMerchantBatch(db, accountId, activeConnections, now));

  return activeConnections;
}

export interface CancelMerchantResult {
  cancelledAt: Date;
  connectionsDisconnected: number;
  deauthorizeErrors: Array<{ connectionId: string; stripeUserId: string; error: string }>;
}

export interface CancelMerchantDeps {
  cancelLocal: (env: Env, accountId: string, now: Date) => Promise<CancelledConnection[]>;
  deauthorize: (env: Env, stripeUserId: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Cancel a merchant: commits the local state (deps.cancelLocal, default
 * cancelMerchantLocal) BEFORE any Stripe call. cancelledAt is a PROCESSING
 * gate only (recovery-tick, intelligence sync); it is deliberately absent from
 * app/db/billable.ts, so already-matured, unbilled recoveries/disputes still
 * bill at the next run unless the account is also billing_exempt (PRICING.md:
 * cancel never silently forgives owed fees). The Stripe oauth.deauthorize call
 * is best-effort AFTER the local commit: a deauthorize failure is logged and
 * returned for the caller to surface, but NEVER rolls back the local cancel -
 * the merchant is cancelled on our side regardless; the OAuth grant revoke is
 * a separate, retriable follow-up, same posture as the platform-charge
 * follow-up in billing/run.ts. Both deps default to the real IO; tests inject
 * fakes to prove the local-commit-first ordering and that a deauthorize
 * failure never leaves a half-cancelled account.
 */
export async function cancelMerchant(
  env: Env,
  accountId: string,
  deps: Partial<CancelMerchantDeps> = {},
): Promise<CancelMerchantResult> {
  const cancelLocal = deps.cancelLocal ?? ((e, id, now) => cancelMerchantLocal(getDb(e), id, now));
  const deauthorize = deps.deauthorize ?? deauthorizeConnectedAccount;
  const now = new Date();

  const disconnected = await cancelLocal(env, accountId, now);

  const deauthorizeErrors: CancelMerchantResult["deauthorizeErrors"] = [];
  for (const c of disconnected) {
    const result = await deauthorize(env, c.stripeUserId);
    if (!result.ok) {
      deauthorizeErrors.push({ connectionId: c.id, stripeUserId: c.stripeUserId, error: result.error ?? "unknown error" });
      console.error(`stripe deauthorize failed for account ${accountId} connection ${c.id}:`, result.error);
    }
  }

  return { cancelledAt: now, connectionsDisconnected: disconnected.length, deauthorizeErrors };
}

// ---------------------------------------------------------------------------
// S37: disconnect ONE connection from Settings (rulings 40 and 333).
//
// The same posture as cancelMerchant above, narrowed to a single connection:
// plain batch, local commit first, Stripe revoke best-effort after. 333 ruled
// this explicitly onto cancelMerchant's path and OFF executeMoneyWrite, because
// a second writer on stripe_connections.disconnected_at with a different
// atomicity guarantee is 262 decision five's shape one table over.
// ---------------------------------------------------------------------------

/** Stamps disconnectedAt and NOTHING else. is_primary deliberately survives:
 *  333 ruled against promotion and against clearing the flag, because legacy
 *  does neither. The three is_primary readers filter on disconnected_at
 *  instead, which is the change that makes the flag harmless. */
export function buildDisconnectConnectionBatch(db: Db, connectionId: string, now: Date): CancelBatch {
  return [
    db.update(stripeConnections).set({ disconnectedAt: now }).where(eq(stripeConnections.id, connectionId)),
  ];
}

export interface DisconnectConnectionResult {
  disconnectedAt: Date;
  /** Set when the OAuth revoke failed. The local disconnect still stands: the
   *  merchant asked to disconnect and IS disconnected, and the revoke is a
   *  retriable follow-up the caller surfaces as a warning, never a rollback. */
  deauthorizeError?: string;
}

export interface DisconnectConnectionDeps {
  deauthorize: (env: Env, stripeUserId: string) => Promise<{ ok: boolean; error?: string }>;
}

export async function disconnectConnection(
  env: Env,
  connection: { id: string; stripeUserId: string },
  deps: Partial<DisconnectConnectionDeps> = {},
): Promise<DisconnectConnectionResult> {
  const deauthorize = deps.deauthorize ?? deauthorizeConnectedAccount;
  const db = getDb(env);
  const now = new Date();

  await db.batch(buildDisconnectConnectionBatch(db, connection.id, now));

  const revoke = await deauthorize(env, connection.stripeUserId);
  if (!revoke.ok) {
    console.error(`stripe deauthorize failed for connection ${connection.id}:`, revoke.error);
    return { disconnectedAt: now, deauthorizeError: revoke.error ?? "unknown error" };
  }
  return { disconnectedAt: now };
}

/**
 * The ownership check, and the only one the Settings route gets. Filters on the
 * connection id AND the caller's ACTIVE account AND disconnected_at IS NULL, so
 * a connection under another account the caller holds is refused exactly like
 * one they do not hold at all, and an already-disconnected row cannot be
 * stamped twice. Returns null on every refusing case, which the route turns
 * into a 403 having written nothing.
 */
export async function findLiveConnection(
  db: Db,
  accountId: string,
  connectionId: string,
): Promise<{ id: string; stripeUserId: string } | null> {
  const rows = await db
    .select({ id: stripeConnections.id, stripeUserId: stripeConnections.stripeUserId })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.id, connectionId),
        eq(stripeConnections.accountId, accountId),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
