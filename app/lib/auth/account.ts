import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
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
 * The fallback is deliberately silent, which is right for a stale marker and
 * wrong for a switch attempt. `/api/account/switch` does its own explicit
 * membership check and REFUSES with legacy's 403, rather than calling this and
 * letting a bad target quietly resolve to some other account.
 */
export async function resolveActiveMembership(
  db: Db,
  userId: string,
  activeAccountId: string | null,
): Promise<Membership | null> {
  return resolveActiveMembershipFrom(db, await listMemberships(db, userId), activeAccountId);
}

/** The marked membership, or null when the marker is absent or names an account
 *  the user does not actively hold. Pure, so the "never trust the marker" rule
 *  is testable without a database. */
export function pickMarkedMembership(
  memberships: Membership[],
  activeAccountId: string | null,
): Membership | null {
  if (!activeAccountId) return null;
  return memberships.find((m) => m.accountId === activeAccountId) ?? null;
}

/**
 * The same resolution over a membership list the caller already has.
 *
 * `guards.ts` needs BOTH the full list (for AuthContext.memberships) and the
 * resolved one, and issuing `listMemberships` twice per authenticated request to
 * get them would be the obvious waste. This is the split that avoids it.
 *
 * THE FALLBACK ORDER IS LEGACY'S, read from lib/account.ts (blob `9bb58874`)
 * lines 126-155 rather than assumed:
 *
 *   1. the marked membership, when the marker names an account actively held;
 *   2. else an account with a non-null `last_visited_path`, which is legacy's
 *      "no cookie: prefer the account that has a non-null last_visited_path"
 *      query at :139-148;
 *   3. else the first.
 *
 * TIER 2 ONLY RUNS WHEN THERE IS MORE THAN ONE MEMBERSHIP AND TIER 1 MISSED,
 * which is legacy's structure exactly: its whole cookie-and-visited block sits
 * inside `if (memberships.length > 1)`. Every user in production holds one
 * membership today, so tier 2 costs the common path nothing, and a second query
 * on every authenticated request would have been a real cost for a case that
 * cannot yet occur.
 *
 * ONE DELIBERATE DIVERGENCE, class (a) internals, same class as phase (a)'s
 * earliest-membership ordering. Legacy's tier-2 query is
 * `.in(accountIds).not('last_visited_path','is',null).limit(1).maybeSingle()`
 * with NO ordering, so with two visited accounts it returns whichever row
 * Postgres feels like and a user can land somewhere different on consecutive
 * requests. This orders by the same `createdAt, id` the membership list uses, so
 * the pick is stable. Legacy's nondeterminism is a defect, not a behaviour to
 * reproduce; the tier itself is ported faithfully.
 */
export async function resolveActiveMembershipFrom(
  db: Db,
  memberships: Membership[],
  activeAccountId: string | null,
): Promise<Membership | null> {
  const marked = pickMarkedMembership(memberships, activeAccountId);
  if (marked) return marked;
  if (memberships.length <= 1) return memberships[0] ?? null;

  const visited = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        inArray(
          accounts.id,
          memberships.map((m) => m.accountId),
        ),
        isNotNull(accounts.lastVisitedPath),
      ),
    )
    .orderBy(accounts.createdAt, accounts.id)
    .limit(1);

  const visitedId = visited[0]?.id;
  if (visitedId) {
    const match = memberships.find((m) => m.accountId === visitedId);
    if (match) return match;
  }
  return memberships[0] ?? null;
}

/**
 * The user's account membership with no active-account marker: the earliest one.
 *
 * COMPATIBILITY SHIM, not the long-term shape. It is exactly
 * `resolveActiveMembership(db, userId, null)`, so every caller that has not yet
 * been taught about the marker keeps its pre-326 behaviour byte for byte.
 *
 * Four callers remain after phase (b), and each is deliberate rather than
 * pending: the theme read/write pair (ruling 53 item (e)) and the marketing
 * layout's has-an-account boolean, none of which is account-scoped in a way a
 * switch should change, and the connect pair, which is phase (d)'s to rewrite
 * and is untouched here on purpose. `guards.ts` does NOT call this; it passes
 * the session's marker to `resolveActiveMembershipFrom`.
 *
 * The theme pair is the one worth a second look in phase (f): a merchant who
 * switches accounts arguably wants that account's theme, and today they get the
 * earliest account's. Named rather than changed, because ruling 53 item (e)
 * owns that decision and this session is not it.
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
 * THE DOUBLE-SUBMIT RACE IS FIXED HERE BY SERIALIZATION, NOT BY A CONSTRAINT,
 * which is what ruling 327 ordered and phase (a) left owed.
 *
 * The history matters because it explains the shape. The old guard was
 * `account_members_one_active_per_user_uq`, unique on `user_id`: two concurrent
 * submits both read "no membership", both reached here, and the loser's
 * owner-membership insert violated the index and aborted its batch. Ruling 324
 * struck that index, because capping a user at one active membership is the
 * single line that made Foxhound single-account. Its replacement is unique on
 * `(user_id, account_id)`, and two racing submits mint two DIFFERENT account
 * ids, so neither violates it and both used to succeed: one double-click, two
 * accounts.
 *
 * 327 named the fix and named what it must not be: "an idempotency key on the
 * connect submit, not a per-user constraint". So this write now goes through the
 * money-write Durable Object partitioned by the USER
 * (`firstConnectPartition(userId)`), which makes the two racing submits queue
 * behind each other instead of running concurrently, and the loser then finds
 * the membership the winner just created and returns it.
 *
 * WHY THE MONEY DO AT ALL, for a write that creates no money row.
 * ARCHITECTURE.md's test is whether a write "links a Stripe account or customer
 * to the account", and this is the first half of exactly that: the account it
 * creates exists to have a Stripe connection attached to it seconds later, by
 * the callback, through the same DO. Serializing the pair in one place is the
 * point.
 *
 * The re-read is still a read-then-write, but it is now a SERIALIZED one: the
 * DO admits one caller at a time for this user, so the loser's read happens
 * after the winner's commit rather than beside it. The
 * `isUniqueConstraintError` branch stays as the backstop for the case the
 * database can still catch, a second membership on the SAME account.
 */
export async function createAccountForUser(
  env: Env,
  db: Db,
  userId: string,
  name: string,
): Promise<CreateAccountResult> {
  const accountId = crypto.randomUUID();
  const now = new Date();
  try {
    const { applied } = await executeMoneyWrite(env, {
      // Partitioned by the USER, not by the account: the account does not exist
      // yet, and the two racing submits mint two different ids, so keying on
      // either would put them in two Durable Objects and serialize nothing.
      accountId: firstConnectPartition(userId),
      // THE SAME KEY FOR BOTH RACERS, which is the whole fix. The first commit
      // applies; the second is recognised as a re-delivery and no-ops, so the
      // loser's account row is never written rather than being written and then
      // orphaned. 327 ruled for exactly this and against a per-user constraint.
      idempotencyKey: `connect:first:${userId}`,
      build: (tx) => [
        tx.insert(accounts).values({ id: accountId, name, createdAt: now }),
        tx.insert(accountMembers).values({
          id: crypto.randomUUID(),
          accountId,
          userId,
          role: MEMBER_ROLE.OWNER,
          status: MEMBER_STATUS.ACTIVE,
          createdAt: now,
        }),
      ],
    });

    if (!applied) {
      // Lost the race. The winner's account is committed by now (the DO runs
      // these in order), so report THEIR id rather than the one minted above,
      // which was never written. Returning the local id here would be the same
      // orphan defect wearing a success.
      const existing = await listMemberships(db, userId);
      const won = existing[0];
      return won
        ? { ok: true, accountId: won.accountId }
        : { ok: false, reason: "already_member" };
    }
  } catch (err) {
    // The backstop the database can still provide: a second ACTIVE membership on
    // the SAME account, which `account_members_user_account_active_uq` refuses.
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: "already_member" };
    }
    throw err;
  }
  return { ok: true, accountId };
}

/**
 * The money-write partition for the one write that has no account to key on.
 *
 * Namespaced so it can never collide with a real account id (those are UUIDs and
 * carry no colon), and defined here rather than inlined so the single exception
 * to "the partition is an account id" is greppable. See the `accountId` field
 * on MoneyWrite for why it exists.
 */
export function firstConnectPartition(userId: string): string {
  return `user:${userId}`;
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
  | { ok: true; accountId: string; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "email_mismatch" };

/**
 * `already_member` IS GONE AS A REFUSAL (ruling 327), and the shape above is
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
 * account they already hold. That is legacy's behaviour and, since ruling 324,
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
    if (isUniqueConstraintError(err)) {
      return { ok: true, accountId: invite.accountId, alreadyMember: true };
    }
    throw err;
  }
  return result;
}

/**
 * One user's ACTIVE membership on ONE account, or null.
 *
 * This is the exact query legacy's two account-scoped checks make:
 * `app/api/invite/accept/route.ts:48-53` before activating an invite, and
 * `app/api/account/switch/route.ts:18-25` before honouring a switch. Both filter
 * `user_id`, `account_id` and `status = 'active'` and take at most one row.
 * Shared here so the switch action and the invite accept cannot drift apart on
 * what "is a member" means, which is the whole question both of them turn on.
 */
export async function findActiveMembership(
  db: Db,
  userId: string,
  accountId: string,
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
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.status, MEMBER_STATUS.ACTIVE),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
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

/**
 * Remove one member from an account. S26, ported from legacy's
 * `app/api/team/remove/route.ts` (blob `3fd92550`, 1,942 bytes).
 *
 * LEGACY DELETES THE ROW, and this does too. It is not a status change: legacy
 * has no "removed" status and neither does this schema, so inventing one would
 * be a Foxhound addition on a membership table the money path reads.
 *
 * THREE REFUSALS, all legacy's, and all enforced HERE rather than by the
 * caller. The route also gates on owner, but a guard that only exists in the
 * component is not a guard:
 *   1. the target must be on THIS account, so the WHERE pins `account_id`;
 *   2. an OWNER is never removable, which is also what stops an owner removing
 *      themselves, since only an owner can reach this at all;
 *   3. a missing or foreign id matches zero rows and reports `not_found`
 *      rather than reporting success for a delete that did nothing.
 *
 * A plain account-state write, not a money write: removing a member changes who
 * may sign in to an account, never an outcome, an attributed fee or a webhook
 * claim (333's line, and `cancelMerchant`'s precedent).
 */
export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "is_owner" };

export async function removeMember(
  db: Db,
  accountId: string,
  memberId: string,
): Promise<RemoveMemberResult> {
  const rows = await db
    .select({ id: accountMembers.id, role: accountMembers.role })
    .from(accountMembers)
    .where(and(eq(accountMembers.id, memberId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  const target = rows[0];
  if (!target) return { ok: false, reason: "not_found" };
  if (target.role === MEMBER_ROLE.OWNER) return { ok: false, reason: "is_owner" };

  await db.delete(accountMembers).where(eq(accountMembers.id, memberId));
  return { ok: true };
}
