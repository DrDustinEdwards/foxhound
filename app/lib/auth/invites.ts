// Account invites (account.ts split): reading an invite by token, creating one,
// and accepting it into a membership.

import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { and, eq, inArray } from "drizzle-orm";
import { type Db, accountMembers, accounts } from "~/db";
import { INVITE_TTL_MS, MEMBER_ROLE, MEMBER_STATUS } from "./roles";
import { isUniqueConstraintError } from "~/lib/money/serializer";
import { type Membership, findActiveMembership } from "./account";

export interface InviteView {
  memberId: string;
  accountId: string;
  accountName: string | null;
  invitedEmail: string | null;
}

/**
 * The stored forms that match a link's token: its SHA-256 (every invite from
 * createInvite) or the raw token of an invite made before the hash. A raw token
 * is a uuid and never 64 hex characters, so the two cannot collide. The raw
 * form can go once INVITE_TTL_MS has passed since the hash shipped.
 */
async function storedTokenForms(token: string): Promise<string[]> {
  return [await sha256Hex(token), token];
}

export async function getInviteByToken(db: Db, token: string): Promise<InviteView | null> {
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
    .where(inArray(accountMembers.inviteToken, await storedTokenForms(token)))
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

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hasOpenInviteForEmail(
  db: Db,
  accountId: string,
  email: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: accountMembers.id })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.invitedEmail, normalizeInviteEmail(email)),
        inArray(accountMembers.status, [MEMBER_STATUS.ACTIVE, MEMBER_STATUS.PENDING]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

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
    invitedEmail: normalizeInviteEmail(email),
    status: MEMBER_STATUS.PENDING,
    inviteToken: await sha256Hex(token),
    inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdAt: now,
  });
  return { token, memberId };
}

export type AcceptInviteResult =
  | { ok: true; accountId: string; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "email_mismatch" };

/**
 * Pure decision for whether a fetched invite can be accepted by this user: the
 * invite must exist, and the invited email must match, because invites are not
 * transferable. Split from `acceptInvite` so both rejection branches are
 * unit-testable without a database.
 */
export function evaluateAcceptInvite(
  invite: InviteView | null,
  existingOnInvitedAccount: Membership | null,
  userEmail: string,
): AcceptInviteResult {
  if (!invite) return { ok: false, reason: "invalid" };
  if (!invite.invitedEmail || invite.invitedEmail !== normalizeInviteEmail(userEmail)) {
    return { ok: false, reason: "email_mismatch" };
  }
  if (existingOnInvitedAccount) {
    return { ok: true, accountId: invite.accountId, alreadyMember: true };
  }
  return { ok: true, accountId: invite.accountId, alreadyMember: false };
}

/**
 * Accept a pending invite for the signed-in user: fetch the invite and the
 * caller's membership ON THAT INVITE'S ACCOUNT, run the pure decision, and
 * unless they already hold it, activate the member row and clear the token.
 *
 * Returning an error there would make a double-click on Accept show a failure
 * over a membership that exists.
 */
export async function acceptInvite(
  db: Db,
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptInviteResult> {
  const invite = await getInviteByToken(db, token);
  const existing = invite ? await findActiveMembership(db, userId, invite.accountId) : null;
  const result = evaluateAcceptInvite(invite, existing, userEmail);
  if (!result.ok || !invite || result.alreadyMember) return result;

  try {
    // The guard is in the write itself: the row must still be this pending
    // invite, with this token. A revoke, a resend that changed the token, or
    // another accept between the read and here matches nothing, and a write
    // that matched nothing is the same refusal as an invite that is not valid.
    const written = await db
      .update(accountMembers)
      .set({
        userId,
        status: MEMBER_STATUS.ACTIVE,
        inviteToken: null,
        inviteExpiresAt: null,
      })
      .where(
        and(
          eq(accountMembers.id, invite.memberId),
          eq(accountMembers.status, MEMBER_STATUS.PENDING),
          inArray(accountMembers.inviteToken, await storedTokenForms(token)),
        ),
      )
      .returning({ id: accountMembers.id });
    if (written.length === 0) return { ok: false, reason: "invalid" };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: true, accountId: invite.accountId, alreadyMember: true };
    }
    throw err;
  }
  return result;
}
