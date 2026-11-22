import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { session as sessionTable } from "~/db";

// The write half of the active-account marker.

/**
 * Point ONE session row at an account.
 *
 * MONEY-ADJACENT, NOT MONEY, so it deliberately does NOT go through
 * MoneyWriteDurableObject. ARCHITECTURE.md's rule is that a write rides the
 * money DO if it gates billing, is webhook-claim-driven, or links a Stripe
 * account or customer to an account.
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
 * An attacker-controlled Referer must not become a redirect target. Only
 * pathname, search and hash survive, so a same-origin referer cannot smuggle a
 * host either.
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
