import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts } from "~/db";

import { INVITE_TTL_MS, MEMBER_ROLE, MEMBER_STATUS } from "./roles";

// Resolves the Better Auth user -> business account relationship, and owns the
// account_members lifecycle (create account, invite, accept). Single-account per
// user for the rebuild (legacy model); multi-account switching is out of scope.

export interface Membership {
  memberId: string;
  accountId: string;
  accountName: string | null;
  role: string;
}

/** The user's active account membership, or null if they have no account yet. */
export async function resolveMembership(
  db: Db,
  userId: string,
): Promise<Membership | null> {
  const rows = await db
    .select({
      memberId: accountMembers.id,
      accountId: accountMembers.accountId,
      accountName: accounts.name,
      role: accountMembers.role,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accountMembers.accountId, accounts.id))
    .where(
      and(
        eq(accountMembers.userId, userId),
        eq(accountMembers.status, MEMBER_STATUS.ACTIVE),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create a fresh account owned by the user, as one atomic batch (account row +
 * owner membership together or neither). Not a money write, so a plain D1 batch
 * is the right atomicity primitive here.
 */
export async function createAccountForUser(
  db: Db,
  userId: string,
  name: string,
): Promise<string> {
  const accountId = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(accounts).values({ id: accountId, name, createdAt: now }),
    db.insert(accountMembers).values({
      id: crypto.randomUUID(),
      accountId,
      userId,
      role: MEMBER_ROLE.OWNER,
      status: MEMBER_STATUS.ACTIVE,
      createdAt: now,
    }),
  ]);
  return accountId;
}

export interface InviteView {
  memberId: string;
  accountId: string;
  accountName: string | null;
  invitedEmail: string | null;
}

/** A pending, unexpired invite for a token, with its account name. */
export async function getInviteByToken(
  db: Db,
  token: string,
): Promise<InviteView | null> {
  const rows = await db
    .select({
      memberId: accountMembers.id,
      accountId: accountMembers.accountId,
      accountName: accounts.name,
      invitedEmail: accountMembers.invitedEmail,
      status: accountMembers.status,
      inviteExpiresAt: accountMembers.inviteExpiresAt,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accountMembers.accountId, accounts.id))
    .where(eq(accountMembers.inviteToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.status !== MEMBER_STATUS.PENDING) return null;
  if (row.inviteExpiresAt && row.inviteExpiresAt.getTime() < Date.now()) return null;
  return {
    memberId: row.memberId,
    accountId: row.accountId,
    accountName: row.accountName,
    invitedEmail: row.invitedEmail,
  };
}

/** Create a pending team-member invite. Returns the token for the invite link. */
export async function createInvite(
  db: Db,
  accountId: string,
  email: string,
): Promise<{ token: string; memberId: string }> {
  const token = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const now = new Date();
  await db.insert(accountMembers).values({
    id: memberId,
    accountId,
    userId: null,
    role: MEMBER_ROLE.MEMBER,
    invitedEmail: email.trim().toLowerCase(),
    status: MEMBER_STATUS.PENDING,
    inviteToken: token,
    inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdAt: now,
  });
  return { token, memberId };
}

export type AcceptInviteResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "invalid" | "email_mismatch" };

/**
 * Accept a pending invite for the signed-in user. The invited email must match
 * the accepting user's email (invite is not transferable). Activates the member
 * row and clears the token.
 */
export async function acceptInvite(
  db: Db,
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptInviteResult> {
  const invite = await getInviteByToken(db, token);
  if (!invite) return { ok: false, reason: "invalid" };
  if (
    !invite.invitedEmail ||
    invite.invitedEmail !== userEmail.trim().toLowerCase()
  ) {
    return { ok: false, reason: "email_mismatch" };
  }

  await db
    .update(accountMembers)
    .set({
      userId,
      status: MEMBER_STATUS.ACTIVE,
      inviteToken: null,
      inviteExpiresAt: null,
    })
    .where(eq(accountMembers.id, invite.memberId));
  return { ok: true, accountId: invite.accountId };
}

/** Pending + active members of an account, for the team settings view. */
export async function listMembers(db: Db, accountId: string) {
  return db
    .select({
      id: accountMembers.id,
      userId: accountMembers.userId,
      invitedEmail: accountMembers.invitedEmail,
      role: accountMembers.role,
      status: accountMembers.status,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
}
