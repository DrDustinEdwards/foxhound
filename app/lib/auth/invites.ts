// Account invites (account.ts split): reading an invite by token, creating
// one, and accepting it into a membership.

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

/** Trim + lowercase, the one normal form an invited/accepting email is compared in. */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether the account already has a PENDING or ACTIVE membership invited at
 * this address: legacy's repeat-invite check (app/api/invite/route.ts, blob
 * 960aefc6), which matches `invited_email` alone, on the address in its stored
 * normal form, an expired pending invite included.
 */
export async function hasOpenInviteForEmail(db: Db, accountId: string, email: string): Promise<boolean> {
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
    invitedEmail: normalizeInviteEmail(email),
    status: MEMBER_STATUS.PENDING,
    inviteToken: token,
    inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdAt: now,
  });
  return { token, memberId };
}

export type AcceptInviteResult =
  | { ok: true; accountId: string; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "email_mismatch" };

/**
 * `already_member` IS GONE AS A REFUSAL, and the shape above is
 * the whole of the change. It used to be the third rejection reason, and it was
 * enforcement layer 2 of the three that made Foxhound single-account: an
 * application refusal that survived 324's strike of the index and would still
 * have blocked a user from joining a second account by invite.
 *
 * It is removed by CHANGING THE VERDICT rather than by deleting the check,
 * because legacy still has the check and simply answers differently.
 * app/api/invite/accept/route.ts:47-57 (blob `13708537`) looks the membership up
 * by `account_id` AND `user_id` AND active, and on a hit returns
 * `{ success: true, redirect: '/console' }`. So the port is a NARROWING (from
 * "holds any account" to "holds THIS account") plus a change of verdict (from
 * error to success), and `alreadyMember` is what carries the second half: the
 * caller learns it wrote nothing, and still sends the user to the account.
 */

/**
 * Pure decision for whether a fetched invite can be accepted by this user: the
 * invite must exist, and the invited email must match, because invites are not
 * transferable. Split from `acceptInvite` so both rejection branches are
 * unit-testable without a database.
 *
 * `existingOnInvitedAccount` is the caller's active membership ON THE ACCOUNT
 * THE INVITE IS FOR, not anywhere. When it is present the answer is SUCCESS with
 * `alreadyMember: true`, so the caller writes nothing and sends the user to the
 * account they already hold. That is legacy's behavior and, since ruling 324,
 * the only defensible one: refusing here would mean a user who already belongs
 * to Acme cannot follow a second Acme invite link, and a user who belongs to
 * Acme cannot join Globex at all.
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
  // Order matters and is legacy's: the email check runs BEFORE the membership
  // check (route.ts:41-44 answers `wrong_user` 403 first), so an invite
  // addressed to somebody else is refused even when the caller happens to be a
  // member of the account already.
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
 * The membership read is scoped to the invited account, which is the narrowing
 * ruling 327 ordered, and it is only a fast path either way. The index behind it
 * also changed shape under 324: `account_members_user_account_active_uq` is
 * unique on `(user_id, account_id)`, so two concurrent accepts of invites to
 * TWO accounts now both succeed, which is the product, while two concurrent
 * accepts of invites to the SAME account still collide.
 *
 * THAT COLLISION IS NOW REPORTED AS SUCCESS, not as a refusal, and the reasoning
 * is the same as the fast path's: the loser's UPDATE failed precisely because
 * the winner already made this user a member of this account, so the caller's
 * question ("can they get in?") is answered yes. Returning an error there would
 * make a double-click on Accept show a failure over a membership that exists.
 * `alreadyMember: true` records that this call wrote nothing.
 *
 * The per-account money-write DO cannot serialize a cross-account race, since
 * two invites to two accounts route to two different DOs, but that race is legal
 * now and needs no serializing.
 */
export async function acceptInvite(
  db: Db,
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptInviteResult> {
  const invite = await getInviteByToken(db, token);
  const existing = invite
    ? await findActiveMembership(db, userId, invite.accountId)
    : null;
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
          eq(accountMembers.inviteToken, token),
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
