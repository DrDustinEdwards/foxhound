import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
  type Db,
  account as authAccount,
  accountMembers,
  adminAuditLog,
  apiKeys,
  disputeApprovals,
  getDb,
  oauthAuthorizationCodes,
  oauthGrants,
  passkey,
  recoveredPayments,
  session,
  stripeConnections,
  user,
  verification,
} from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { deauthorizeConnectedAccount } from "~/lib/stripe/connect";
import {
  type DeauthorizeFailure,
  revokeDisconnectedGrants,
} from "~/lib/stripe/deauthorize-retry.server";
import { MEMBER_ROLE, MEMBER_STATUS } from "./roles";
import { buildAccountScrubStatements } from "./account-scrub.server";

//   - recovered_payments, billing_invoices, billing_line_items and outcomes are
//     NOT WRITTEN AT ALL. None of them holds a personal field, and each keeps its
//     one writer. The fee is recomputed from them unchanged.
//   - the rows they point at survive so the chain stays whole: the account row
//     (billing joins it, and it holds the platform customer the invoice is
//     charged to), each recovered payment's failed payment, that payment's
//     recovery steps with their sends and clicks (the attribution proof), each
//     dispute that was billed or is billable with its approval, and the Stripe
//     connection those rows reference. Their personal columns are cleared.
//   - everything else under the account is deleted.

const ACCOUNT_DELETION_AUDIT_ACTION = "user_self_deleted_account";

/** Who the audit row names as the actor. The user id stays as the target. */
const ACCOUNT_DELETION_AUDIT_ACTOR = "account-owner";

type DeletionBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

interface DeletedConnection {
  id: string;
  stripeUserId: string;
}

interface DeletionPlan {
  userId: string;
  email: string;
  /** Every account the user actively OWNS. */
  ownedAccountIds: string[];
  /**
   * Live Stripe connections on those accounts, whose grants are revoked after
   * the local commit.
   */
  liveConnections: DeletedConnection[];
  /** Recovered payments kept as fee evidence, for the audit row. */
  keptRecoveredPayments: number;
}

/** Read what a deletion will act on. */
async function readDeletionPlan(db: Db, userId: string): Promise<DeletionPlan | null> {
  const users = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const found = users[0];
  if (!found) return null;

  const owned = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.userId, userId),
        eq(accountMembers.role, MEMBER_ROLE.OWNER),
        eq(accountMembers.status, MEMBER_STATUS.ACTIVE),
      ),
    )
    .orderBy(accountMembers.createdAt, accountMembers.accountId);
  const ownedAccountIds = [...new Set(owned.map((r) => r.accountId))];

  const liveConnections =
    ownedAccountIds.length === 0
      ? []
      : await db
          .select({ id: stripeConnections.id, stripeUserId: stripeConnections.stripeUserId })
          .from(stripeConnections)
          .where(
            and(
              inList(stripeConnections.accountId, ownedAccountIds),
              isNull(stripeConnections.disconnectedAt),
            ),
          );

  const kept =
    ownedAccountIds.length === 0
      ? []
      : await db
          .select({ id: recoveredPayments.id })
          .from(recoveredPayments)
          .where(inList(recoveredPayments.accountId, ownedAccountIds));

  return {
    userId,
    email: found.email,
    ownedAccountIds,
    liveConnections,
    keptRecoveredPayments: kept.length,
  };
}

/**
 * The statements that delete the person: their memberships elsewhere, their
 * name on any approval they signed, then the Better Auth rows that point at the
 * user.
 */
function buildUserDeletionStatements(
  db: Db,
  plan: Pick<DeletionPlan, "userId" | "email">,
  now: Date,
): BatchItem<"sqlite">[] {
  const { userId, email } = plan;
  return [
    db.delete(accountMembers).where(eq(accountMembers.userId, userId)),
    db
      .update(disputeApprovals)
      .set({ approvedByEmail: null, approvedByUserId: null })
      .where(eq(disputeApprovals.approvedByUserId, userId)),
    // The agents this person connected to accounts they do not own. A grant is
    // their delegation and ends with them.
    db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          inArray(
            apiKeys.id,
            db
              .select({ id: oauthGrants.apiKeyId })
              .from(oauthGrants)
              .where(eq(oauthGrants.userId, userId)),
          ),
          isNull(apiKeys.revokedAt),
        ),
      ),
    db.delete(oauthGrants).where(eq(oauthGrants.userId, userId)),
    db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)),
    db.delete(session).where(eq(session.userId, userId)),
    db.delete(authAccount).where(eq(authAccount.userId, userId)),
    db.delete(passkey).where(eq(passkey.userId, userId)),
    db
      .delete(verification)
      .where(or(eq(verification.identifier, email), eq(verification.value, userId))),
    // NOT the user row, which Better Auth's deleteUser deletes after this batch
    // (accountDeletionHooks), so its database hook runs: site-runtime's
    // user_deleted line, the account-deleted notice and the person's
    // auth_events rows.
  ];
}

/** The whole deletion as one atomic batch, the audit row first. Pure. */
function buildAccountDeletionBatch(db: Db, plan: DeletionPlan, now: Date): DeletionBatch {
  return [
    db.insert(adminAuditLog).values({
      actorEmail: ACCOUNT_DELETION_AUDIT_ACTOR,
      action: ACCOUNT_DELETION_AUDIT_ACTION,
      targetUserId: plan.userId,
      targetEmail: null,
      metadata: {
        initiated_at: now.toISOString(),
        account_ids: plan.ownedAccountIds,
        kept_recovered_payments: plan.keptRecoveredPayments,
        stripe_connections_disconnected: plan.liveConnections.length,
      },
      createdAt: now,
    }),
    ...plan.ownedAccountIds.flatMap((accountId) => buildAccountScrubStatements(db, accountId, now)),
    ...buildUserDeletionStatements(db, plan, now),
  ];
}

export type DeleteAccountLocalResult =
  | { status: "deleted"; accountIds: string[]; liveConnections: DeletedConnection[] }
  | { status: "not_found" };

/**
 * Read the plan and commit the batch, which leaves only the user row. Writes
 * nothing when the user is gone.
 */
export async function deleteUserAccountLocal(
  db: Db,
  userId: string,
  now: Date,
): Promise<DeleteAccountLocalResult> {
  const plan = await readDeletionPlan(db, userId);
  if (!plan) return { status: "not_found" };
  await db.batch(buildAccountDeletionBatch(db, plan, now));
  return {
    status: "deleted",
    accountIds: plan.ownedAccountIds,
    liveConnections: plan.liveConnections,
  };
}

export interface DeleteAccountDeps {
  deleteLocal: (env: Env, userId: string, now: Date) => Promise<DeleteAccountLocalResult>;
  deauthorize: (env: Env, stripeUserId: string) => Promise<{ ok: boolean; error?: string }>;
  recordDeauthorizeFailure: (
    env: Env,
    userId: string,
    failure: DeauthorizeFailure,
  ) => Promise<void>;
}

const ACCOUNT_DELETION_DEAUTHORIZE_FAILED_ACTION = "user_self_deleted_account_deauthorize_failed";

/**
 * One durable admin_audit_log row for a Stripe grant that could not be revoked
 * after a deletion, through the one audit writer. Ids and the error only: the
 * person's email and name are already gone and are not written back here.
 */
async function recordDeauthorizeFailure(
  db: Db,
  userId: string,
  failure: DeauthorizeFailure,
): Promise<void> {
  await logAdminAction(db, {
    actorEmail: ACCOUNT_DELETION_AUDIT_ACTOR,
    action: ACCOUNT_DELETION_DEAUTHORIZE_FAILED_ACTION,
    targetUserId: userId,
    metadata: {
      connection_id: failure.connectionId,
      stripe_user_id: failure.stripeUserId,
      error: failure.error,
    },
  });
}

/**
 * Better Auth's deleteUser hooks (auth.server.ts), which are the account
 * deletion. Better Auth checks the sign-in is fresh, then runs beforeDelete
 * (Foxhound's local batch, everything but the user row), deletes the user and
 * its sessions, and runs afterDelete: each disconnected Stripe grant is revoked
 * there, best effort, cancelMerchant's posture, because a revoke that fails is
 * reported and never undoes the deletion.
 */
export function accountDeletionHooks(env: Env, deps: Partial<DeleteAccountDeps> = {}) {
  const deleteLocal =
    deps.deleteLocal ?? ((e, id, now) => deleteUserAccountLocal(getDb(e), id, now));
  const deauthorize = deps.deauthorize ?? deauthorizeConnectedAccount;
  const recordFailure =
    deps.recordDeauthorizeFailure ?? ((e, id, f) => recordDeauthorizeFailure(getDb(e), id, f));
  const toRevoke = new Map<string, DeletedConnection[]>();

  return {
    beforeDelete: async (deleted: { id: string }) => {
      const local = await deleteLocal(env, deleted.id, new Date());
      if (local.status === "deleted") toRevoke.set(deleted.id, local.liveConnections);
    },
    afterDelete: async (deleted: { id: string }) => {
      const connections = toRevoke.get(deleted.id) ?? [];
      toRevoke.delete(deleted.id);
      const failures = await revokeDisconnectedGrants(env, connections, new Date(), deauthorize);
      for (const failure of failures) {
        // Nobody is signed in to see this once the account is gone, so the
        // failure is written where an operator finds it, beside the retry the
        // revoke queued. A failed write is logged and never reports the
        // deletion as failed.
        try {
          await recordFailure(env, deleted.id, failure);
        } catch (err) {
          console.error(
            `could not record deauthorize failure for connection ${failure.connectionId}:`,
            err,
          );
        }
      }
    },
  };
}
