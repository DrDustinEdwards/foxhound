import { and, eq, isNull } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";

import type { Db } from "~/db";
import { stripeConnections } from "~/db";
import type { Membership } from "~/lib/auth/account";

// Keeping it here is what stops a stripe_connections join landing on the path of every
// authenticated request, including the money routes, for a value only the header reads.

export interface SwitcherAccount {
  id: string;
  name: string | null;
  /**
   * The PRIMARY connection's Stripe account id, or null when the account has no primary connection.
   */
  stripeUserId: string | null;
}

/**
 * `{id, name, stripe_user_id}[]` for the memberships the caller holds. An empty membership list
 * short-circuits without touching the database, which also keeps the anonymous marketing loader at
 * zero DB reads since it never gets here with memberships in hand. The flag is only harmless
 * because its readers filter, and this is reader 1 of the three.
 */
export async function listSwitcherAccounts(
  db: Db,
  memberships: Membership[],
): Promise<SwitcherAccount[]> {
  if (memberships.length === 0) return [];

  const accountIds = memberships.map((m) => m.accountId);
  const connections = await db
    .select({
      accountId: stripeConnections.accountId,
      stripeUserId: stripeConnections.stripeUserId,
    })
    .from(stripeConnections)
    .where(
      and(
        inList(stripeConnections.accountId, accountIds),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    );

  const byAccountId = new Map(connections.map((c) => [c.accountId, c.stripeUserId]));

  return memberships.map((m) => ({
    id: m.accountId,
    name: m.accountName,
    stripeUserId: byAccountId.get(m.accountId) ?? null,
  }));
}
