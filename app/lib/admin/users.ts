// The admin Users page's pure display helpers (not a .server module: the page
// renders them), tested without a database. Its pending state is the admin's
// shared usePagePending (Capsomer) and its account links are merchantHref
// (~/lib/admin/page).

import type { UserMembership } from "~/lib/admin/users.server";

export function membershipWord(m: UserMembership): string {
  if (m.status === "active") return m.role;
  return m.inviteExpired ? "invite expired" : "invited";
}
