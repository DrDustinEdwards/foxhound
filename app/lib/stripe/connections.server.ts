import { and, eq, isNull, type SQL } from "drizzle-orm";

import { stripeConnections } from "~/db";
import type { Db } from "~/db";

// Where a Stripe account is attached, asked once for the whole repo.
//
// MOVED HERE IN PHASE (f), FROM app/routes/auth/connect-callback.ts, and the
// move is a server-boundary fix rather than tidying. The anonymous audit's live
// results page is a `.tsx` route with a default export, and importing this
// predicate from a ROUTE module put `getDb`, `executeMoneyWrite` and
// `encryptToken` on that page's client graph. This repo's standing rule is that
// a route module never reaches the database directly and server-only code lives
// in a `*.server.ts`; the predicate now does.
//
// STILL EXACTLY ONE PREDICATE (356 binding 2, DEFECT 4). That ruling exists
// because two callers asked this question differently and only one of them asked
// it properly, so a Stripe account live on a stranger's Foxhound account read as
// unattached and a second live row was written. Three callers now share this one
// implementation: both connect-callback branches and the audit results page,
// which uses it to decide whether a run may be filed into a merchant's history.

/** account_id = :accountId AND disconnected_at IS NULL: the account's live
 *  connections. The one spelling of "active connection" for an account. */
export function activeConnectionWhere(accountId: string): SQL {
  // and() of two defined conditions is always defined
  return and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)) as SQL;
}

/** The account's live primary connection: activeConnectionWhere plus
 *  is_primary, the row sender settings and brand voice are read from. */
export function activePrimaryConnectionWhere(accountId: string): SQL {
  return and(
    eq(stripeConnections.accountId, accountId),
    eq(stripeConnections.isPrimary, true),
    isNull(stripeConnections.disconnectedAt),
  ) as SQL;
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
 * The account's Stripe connection to read from: the earliest-connected
 * still-active one (gotcha #22). For callers with no per-row hint to tell
 * apart an account's several active connections; card-update.tsx's
 * resolveConnectionForFailedPayment has one and does not use this.
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
 * A DISCRIMINATED OUTCOME, never a bare id or null: "nobody
 * holds it", "the caller holds it here" and "somebody else holds it" are three
 * different answers with three different responses, and collapsing the last two
 * into a nullable id is what made the old call sites easy to get wrong.
 */
export type LiveAttachment =
  | { status: "unattached" }
  | { status: "held_by_caller"; accountId: string }
  | { status: "held_elsewhere" };

/**
 * Where a Stripe account is LIVE right now, from the WHOLE table.
 *
 * The scan is deliberately unscoped: narrowing it to the caller's own accounts
 * is the exact bug 356 fixed. `heldAccountIds` decides only how the answer is
 * REPORTED, never what is searched.
 *
 * LIVE ONLY, matching the index that backs this. A disconnected row is a history
 * row: it must not refuse a reconnect, exactly as it does not violate
 * `stripe_connections_live_stripe_account_uq`. That index makes at most one live
 * row possible, so `.limit(1)` is a fact about the data rather than a choice
 * about which of several rows to prefer.
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
