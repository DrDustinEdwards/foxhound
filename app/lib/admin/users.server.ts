// /admin/users data layer: platform users (Better Auth `user`), every business
// account each one belongs to, and when each last signed in. READ only.
//
// Recova's users page (app/admin/users/page.tsx) is the inventory of what the
// page shows: email, last sign-in, joined and the user id. Foxhound reads each
// from its own engine.

import { asc, desc, eq, inArray, max } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts, session, user } from "~/db";
import { MEMBER_STATUS, isAdminEmail } from "~/lib/auth/roles";

export interface UserMembership {
  accountId: string;
  accountName: string | null;
  role: string;
  status: string;
  /** A pending invite past its expiry: it can no longer be accepted. */
  inviteExpired: boolean;
}

export interface PlatformUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  isAdmin: boolean;
  /** The newest session's start, or null when no session is on record. Better
   *  Auth deletes expired sessions, and their sign-in times go with them. */
  lastSignInAt: Date | null;
  /** Every account this user belongs to, active first, then pending invites. */
  memberships: UserMembership[];
}

export async function listPlatformUsers(db: Db, env: Env, nowMs: number = Date.now()): Promise<PlatformUserRow[]> {
  const users = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(desc(user.createdAt));
  if (users.length === 0) return [];

  // A session is created at each sign-in, so the newest one's start is the last
  // sign-in that is still on record.
  const sessions = await db
    .select({ userId: session.userId, lastSignInAt: max(session.createdAt) })
    .from(session)
    .groupBy(session.userId);
  const lastByUser = new Map(sessions.map((s) => [s.userId, s.lastSignInAt]));

  // A user can hold MANY account_members rows: one ACTIVE membership per
  // account they belong to (`account_members_user_account_active_uq`; ruling
  // 324 struck the index that capped this at one), plus pending invites. A
  // pending invite has no user id yet; it names the invited email, stored
  // lowercased, so it is matched to the person by their email.
  const emailToId = new Map(users.map((u) => [u.email.trim().toLowerCase(), u.id]));
  const memberRows = await db
    .select({
      userId: accountMembers.userId,
      invitedEmail: accountMembers.invitedEmail,
      accountId: accountMembers.accountId,
      accountName: accounts.name,
      role: accountMembers.role,
      status: accountMembers.status,
      inviteExpiresAt: accountMembers.inviteExpiresAt,
    })
    .from(accountMembers)
    .leftJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(inArray(accountMembers.status, [MEMBER_STATUS.ACTIVE, MEMBER_STATUS.PENDING]))
    .orderBy(asc(accounts.name), asc(accountMembers.accountId));

  const byUser = new Map<string, UserMembership[]>();
  for (const m of memberRows) {
    const userId =
      m.status === MEMBER_STATUS.ACTIVE ? m.userId : (m.userId ?? emailToId.get((m.invitedEmail ?? "").toLowerCase()));
    if (!userId) continue;
    const list = byUser.get(userId) ?? [];
    list.push({
      accountId: m.accountId,
      accountName: m.accountName,
      role: m.role,
      status: m.status,
      inviteExpired:
        m.status === MEMBER_STATUS.PENDING && m.inviteExpiresAt !== null && m.inviteExpiresAt.getTime() <= nowMs,
    });
    byUser.set(userId, list);
  }

  return users.map((u) => ({
    ...u,
    isAdmin: isAdminEmail(env, u.email),
    lastSignInAt: lastByUser.get(u.id) ?? null,
    // Active first; within each, by account name (the query's order, kept by a
    // stable sort).
    memberships: (byUser.get(u.id) ?? []).sort(
      (a, b) => Number(a.status !== MEMBER_STATUS.ACTIVE) - Number(b.status !== MEMBER_STATUS.ACTIVE),
    ),
  }));
}
