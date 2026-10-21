// /admin/users data layer: platform users (Better Auth `user`), every business
// account each one belongs to, and when each last signed in. READ only.
//
// Recova's users page (app/admin/users/page.tsx) is the inventory of what the
// page shows: email, last sign-in, joined and the user id. Foxhound reads each
// from its own engine.

import { asc, desc, eq, inArray, max } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts, session, user } from "~/db";
import { normalizeInviteEmail } from "~/lib/auth/invites";
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
   *  Auth deletes a session on sign-out and on expiry, and its sign-in time
   *  goes with it, so this is the newest sign-in still on record. */
  lastSignInAt: Date | null;
  /** Every account this user belongs to, active first, then pending invites. */
  memberships: UserMembership[];
}

export async function listPlatformUsers(db: Db, env: Env, nowMs: number = Date.now()): Promise<PlatformUserRow[]> {
  // Three independent reads, run together.
  const [users, sessions, memberRows] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      })
      .from(user)
      .orderBy(desc(user.createdAt)),
    // A session is created at each sign-in. Better Auth deletes a session on
    // sign-out as well as on expiry, so the newest start here is the newest
    // sign-in still on record, not every sign-in there was. A durable last-login
    // column would need a migration and is left out of J45.
    db
      .select({ userId: session.userId, lastSignInAt: max(session.createdAt) })
      .from(session)
      .groupBy(session.userId),
    // A user can hold MANY account_members rows: one ACTIVE membership per
    // account they belong to (`account_members_user_account_active_uq`; ruling
    // 324 struck the index that capped this at one), plus pending invites.
    db
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
      .orderBy(asc(accounts.name), asc(accountMembers.accountId)),
  ]);
  if (users.length === 0) return [];

  const lastByUser = new Map(sessions.map((s) => [s.userId, s.lastSignInAt]));

  // A pending invite has no user id yet; it names the invited email. It is
  // matched to a person only when that person's email is verified, so an
  // unverified sign-up is never shown as invited to someone else's account.
  // Both sides are put in the one normal form invites are compared in.
  const verifiedEmailToId = new Map(
    users.filter((u) => u.emailVerified).map((u) => [normalizeInviteEmail(u.email), u.id]),
  );

  // Per user, one entry per account: an active membership wins over any invite
  // to the same account, and of several invites to one account the one that
  // can still be accepted is kept.
  const byUser = new Map<string, Map<string, UserMembership>>();
  for (const m of memberRows) {
    const userId =
      m.status === MEMBER_STATUS.ACTIVE
        ? m.userId
        : (m.userId ?? (m.invitedEmail ? verifiedEmailToId.get(normalizeInviteEmail(m.invitedEmail)) : undefined));
    if (!userId) continue;
    const entry: UserMembership = {
      accountId: m.accountId,
      accountName: m.accountName,
      role: m.role,
      status: m.status,
      inviteExpired:
        m.status === MEMBER_STATUS.PENDING && m.inviteExpiresAt !== null && m.inviteExpiresAt.getTime() <= nowMs,
    };
    const accountsForUser = byUser.get(userId) ?? new Map<string, UserMembership>();
    const existing = accountsForUser.get(m.accountId);
    if (!existing || rank(entry) < rank(existing)) accountsForUser.set(m.accountId, entry);
    byUser.set(userId, accountsForUser);
  }

  return users.map((u) => ({
    ...u,
    isAdmin: isAdminEmail(env, u.email),
    lastSignInAt: lastByUser.get(u.id) ?? null,
    // Active first; within each, by account name (the query's order, kept by
    // the map's insertion order and a stable sort).
    memberships: [...(byUser.get(u.id)?.values() ?? [])].sort(
      (a, b) => Number(a.status !== MEMBER_STATUS.ACTIVE) - Number(b.status !== MEMBER_STATUS.ACTIVE),
    ),
  }));
}

/** Which of two rows for one account to keep: active, then an invite that can
 *  still be accepted, then an expired invite. */
function rank(m: UserMembership): number {
  if (m.status === MEMBER_STATUS.ACTIVE) return 0;
  return m.inviteExpired ? 2 : 1;
}
