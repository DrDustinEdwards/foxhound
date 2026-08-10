import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts, user } from "~/db";

import { INVITE_TTL_MS, MEMBER_ROLE, MEMBER_STATUS } from "./roles";

// Resolves the Better Auth user -> business account relationship, and owns the
// account_members lifecycle (create account, invite, accept). At HEAD a user
// holds at most one ACTIVE membership, enforced by the partial unique index
// `account_members_one_active_per_user_uq` and re-checked here; multi-account
// switching is NOT BUILT. Repaired under ruling 232: this line used to call
// multi-account "out of scope", which ruling 53 made false by ruling it the
// product direction. Not built is the true statement; out of scope is not.

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
    // Deterministic resolution: the earliest active membership wins, so a user
    // with more than one active row always resolves to the same account (the
    // single-account invariant is enforced below, but ordering makes resolution
    // stable regardless). createdAt then id as a stable tiebreaker.
    .orderBy(accountMembers.createdAt, accountMembers.id)
    .limit(1);
  return rows[0] ?? null;
}

export type CreateAccountResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "already_member" };

/**
 * Create a fresh account owned by the user, as one atomic batch (account row +
 * owner membership together or neither). Not a money write, so a plain D1 batch
 * is the right atomicity primitive here.
 *
 * The caller guards on `resolveMembership` first, but that is a read-then-write:
 * two concurrent create-account submits can both read "no membership" and both
 * reach here. The `account_members_one_active_per_user_uq` index is the guard,
 * exactly as in `acceptInvite`. The loser's owner-membership insert violates it,
 * which aborts the whole batch (D1 batches are atomic, so no orphan account row
 * is left behind), and we map it back to `already_member`.
 */
export async function createAccountForUser(
  db: Db,
  userId: string,
  name: string,
): Promise<CreateAccountResult> {
  const accountId = crypto.randomUUID();
  const now = new Date();
  try {
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
  } catch (err) {
    // Lost the create-account race: a concurrent submit already created this
    // user's account, so the one-active-membership index rejected this insert.
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: "already_member" };
    }
    throw err;
  }
  return { ok: true, accountId };
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

/** Trim + lowercase, the one normal form an invited/accepting email is compared in. */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
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
  | { ok: true; accountId: string }
  | { ok: false; reason: "invalid" | "email_mismatch" | "already_member" };

/**
 * Pure decision for whether a fetched invite can be accepted by this user: the
 * invite must exist, the invited email must match (invites are not
 * transferable), and the user must not already hold an active membership
 * elsewhere (the single-account invariant). Split from `acceptInvite` so the
 * three rejection branches are unit-testable without a database.
 */
export function evaluateAcceptInvite(
  invite: InviteView | null,
  existingMembership: Membership | null,
  userEmail: string,
): AcceptInviteResult {
  if (!invite) return { ok: false, reason: "invalid" };
  if (!invite.invitedEmail || invite.invitedEmail !== normalizeInviteEmail(userEmail)) {
    return { ok: false, reason: "email_mismatch" };
  }
  if (existingMembership) return { ok: false, reason: "already_member" };
  return { ok: true, accountId: invite.accountId };
}

/**
 * Accept a pending invite for the signed-in user: fetch the invite + the
 * user's current membership, run the pure decision, and on success activate
 * the member row and clear the token.
 *
 * The existing-membership read is only a fast path. Two concurrent accepts of
 * two different invites can both read `existingMembership = null` before either
 * commits, so the read alone cannot enforce the single-account invariant. The
 * `account_members_one_active_per_user_uq` partial unique index is the real
 * guard: only one of the racing activations can create an active row for the
 * user; the loser's UPDATE hits the constraint, which we map back to
 * `already_member`. (The per-account money-write DO cannot serialize this: the
 * two invites belong to two different accounts, so they route to two different
 * DOs. The database index is the only structural stop.)
 */
export async function acceptInvite(
  db: Db,
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptInviteResult> {
  const invite = await getInviteByToken(db, token);
  const existingMembership = invite ? await resolveMembership(db, userId) : null;
  const result = evaluateAcceptInvite(invite, existingMembership, userEmail);
  if (!result.ok || !invite) return result;

  try {
    await db
      .update(accountMembers)
      .set({
        userId,
        status: MEMBER_STATUS.ACTIVE,
        inviteToken: null,
        inviteExpiresAt: null,
      })
      .where(eq(accountMembers.id, invite.memberId));
  } catch (err) {
    // Lost the race: another accept already activated a membership for this
    // user, so the unique index rejected this activation. Fail closed.
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: "already_member" };
    }
    throw err;
  }
  return result;
}

/** True for a SQLite/D1 UNIQUE-constraint violation, however the driver wraps it. */
function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique constraint/i.test(message);
}

/** Pending + active members of an account, for the team settings view. */
export async function listMembers(db: Db, accountId: string) {
  return db
    .select({
      id: accountMembers.id,
      userId: accountMembers.userId,
      userName: user.name,
      userEmail: user.email,
      invitedEmail: accountMembers.invitedEmail,
      role: accountMembers.role,
      status: accountMembers.status,
    })
    .from(accountMembers)
    .leftJoin(user, eq(accountMembers.userId, user.id))
    .where(eq(accountMembers.accountId, accountId));
}
