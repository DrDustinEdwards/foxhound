import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { stripeConnections } from "~/db";
import type { Db } from "~/db";

// Where a Stripe account is attached, asked once for the whole repo. Server-only code lives in a `*.server.ts` and a route module never reaches the database directly.

/** account_id = :accountId AND disconnected_at IS NULL: the account's live
 *  connections. The one spelling of "active connection" for an account. */
export function activeConnectionWhere(accountId: string): SQL {
  // and() of two defined conditions is always defined
  return and(
    eq(stripeConnections.accountId, accountId),
    isNull(stripeConnections.disconnectedAt),
  ) as SQL;
}

/** The account's live primary connection: activeConnectionWhere plus
 *  is_primary, the row sender settings and brand voice are read from.
 *  `accountId` may be an outer query's column, for a correlated subquery. */
export function activePrimaryConnectionWhere(accountId: string | AnySQLiteColumn): SQL {
  return and(
    eq(stripeConnections.accountId, accountId),
    eq(stripeConnections.isPrimary, true),
    isNull(stripeConnections.disconnectedAt),
  ) as SQL;
}

/** One column of the live primary connection of the account in `accountId` (an
 *  outer query's column), as a scalar subquery: null when there is none. */
export function primaryConnectionValue<T>(column: AnySQLiteColumn, accountId: AnySQLiteColumn) {
  return sql<T | null>`(
    select ${column} from ${stripeConnections}
    where ${activePrimaryConnectionWhere(accountId)}
    limit 1
  )`;
}

/** Every live connection of the account, with its encrypted access token. */
export function listActiveConnections(
  db: Db,
  accountId: string,
): Promise<{ id: string; stripeAccessToken: string | null }[]> {
  return db
    .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(activeConnectionWhere(accountId));
}

/**
 * The account's Stripe connection to read from: the earliest-connected still-active one (gotcha
 * #22).
 */
export async function findActiveConnection(
  db: Db,
  accountId: string,
): Promise<{ id: string; stripeAccessToken: string | null } | null> {
  const rows = await db
    .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(activeConnectionWhere(accountId))
    .orderBy(stripeConnections.connectedAt)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A DISCRIMINATED OUTCOME, never a bare id or null: "nobody holds it", "the caller holds it here"
 * and "somebody else holds it" are three different answers with three different responses, and
 * collapsing the last two into a nullable id is what makes call sites easy to get wrong.
 */
export type LiveAttachment =
  | { status: "unattached" }
  | { status: "held_by_caller"; accountId: string }
  | { status: "held_elsewhere" };

/**
 * Where a Stripe account is LIVE right now, from the WHOLE table. `heldAccountIds` decides only how
 * the answer is REPORTED, never what is searched. LIVE ONLY, matching the index that backs this. A
 * disconnected row is a history row: it must not refuse a reconnect, exactly as it does not violate
 * `stripe_connections_live_stripe_account_uq`.
 */
export async function findLiveAttachment(
  db: Db,
  stripeUserId: string,
  heldAccountIds: string[],
): Promise<LiveAttachment> {
  const rows = await db
    .select({ accountId: stripeConnections.accountId })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.stripeUserId, stripeUserId),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);

  const accountId = rows[0]?.accountId;
  if (!accountId) return { status: "unattached" };
  return heldAccountIds.includes(accountId)
    ? { status: "held_by_caller", accountId }
    : { status: "held_elsewhere" };
}
