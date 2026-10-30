// The account deletion confirmation, per case (row S40, review fix F2). A
// deletion clears every account the person OWNS and only removes them from the
// rest, so the copy names what will actually go: nothing but the login for a
// member who owns no account, the one owned account by name, or every owned
// account by name when there are several. Pure, so the route and its tests
// share it.

import { MEMBER_ROLE } from "./roles";

/** The names of the accounts a deletion clears: the person's active
 *  memberships (the session's, the list the switcher shows) where they are the
 *  owner, the predicate readDeletionPlan acts on. Taken from the session so the
 *  settings loader reads no other account's rows. */
export function ownedAccountNames(memberships: Array<{ accountName: string | null; role: string }>): Array<string | null> {
  return memberships.filter((m) => m.role === MEMBER_ROLE.OWNER).map((m) => m.accountName);
}

const KEPT =
  "Foxhound keeps the amounts, dates and Stripe ids of the payments it recovered, because its fees are billed on them.";
const FINAL = "This cannot be undone.";

function label(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : "an unnamed account";
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function deletionConsequence(ownedAccountNames: Array<string | null>): string {
  const n = ownedAccountNames.length;
  if (n === 0) {
    return `This will permanently delete your login and your personal data, and remove you from every account you belong to. You own no account, so no account's data is deleted and each account's owner keeps it. ${FINAL}`;
  }
  const what = "permanently delete your login and your personal data, and";
  const clears =
    "removing your customers' names and emails and canceling all active recovery sequences.";
  if (n === 1) {
    return `This will ${what} clear the account you own, ${label(ownedAccountNames[0] ?? null)}, ${clears} ${KEPT} ${FINAL}`;
  }
  const names = list(ownedAccountNames.map(label));
  return `This will ${what} clear all ${n} accounts you own (${names}), not only the one you are viewing, ${clears} ${KEPT} ${FINAL}`;
}
