// Canceling a merchant and disconnecting one Stripe connection
// (merchants.server.ts split): the local batches and the Stripe deauthorize
// around them.

import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type Db, accounts, getDb, stripeConnections } from "~/db";
import { deauthorizeConnectedAccount } from "~/lib/stripe/connect";
import { revokeDisconnectedGrants } from "~/lib/stripe/deauthorize-retry.server";

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
 * is best-effort AFTER the local commit: a deauthorize failure is logged,
 * queued for the daily stripe-deauthorize-retry cron, and returned for the
 * caller to surface, but NEVER rolls back the local cancel - the merchant is
 * canceled on our side regardless. Both deps default to the real IO; tests inject
 * fakes to prove the local-commit-first ordering and that a deauthorize
 * failure never leaves a half-canceled account.
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

  const deauthorizeErrors = await revokeDisconnectedGrants(env, disconnected, now, deauthorize);

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

  const [failure] = await revokeDisconnectedGrants(env, [connection], now, deauthorize);
  return failure ? { disconnectedAt: now, deauthorizeError: failure.error } : { disconnectedAt: now };
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
