// The admin Users page's pure display helpers (not a .server module: the page
// renders them), tested without a database.

import { plural } from "~/lib/admin/overview";
import type { UserMembership } from "~/lib/admin/users.server";

/** The page's lists are pending while its own data is read again (the
 *  revalidator, or a navigation that lands on /admin/users), not while the
 *  admin is leaving for another page. */
export function usersPending(
  navigation: { state: string; location?: { pathname: string } },
  revalidatorState: string,
): boolean {
  if (revalidatorState === "loading") return true;
  return navigation.state === "loading" && navigation.location?.pathname === "/admin/users";
}

/** "3 people can sign in to Foxhound." */
export function usersCountSentence(n: number): string {
  return `${plural(n, "person", "people")} can sign in to Foxhound.`;
}

/** What follows an account's name: the role for an active member, "invited"
 *  for a pending invite, "invite expired" for one that can no longer be
 *  accepted. */
export function membershipWord(m: UserMembership): string {
  if (m.status === "active") return m.role;
  return m.inviteExpired ? "invite expired" : "invited";
}

export function merchantHref(accountId: string): string {
  return `/admin/merchants/${encodeURIComponent(accountId)}`;
}
