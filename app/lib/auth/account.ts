import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type Db, accountMembers, accounts, apiKeys, oauthGrants, user } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { MEMBER_ROLE, MEMBER_STATUS } from "./roles";

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
function pickMarkedMembership(
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
 * the pick is stable. Legacy's nondeterminism is a defect, not a behavior to
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
 * been taught about the marker keeps its pre-326 behavior byte for byte.
 *
 * ONE CALLER REMAINS after phase (c)'s re-audit: `connect.tsx`'s ACTION, which
 * reads only `!membership`. That question ("does this user hold any account at
 * all") has the same answer under every resolution, so no account identity is
 * consumed and no wrong account is reachable. `guards.ts` does NOT call this; it
 * passes the session's marker to `resolveActiveMembershipFrom`.
 *
 * THE OTHER THREE WERE DEFECTS, NOT DELIBERATE, and this paragraph used to say
 * otherwise. It claimed the theme pair and the connect loader were "not
 * account-scoped in a way a switch should change"; all three read or write a
 * value keyed BY `accountId`, so all three were account-scoped and all three
 * answered for the wrong account once phase (e) made switching possible. Fixed
 * in session 61, each with a two-account plant. The theme pair needed no ruling
 * because legacy resolves both its halves through `resolveAccount`, its own
 * active-account resolver, so the active account was always the spec.
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
      // applies; the second is recognized as a re-delivery and no-ops, so the
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
function firstConnectPartition(userId: string): string {
  return `user:${userId}`;
}

/**
 * One user's ACTIVE membership on ONE account, or null.
 *
 * This is the exact query legacy's two account-scoped checks make:
 * `app/api/invite/accept/route.ts:48-53` before activating an invite, and
 * `app/api/account/switch/route.ts:18-25` before honoring a switch. Both filter
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
export function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique constraint/i.test(message);
}

/**
 * Pending + active members of an account, for the team settings view.
 *
 * Order: by created_at, oldest first, with rows that have no created_at last
 * (the column is nullable, and SQLite would otherwise sort NULL first); then
 * by id. The id is a random UUID, so it only keeps the order the same from one
 * load to the next among rows with the same time; it says nothing about who
 * came first. The page then puts the owner first (S26, Recova's TeamSection).
 */
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
    .where(eq(accountMembers.accountId, accountId))
    .orderBy(asc(isNull(accountMembers.createdAt)), asc(accountMembers.createdAt), asc(accountMembers.id));
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
    .select({ id: accountMembers.id, role: accountMembers.role, userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.id, memberId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  const target = rows[0];
  if (!target) return { ok: false, reason: "not_found" };
  if (target.role === MEMBER_ROLE.OWNER) return { ok: false, reason: "is_owner" };

  // A pending invite has no person yet, so nothing of theirs to end.
  if (!target.userId) {
    await db.delete(accountMembers).where(eq(accountMembers.id, memberId));
    return { ok: true };
  }

  // THE AGENTS THEY CONNECTED LEAVE WITH THEM (J79). Each OAuth grant is this
  // person's delegation on this account, so in the same batch as the removal
  // its access key and the grant are revoked: the key first, found through the
  // grant, then the grant. Keys made in Settings belong to the account and stay.
  const now = new Date();
  const theirGrants = and(
    eq(oauthGrants.userId, target.userId),
    eq(oauthGrants.accountId, accountId),
  );
  await db.batch([
    db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          inArray(apiKeys.id, db.select({ id: oauthGrants.apiKeyId }).from(oauthGrants).where(theirGrants)),
          isNull(apiKeys.revokedAt),
        ),
      ),
    db.update(oauthGrants).set({ revokedAt: now }).where(and(theirGrants, isNull(oauthGrants.revokedAt))),
    db.delete(accountMembers).where(eq(accountMembers.id, memberId)),
  ]);
  return { ok: true };
}
