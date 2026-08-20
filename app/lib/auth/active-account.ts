import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { session as sessionTable } from "~/db";

// The write half of the active-account marker (ruling 326 phase (b)). The READ
// half is resolveActiveMembershipFrom in account.ts; the column itself and the
// reasoning for putting it on the session row rather than in legacy's cookie are
// in the session.additionalFields block in options.ts.

/**
 * Point ONE session row at an account.
 *
 * MONEY-ADJACENT, NOT MONEY, so it deliberately does NOT go through
 * MoneyWriteDurableObject. ARCHITECTURE.md's rule is that a write rides the
 * money DO if it gates billing, is webhook-claim-driven, or links a Stripe
 * account or customer to an account. This does none of those: it changes which
 * account one browser session is LOOKING AT, and every downstream money write
 * still routes through the DO named by the account it resolves to, still
 * serialized per account. What makes it adjacent rather than inert is that it
 * decides which ledger the next money write lands on, which is why the caller
 * validates membership BEFORE calling this rather than trusting the input.
 *
 * SCOPED TO THE SESSION ROW, never to the user. Two browsers signed in as the
 * same person hold two session rows, so one can sit on Acme while the other sits
 * on Globex. Legacy gets the same property by accident, since its marker is a
 * cookie and cookies are per-browser; here it is a property of the WHERE clause
 * and is asserted rather than assumed.
 *
 * Written with Drizzle against the Better Auth session table rather than through
 * a Better Auth API: the framework exposes no supported "update a session field"
 * call, `additionalFields` is what makes the column part of the session Better
 * Auth reads back, and reaching into `$context.internalAdapter` would bet this
 * route on an internal surface. The table is in app/db/auth-schema.ts and is
 * generated, so this is the same schema Better Auth itself writes through.
 *
 * The session cookie is NOT touched. The marker is server-side per 326, so there
 * is nothing for a client to forge and nothing to keep in sync.
 */
export async function setSessionActiveAccount(
  db: Db,
  sessionId: string,
  accountId: string,
): Promise<void> {
  await db
    .update(sessionTable)
    .set({ activeAccountId: accountId })
    .where(eq(sessionTable.id, sessionId));
}

/**
 * Where to send the caller after a switch: the referer's path when the referer
 * is on THIS origin, otherwise "/".
 *
 * An attacker-controlled Referer must not become a redirect target. Comparing
 * ORIGINS rather than prefix-matching the string is the part that matters:
 * `startsWith("https://foxhoundapp.com")` also accepts
 * `https://foxhoundapp.com.evil.test/`, which is the classic way this check is
 * written wrong. Only pathname, search and hash survive, so a same-origin
 * referer cannot smuggle a host either.
 *
 * A missing, unparseable or cross-origin referer all fall to "/" rather than
 * failing the switch: the account HAS been switched by the time this runs, and
 * refusing to redirect would leave the user on a blank response wondering
 * whether it took.
 */
export function safeReturnPath(referer: string | null, requestUrl: string): string {
  if (!referer) return "/";
  let target: URL;
  let self: URL;
  try {
    target = new URL(referer);
    self = new URL(requestUrl);
  } catch {
    return "/";
  }
  if (target.origin !== self.origin) return "/";
  // Never bounce straight back into the switch endpoint itself.
  if (target.pathname === self.pathname) return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}
