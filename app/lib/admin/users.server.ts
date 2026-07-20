// /admin/users data layer: platform users (Better Auth `user`) + their
// business-account membership + role. READ only.

import { desc, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts, user } from "~/db";
import { isAdminEmail } from "~/lib/auth/roles";

export interface PlatformUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  isAdmin: boolean;
  accountId: string | null;
  accountName: string | null;
  role: string | null;
  memberStatus: string | null;
}

export async function listPlatformUsers(db: Db, env: Env): Promise<PlatformUserRow[]> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      accountId: accountMembers.accountId,
      accountName: accounts.name,
      role: accountMembers.role,
      memberStatus: accountMembers.status,
    })
    .from(user)
    .leftJoin(accountMembers, eq(accountMembers.userId, user.id))
    .leftJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .orderBy(desc(user.createdAt));

  // A user can have more than one account_members row (the single-account
  // invariant is app-enforced, not schema-enforced - see backlog.md's open
  // Phase 4 review item), which would otherwise duplicate this user across
  // rows. Collapse to one row per user, preferring an ACTIVE membership over
  // a pending invite, so the admin list always shows one line per person.
  const byUser = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byUser.get(row.id);
    if (!existing || (existing.memberStatus !== "active" && row.memberStatus === "active")) {
      byUser.set(row.id, row);
    }
  }

  return [...byUser.values()].map((r) => ({ ...r, isAdmin: isAdminEmail(env, r.email) }));
}
