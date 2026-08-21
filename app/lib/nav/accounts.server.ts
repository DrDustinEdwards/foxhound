import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "~/db";
import { stripeConnections } from "~/db";
import type { Membership } from "~/lib/auth/account";

// The account switcher's data, assembled the way legacy assembles it.
//
// RULING 328 PUT THIS IN THE NAV'S OWN LOADER, NOT THE AUTH CHOKEPOINT, and
// legacy agrees: `resolveAccount` (lib/account.ts, blob `9bb58874`) never joins
// `stripe_connections`, and components/SiteNav.tsx:73-90 (blob `21f28324`) runs
// a SEPARATE query over the memberships it already has. Keeping it here is what
// stops a stripe_connections join landing on the path of every authenticated
// request, including the money routes, for a value only the header reads.

export interface SwitcherAccount {
  id: string;
  name: string | null;
  /** The PRIMARY connection's Stripe account id, or null when the account has
   *  no primary connection. Null is a real state, not a gap: legacy's map lookup
   *  is `stripeUserIdByAccountId.get(id) ?? null` (SiteNav.tsx:88), and an
   *  account created but not yet connected genuinely has none. The label falls
   *  back through it rather than showing a placeholder. */
  stripeUserId: string | null;
}

/**
 * `{id, name, stripe_user_id}[]` for the memberships the caller holds.
 *
 * ONE query for every account at once, keyed by `is_primary`, exactly legacy's
 * `.in('account_id', accountIds).eq('is_primary', true)`. The membership list is
 * the caller's, so this cannot widen past accounts they already hold: the query
 * is scoped by ids that came out of `account_members` for this user.
 *
 * An empty membership list short-circuits without touching the database, which
 * also keeps the anonymous marketing loader at zero DB reads (ruling 59's rule
 * for that surface) since it never gets here with memberships in hand.
 *
 * NOT FILTERED ON `disconnected_at`, deliberately, because legacy is not
 * either: SiteNav.tsx filters on `is_primary` alone. A disconnected primary
 * still names the Stripe account this Foxhound account belonged to, which is
 * what the label wants. `stripe_connections_account_primary_idx` in legacy does
 * carry the `disconnected_at IS NULL` half, but it is an index for a different
 * query, not this one.
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
        inArray(stripeConnections.accountId, accountIds),
        eq(stripeConnections.isPrimary, true),
      ),
    );

  const byAccountId = new Map(connections.map((c) => [c.accountId, c.stripeUserId]));

  return memberships.map((m) => ({
    id: m.accountId,
    name: m.accountName,
    stripeUserId: byAccountId.get(m.accountId) ?? null,
  }));
}
