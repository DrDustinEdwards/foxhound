import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts, user } from "~/db";

import { INVITE_TTL_MS, MEMBER_ROLE, MEMBER_STATUS } from "./roles";

// Resolves the Better Auth user -> business account relationship, and owns the
// account_members lifecycle (create account, invite, accept). A user may hold
// MANY active memberships, one per account, which is legacy's model
// (lib/account.ts's resolveAccount selects them with no limit and returns
// allMemberships "so callers (e.g. nav) can render an account switcher").
// Ruling 324 struck the constraint that prevented it; ruling 326 phased the
// build, and this is phase (a): the schema and the resolver split, with NO
// user-visible change. The switcher, the switch action and the second-account
// connect flow are phases (b), (d) and (e) and are NOT built here.
//
// Repaired under ruling 232: this comment used to call multi-account "out of
// scope", which ruling 53 made false by ruling it the product direction, and was
// then repaired to "not built". As of phase (a) the SCHEMA supports it and the
// SURFACES do not, which is the accurate statement now.

export interface Membership {
  memberId: string;
  accountId: string;
  accountName: string | null;
  role: string;
}

/**
 * Every account the user actively belongs to, earliest first.
 *
 * Ordered by createdAt then id so the list, and therefore the fallback pick in
 * `resolveActiveMembership`, is stable across requests. Legacy's equivalent is
 * `resolveAccount`'s `allMemberships` (lib/account.ts:110-125), which is
 * likewise unlimited; the account switcher in phase (e) renders this list.
 *
 * Distinct from `listMembers` at the bottom of this file, which goes the other
 * way: the MEMBERS of one account, for the team settings view.
 */
export async function listMemberships(
  db: Db,
  userId: string,
): Promise<Membership[]> {
  return db
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
    .orderBy(accountMembers.createdAt, accountMembers.id);
}

/**
 * The membership this request should act as: the marked one when the marker
 * names an account the user ACTIVELY holds, the earliest membership otherwise.
 *
 * `activeAccountId` is `session.active_account_id` (see the additionalFields
 * block in options.ts for why it lives on the session row rather than in
 * legacy's cookie). The marker is NEVER trusted on its own. It is matched
 * against the user's own active memberships, which is legacy's validation from
 * app/api/account/switch/route.ts:18-28 moved from write time to read time, and
 * strictly safer for it: legacy checks membership only when the cookie is SET,
 * so a legacy cookie outlives the membership it names, while this re-checks on
 * every read. A marker pointing at an account the user never held, or held and
 * had revoked, or that no longer exists, FALLS BACK rather than throwing: this
 * is on the path of every authenticated request, and a stale marker must not be
 * able to lock a user out of an account they legitimately hold.
 *
 * NOTE FOR PHASE (b): the fallback is deliberately silent, which is right for a
 * stale marker and wrong for a switch attempt. The switch action does its own
 * explicit membership check and REFUSES (legacy answers 403), rather than
 * calling this and letting a bad target quietly resolve to some other account.
 */
export async function resolveActiveMembership(
  db: Db,
  userId: string,
  activeAccountId: string | null,
): Promise<Membership | null> {
  const memberships = await listMemberships(db, userId);
  if (activeAccountId) {
    const marked = memberships.find((m) => m.accountId === activeAccountId);
    if (marked) return marked;
  }
  return memberships[0] ?? null;
}

/**
 * The user's account membership with no active-account marker: the earliest one.
 *
 * PHASE (a) COMPATIBILITY SHIM, not the long-term shape. It is exactly
 * `resolveActiveMembership(db, userId, null)`, so every caller that has not yet
 * been taught about the marker keeps its pre-326 behaviour byte for byte. The
 * remaining callers are the theme read/write pair (ruling 53 item (e)), the
 * marketing layout's has-an-account boolean, and the connect pair, which is
 * phase (d)'s to change and deliberately untouched here. `guards.ts` no longer
 * calls this; it passes the session's marker to `resolveActiveMembership`.
 */
export async function resolveMembership(
  db: Db,
  userId: string,
): Promise<Membership | null> {
  return resolveActiveMembership(db, userId, null);
}

export type CreateAccountResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "already_member" };

/**
 * Create a fresh account owned by the user, as one atomic batch (account row +
 * owner membership together or neither). Not a money write, so a plain D1 batch
 * is the right atomicity primitive here.
 *
 * THE DOUBLE-SUBMIT RACE IS NO LONGER CAUGHT HERE, and that is a real change of
 * behaviour rather than a wording repair. This paragraph used to say the
 * `account_members_one_active_per_user_uq` index was the guard: two concurrent
 * create-account submits both read "no membership", both reach here, and the
 * loser's owner-membership insert violated the one-active-membership index,
 * aborting its batch. That index is dropped (ruling 324). Its replacement is
 * unique on `(user_id, account_id)`, and the two racing submits mint two
 * DIFFERENT account ids, so neither violates it and BOTH now succeed. The
 * `isUniqueConstraintError` branch below is consequently unreachable from this
 * function at phase (a).
 *
 * At HEAD that is invisible: `resolveMembership` returns the earliest
 * membership, so the loser's account is simply never resolved. It is still a
 * defect (an orphan account row per double-submit) and it is recorded as owed to
 * PHASE (d), which owns `connect.tsx`, this function's only caller, and is where
 * the guard belongs: an intentional second account goes through the
 * add-account flow, so an UNMARKED create is a duplicate submit by definition.
 * Phase (a) does not touch connect.tsx (ruling 326), so it is named, not fixed.
 *
 * The branch is kept rather than deleted because phase (d) needs it back.
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
 * anywhere. Split from `acceptInvite` so the three rejection branches are
 * unit-testable without a database.
 *
 * THE `already_member` REFUSAL IS ENFORCEMENT LAYER 2 (ruling 326), AND IT IS
 * LEFT STANDING ON PURPOSE THIS SESSION. Ruling 324 struck the DATABASE layer;
 * this application refusal survives it untouched and would still block a user
 * from joining a second account by invite, which is why dropping the index alone
 * does not deliver multi-account. Phase (a) is schema-only and moves nothing
 * user-visible, so removing it here would ship a behaviour change this session
 * is not scoped for. PHASE (b) REMOVES IT.
 *
 * What it becomes in phase (b) is not a guess: legacy's
 * app/api/invite/accept/route.ts:47-57 (blob 13708537) scopes the same check to
 * `(account_id, user_id)` rather than to the user, and treats a hit as SUCCESS
 * with a redirect, not as an error. So the port is a narrowing plus a change of
 * verdict, and `already_member` stops being a refusal at all.
 *
 * Layer 3 is `resolveMembership`'s earliest-membership pick, now the explicit
 * shim above.
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
 * The existing-membership read is only a fast path, and the index behind it has
 * CHANGED SHAPE under ruling 324. It used to be
 * `account_members_one_active_per_user_uq`, unique on `user_id` alone, so two
 * concurrent accepts of two DIFFERENT accounts' invites raced and the loser hit
 * the constraint. That is now legal: many accounts per user is the product. The
 * replacement, `account_members_user_account_active_uq`, is unique on
 * `(user_id, account_id)`, so what it still refuses is the case that was always
 * the real defect, two concurrent accepts of invites to the SAME account
 * landing two active rows for one user there. The loser's UPDATE hits the
 * constraint and is mapped back to `already_member` exactly as before.
 *
 * That narrower guard is still the only structural stop for its case: the
 * per-account money-write DO cannot serialize a cross-account race, since two
 * invites to two accounts route to two different DOs.
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
