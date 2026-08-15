// /admin/merchants data layer: list + detail (Pass 1, read-only) and the
// money-adjacent write actions (Pass 2): billing_exempt / processing_paused
// toggles and merchant cancel/disconnect. Adjustment creation lives in
// app/lib/billing/adjustment.ts (it flows through the billing ledger, not
// this file). Every write here is a plain, account-scoped db operation, not a
// money write (ARCHITECTURE.md's DO rule covers outcome recording, attributed
// billing, and webhook claims; a flag toggle or a connection-disconnect stamp
// is operational, matching the brand-voice-update / cron-toggle precedent).

import { and, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import {
  accountSubscriptions,
  accounts,
  billingInvoices,
  disputes,
  failedPayments,
  getDb,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import {
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

/** One row per (non-demo) account. Connection status and activity counts are
 *  per-account subqueries; platform scale (~hundreds of accounts pre-launch)
 *  keeps N+1-shaped small queries acceptable, matching the posture the rest
 *  of the admin surface takes (see overview.server.ts). */
export async function listMerchants(db: Db): Promise<MerchantListRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      createdAt: accounts.createdAt,
      billingExempt: accounts.billingExempt,
      processingPaused: accounts.processingPaused,
      cancelledAt: accounts.cancelledAt,
    })
    .from(accounts)
    .orderBy(desc(accounts.createdAt));

  const results: MerchantListRow[] = [];
  for (const row of rows) {
    const [activeConnection, anyConnection, activeRecoveries] = await Promise.all([
      db
        .select({ id: stripeConnections.id })
        .from(stripeConnections)
        .where(and(eq(stripeConnections.accountId, row.id), isNull(stripeConnections.disconnectedAt)))
        .limit(1),
      db.select({ id: stripeConnections.id }).from(stripeConnections).where(eq(stripeConnections.accountId, row.id)).limit(1),
      db
        .select({ n: count() })
        .from(failedPayments)
        .where(and(eq(failedPayments.accountId, row.id), eq(failedPayments.status, "active"))),
    ]);

    const connectionStatus: MerchantListRow["connectionStatus"] =
      activeConnection.length > 0 ? "connected" : anyConnection.length > 0 ? "disconnected" : "never_connected";

    results.push({
      ...row,
      connectionStatus,
      activeRecoveriesCount: activeRecoveries[0]?.n ?? 0,
    });
  }
  return results;
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
