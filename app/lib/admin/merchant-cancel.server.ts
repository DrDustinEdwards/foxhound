// Canceling a merchant and disconnecting one Stripe connection
// (merchants.server.ts split): the local batches and the Stripe deauthorize
// around them.

import { and, eq, exists, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type Db, accounts, getDb, stripeConnections } from "~/db";
import {
  buildAdminAuditLogInsert,
  logAdminAction,
  type LogAdminActionInput,
} from "~/lib/admin/audit.server";
import { deauthorizeConnectedAccount } from "~/lib/stripe/connect";
import { activeConnectionWhere } from "~/lib/stripe/connections.server";
import { revokeDisconnectedGrants } from "~/lib/stripe/deauthorize-retry.server";

interface CancelledConnection {
  id: string;
  stripeUserId: string;
}

// Not a MoneyWriteBatch (app/db/money-write.ts): this batch is plain, not
// DO-routed (mirrors app/lib/disputes/approval.ts's OperationalBatch - a cancel
// is an account-state write, not outcome recording/attributed billing/a webhook
// claim).
type CancelBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/**
 * Pure batch builder for the local half of cancel: stamps accounts.cancelledAt
 * and disconnects every given connection, as ONE atomic batch. Compile-testable
 * via .toSQL() like buildBillingInvoiceBatch (billing/run.ts), independent of
 * whether a live D1 batch executor is available.
 */
function buildCancelMerchantBatch(
  db: Db,
  accountId: string,
  connections: CancelledConnection[],
  now: Date,
): CancelBatch {
  // Each disconnect is joined to the account stamp it depends on (hard rule 3):
  // it fires only where the account row now carries THIS cancel's stamp, so an
  // unknown account id disconnects nothing even though D1 runs the rest of a
  // batch after a zero-row UPDATE.
  const cancelledNow = exists(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.cancelledAt, now))),
  );
  return [
    db
      .update(accounts)
      .set({ cancelledAt: now })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id }),
    ...connections.map((c) =>
      db
        .update(stripeConnections)
        .set({ disconnectedAt: now })
        .where(
          and(
            eq(stripeConnections.id, c.id),
            eq(stripeConnections.accountId, accountId),
            cancelledNow,
          ),
        ),
    ),
  ];
}

/**
 * The local half of cancel, wired to a real db: reads the active connections,
 * then commits buildCancelMerchantBatch atomically. Isolated from the Stripe
 * call so cancelMerchant can inject a fake here in tests without touching a
 * live D1 binding.
 */
async function cancelMerchantLocal(
  db: Db,
  accountId: string,
  now: Date,
  audit?: LogAdminActionInput,
): Promise<CancelledConnection[]> {
  const activeConnections = await db
    .select({ id: stripeConnections.id, stripeUserId: stripeConnections.stripeUserId })
    .from(stripeConnections)
    .where(activeConnectionWhere(accountId));

  // The admin's audit row commits in the same batch as the cancel, so the
  // cancel never stands without its record.
  const auditInsert = audit
    ? [
        buildAdminAuditLogInsert(db, {
          ...audit,
          metadata: {
            ...audit.metadata,
            accountId,
            connectionsDisconnected: activeConnections.length,
          },
        }).statement,
      ]
    : [];
  const [stamped] = (await db.batch([
    ...buildCancelMerchantBatch(db, accountId, activeConnections, now),
    ...auditInsert,
  ] as CancelBatch)) as unknown[];
  // A zero-row account UPDATE is a failure, not a cancel: no such account.
  if (!Array.isArray(stamped) || stamped.length === 0) {
    throw new Error(`cancelMerchant: no account ${accountId} to cancel`);
  }

  return activeConnections;
}

export interface CancelMerchantResult {
  cancelledAt: Date;
  connectionsDisconnected: number;
  deauthorizeErrors: Array<{ connectionId: string; stripeUserId: string; error: string }>;
}

export interface CancelMerchantDeps {
  cancelLocal: (
    env: Env,
    accountId: string,
    now: Date,
    audit?: LogAdminActionInput,
  ) => Promise<CancelledConnection[]>;
  deauthorize: (env: Env, stripeUserId: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Cancel a merchant: commits the local state (deps.cancelLocal, default
 * cancelMerchantLocal) BEFORE any Stripe call. cancelledAt is a PROCESSING gate
 * only (recovery-tick, intelligence sync); it is deliberately absent from
 * app/db/billable.ts, so already-matured, unbilled recoveries/disputes still
 * bill at the next run unless the account is also billing_exempt (PRICING.md:
 * cancel never silently forgives owed fees). The Stripe oauth.deauthorize call
 * is best-effort AFTER the local commit: a deauthorize failure is logged,
 * queued for the daily stripe-deauthorize-retry cron, and returned for the
 * caller to surface, but NEVER rolls back the local cancel - the merchant is
 * canceled on our side regardless.
 */
export async function cancelMerchant(
  env: Env,
  accountId: string,
  deps: Partial<CancelMerchantDeps> = {},
  /** An admin's cancel: its audit row commits with the local cancel. */
  audit?: LogAdminActionInput,
): Promise<CancelMerchantResult> {
  const cancelLocal =
    deps.cancelLocal ?? ((e, id, now, a) => cancelMerchantLocal(getDb(e), id, now, a));
  const deauthorize = deps.deauthorize ?? deauthorizeConnectedAccount;
  const now = new Date();

  const disconnected = await cancelLocal(env, accountId, now, audit);

  const deauthorizeErrors = await revokeDisconnectedGrants(env, disconnected, now, deauthorize);
  // The revoke runs after the commit, so its failures are their own row.
  if (audit && deauthorizeErrors.length > 0) {
    await logAdminAction(getDb(env), {
      actorEmail: audit.actorEmail,
      action: "merchant.cancel.revoke_failed",
      metadata: { accountId, deauthorizeErrors },
    });
  }

  return { cancelledAt: now, connectionsDisconnected: disconnected.length, deauthorizeErrors };
}

// The same posture as cancelMerchant above, narrowed to a single connection:
// plain batch, local commit first, Stripe revoke best-effort after.

// The stamp matches only a live connection of this account and returns the row
// it changed, so a connection that is unknown, another account's or already
// disconnected matches nothing and is told apart (hard rule 3).
function buildDisconnectConnectionBatch(
  db: Db,
  accountId: string,
  connectionId: string,
  now: Date,
) {
  return [
    db
      .update(stripeConnections)
      .set({ disconnectedAt: now })
      .where(
        and(
          eq(stripeConnections.id, connectionId),
          eq(stripeConnections.accountId, accountId),
          isNull(stripeConnections.disconnectedAt),
        ),
      )
      .returning({ id: stripeConnections.id }),
  ] as const;
}

/**
 * The local half of disconnectConnection alone, for a grant Stripe has already
 * revoked (account.application.deauthorized): the merchant cut Foxhound off
 * from their Stripe dashboard, so there is nothing left to revoke and no retry
 * to queue. The same batch, so stripe_connections.disconnected_at keeps one
 * writer.
 */
export async function disconnectConnectionLocal(
  db: Db,
  accountId: string,
  connectionId: string,
  now: Date,
): Promise<boolean> {
  const [stamped] = await db.batch(
    buildDisconnectConnectionBatch(db, accountId, connectionId, now),
  );
  return stamped.length > 0;
}

export interface DisconnectConnectionResult {
  disconnectedAt: Date;
  /**
   * Set when the OAuth revoke failed. The local disconnect still stands: the
   * merchant asked to disconnect and IS disconnected, and the revoke is a
   * retriable follow-up the caller surfaces as a warning, never a rollback.
   */
  deauthorizeError?: string;
}

export interface DisconnectConnectionDeps {
  deauthorize: (env: Env, stripeUserId: string) => Promise<{ ok: boolean; error?: string }>;
}

export async function disconnectConnection(
  env: Env,
  accountId: string,
  connection: { id: string; stripeUserId: string },
  deps: Partial<DisconnectConnectionDeps> = {},
): Promise<DisconnectConnectionResult> {
  const deauthorize = deps.deauthorize ?? deauthorizeConnectedAccount;
  const now = new Date();

  // Nothing changed, so nothing is revoked at Stripe.
  if (!(await disconnectConnectionLocal(getDb(env), accountId, connection.id, now))) {
    throw new Error(`disconnectConnection: no live connection ${connection.id} on ${accountId}`);
  }

  const [failure] = await revokeDisconnectedGrants(env, [connection], now, deauthorize);
  return failure
    ? { disconnectedAt: now, deauthorizeError: failure.error }
    : { disconnectedAt: now };
}

/**
 * The ownership check, and the only one the Settings route gets. Filters on the
 * connection id AND the caller's ACTIVE account AND disconnected_at IS NULL, so
 * a connection under another account the caller holds is refused exactly like
 * one they do not hold at all, and an already-disconnected row cannot be
 * stamped twice.
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
