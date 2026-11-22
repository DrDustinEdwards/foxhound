import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";
import {
  type Db,
  accountFirstCreations,
  accountMembers,
  accounts,
  apiKeys,
  oauthGrants,
  user,
} from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { isUniqueConstraintError } from "~/lib/money/serializer";
import { MEMBER_ROLE, MEMBER_STATUS } from "./roles";

// Resolves the Better Auth user -> business account relationship, and owns the
// account_members lifecycle (create account, invite, accept). The switcher, the
// switch action and the second-account connect flow are phases (b), (d) and (e)
// and are NOT built here.

export interface Membership {
  memberId: string;
  accountId: string;
  accountName: string | null;
  role: string;
}

/** Every account the user actively belongs to, earliest first. */
export async function listMemberships(db: Db, userId: string): Promise<Membership[]> {
  return db
    .select({
      memberId: accountMembers.id,
      accountId: accountMembers.accountId,
      accountName: accounts.name,
      role: accountMembers.role,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accountMembers.accountId, accounts.id))
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.status, MEMBER_STATUS.ACTIVE)))
    .orderBy(accountMembers.createdAt, accountMembers.id);
}

/**
 * The membership this request should act as: the marked one when the marker
 * names an account the user ACTIVELY holds, the earliest membership otherwise.
 */
export async function resolveActiveMembership(
  db: Db,
  userId: string,
  activeAccountId: string | null,
): Promise<Membership | null> {
  return resolveActiveMembershipFrom(db, await listMemberships(db, userId), activeAccountId);
}

/**
 * The marked membership, or null when the marker is absent or names an account
 * the user does not actively hold. Pure, so the "never trust the marker" rule
 * is testable without a database.
 */
function pickMarkedMembership(
  memberships: Membership[],
  activeAccountId: string | null,
): Membership | null {
  if (!activeAccountId) return null;
  return memberships.find((m) => m.accountId === activeAccountId) ?? null;
}

/** The same resolution over a membership list the caller already has. */
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
        inList(
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
 * The user's account membership with no active-account marker: the earliest
 * one.
 *
 * It is exactly `resolveActiveMembership(db, userId, null)`, so every caller
 * that has not yet been taught about the marker keeps its pre-326 behavior byte
 * for byte.
 */
export async function resolveMembership(db: Db, userId: string): Promise<Membership | null> {
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
 * 327 named the fix and named what it must not be: "an idempotency key on the
 * connect submit, not a per-user constraint". So this write now goes through
 * the money-write Durable Object partitioned by the USER
 * (`firstConnectPartition(userId)`), which makes the two racing submits queue
 * behind each other instead of running concurrently, and the loser then finds
 * the membership the winner just created and returns it.
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
        // THE DATABASE'S HALF OF THE KEY. The DO's seen set is written after D1
        // commits, so a DO that dies between the two would let a retry mint a
        // second account; this unique row refuses that retry's whole batch.
        tx.insert(accountFirstCreations).values({ userId, accountId, createdAt: now }),
      ],
    });

    if (!applied) {
      // Lost the race, or a retry of a write that landed. The winner's account
      // is committed by now (the DO runs these in order), so report THEIR id
      // rather than the one minted above, which was never written. Returning
      // the local id here would be the same orphan defect wearing a success.
      const first = await db
        .select({ accountId: accountFirstCreations.accountId })
        .from(accountFirstCreations)
        .where(eq(accountFirstCreations.userId, userId))
        .limit(1);
      if (first[0]) return { ok: true, accountId: first[0].accountId };
      const existing = await listMemberships(db, userId);
      const won = existing[0];
      return won ? { ok: true, accountId: won.accountId } : { ok: false, reason: "already_member" };
    }
  } catch (err) {
    // The backstop the database can still provide: a second ACTIVE membership
    // on the SAME account, which `account_members_user_account_active_uq`
    // refuses.
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
 * Namespaced so it can never collide with a real account id (those are UUIDs
 * and carry no colon), and defined here rather than inlined so the single
 * exception to "the partition is an account id" is greppable.
 */
function firstConnectPartition(userId: string): string {
  return `user:${userId}`;
}

/** One user's ACTIVE membership on ONE account, or null. */
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
    .where(eq(accountMembers.accountId, accountId))
    .orderBy(
      asc(isNull(accountMembers.createdAt)),
      asc(accountMembers.createdAt),
      asc(accountMembers.id),
    );
}

/**
 * Remove one member from an account.
 *
 * A plain account-state write, not a money write: removing a member changes who
 * may sign in to an account, never an outcome, an attributed fee or a webhook
 * claim (333's line, and `cancelMerchant`'s precedent).
 */
export type RemoveMemberResult = { ok: true } | { ok: false; reason: "not_found" | "is_owner" };

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

  // THE AGENTS THEY CONNECTED LEAVE WITH THEM. Each OAuth grant is this
  // person's delegation on this account, so in the same batch as the removal
  // its access key and the grant are revoked: the key first, found through the
  // grant, then the grant.
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
          inArray(
            apiKeys.id,
            db.select({ id: oauthGrants.apiKeyId }).from(oauthGrants).where(theirGrants),
          ),
          isNull(apiKeys.revokedAt),
        ),
      ),
    db
      .update(oauthGrants)
      .set({ revokedAt: now })
      .where(and(theirGrants, isNull(oauthGrants.revokedAt))),
    db.delete(accountMembers).where(eq(accountMembers.id, memberId)),
  ]);
  return { ok: true };
}
