// The admin Users page's pure display helpers (not a .server module: the page
// renders them), tested without a database. Its pending state is the admin's
// shared pagePending and its account links are merchantHref (~/lib/admin/page).

import { plural } from "~/lib/admin/overview";
import type { UserMembership } from "~/lib/admin/users.server";

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
