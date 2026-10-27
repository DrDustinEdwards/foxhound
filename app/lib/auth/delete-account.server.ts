import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  type Db,
  account as authAccount,
  accountMembers,
  adminAuditLog,
  apiKeys,
  disputeApprovals,
  getDb,
  intelligenceNotificationPreferences,
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
import { type DeauthorizeFailure, revokeDisconnectedGrants } from "~/lib/stripe/deauthorize-retry.server";
import { MEMBER_ROLE, MEMBER_STATUS } from "./roles";
import { buildAccountScrubStatements } from "./account-scrub.server";

// ACCOUNT DELETION (row S40, job J08), the one approved difference from
// Recova's delete.
//
// Recova's /api/auth/delete-account (blob 2136362a) calls delete_account_cascade,
// which deletes every account the user OWNS and everything under it, including
// recovered_payments, then the user's other memberships and the user. Foxhound
// bills its fees on recovered_payments, so Dustin ruled (Q14 and Q16,
// parity/ANSWERS-2026-10-14.md) that those records survive, keeping only what
// proves the fee (amounts, currency, dates, Stripe ids and the attribution
// chain), while the merchant's personal data and their end customers' names,
// emails and other personal details are removed.
//
// SO EVERYTHING RECOVA DELETES IS DELETED HERE TOO, EXCEPT THE FEE EVIDENCE,
// which is kept and stripped of personal fields:
//
//   - recovered_payments, billing_invoices, billing_line_items and outcomes are
//     NOT WRITTEN AT ALL. None of them holds a personal field, and each keeps its
//     one writer (RULES.md 3.2). The fee is recomputed from them unchanged.
//   - the rows they point at survive so the chain stays whole: the account row
//     (billing joins it, and it holds the platform customer the invoice is
//     charged to), each recovered payment's failed payment, that payment's
//     recovery steps with their sends and clicks (the attribution proof), each
//     dispute that was billed or is billable with its approval, and the Stripe
//     connection those rows reference. Their personal columns are cleared.
//   - everything else under the account is deleted.
//
// ONE PLAIN ATOMIC BATCH, like cancelMerchant and for the same reason (RULES.md
// 3.2): this is an account-state write, not outcome recording, attributed
// billing or a webhook claim, and it never touches a fee row. The audit row is
// the batch's first statement, so a deletion and its record commit together or
// not at all, which is Recova's "no deletion without a record" made atomic.
//
// SET PREDICATES, NEVER ID LISTS (RULES.md 3.11). Each statement names its rows
// by account and by a correlated EXISTS against the fee rows, so a merchant with
// ten thousand payments costs the same number of bound parameters as one with
// ten. EXISTS rather than NOT IN, because NOT IN against a nullable column
// (recovered_by_step_id) matches nothing at all once one NULL is present.
//
// THE ORDER IS THE FOREIGN-KEY ORDER, children before parents, because D1
// enforces foreign keys and the local harness does not (RULES.md 3.11). The
// tests run with foreign_keys = ON and a foreign_key_check to hold it.
//
// NEVER AN AGENT TOOL (RULES.md 3.6): nothing under app/lib/mcp or the admin API
// imports this module, and the tool registry refuses any name containing
// "delete_account".

/** The audit action, Recova's own name for it. */
const ACCOUNT_DELETION_AUDIT_ACTION = "user_self_deleted_account";

/** Who the audit row names as the actor. Recova writes the person's email here;
 *  Foxhound keeps the record and drops the address, because the address is the
 *  personal data being deleted. The user id stays as the target. */
const ACCOUNT_DELETION_AUDIT_ACTOR = "account-owner";

type DeletionBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

interface DeletedConnection {
  id: string;
  stripeUserId: string;
}

interface DeletionPlan {
  userId: string;
  email: string;
  /** Every account the user actively OWNS. Recova's ownership query, the
   *  owner-role memberships of the user, is the same set. */
  ownedAccountIds: string[];
  /** Live Stripe connections on those accounts, whose grants are revoked after
   *  the local commit. */
  liveConnections: DeletedConnection[];
  /** Recovered payments kept as fee evidence, for the audit row. */
  keptRecoveredPayments: number;
}

/** Read what a deletion will act on. Null when the user no longer exists, which
 *  is what makes a second deletion a no-op. */
async function readDeletionPlan(db: Db, userId: string): Promise<DeletionPlan | null> {
  const users = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
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
          .where(and(inArray(stripeConnections.accountId, ownedAccountIds), isNull(stripeConnections.disconnectedAt)));

  const kept =
    ownedAccountIds.length === 0
      ? []
      : await db
          .select({ id: recoveredPayments.id })
          .from(recoveredPayments)
          .where(inArray(recoveredPayments.accountId, ownedAccountIds));

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
 * notification preferences, their name on any approval they signed, then the
 * Better Auth rows and the user. Recova's cascade ends the same way, with the
 * residual memberships and the user.
 */
function buildUserDeletionStatements(
  db: Db,
  plan: Pick<DeletionPlan, "userId" | "email">,
  now: Date,
): BatchItem<"sqlite">[] {
  const { userId, email } = plan;
  return [
    db.delete(accountMembers).where(eq(accountMembers.userId, userId)),
    db.delete(intelligenceNotificationPreferences).where(eq(intelligenceNotificationPreferences.userId, userId)),
    db
      .update(disputeApprovals)
      .set({ approvedByEmail: null, approvedByUserId: null })
      .where(eq(disputeApprovals.approvedByUserId, userId)),
    // The agents this person connected to accounts they do not own (J79). A
    // grant is their delegation and ends with them. The access key goes first,
    // revoked through the grant that names it (a grant points at its key, so
    // the key cannot be deleted while the grant stands, and once the grant is
    // gone nothing finds the key); then the grants and the codes go. The
    // revoked key keeps no personal value and Settings never lists it.
    db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          inArray(apiKeys.id, db.select({ id: oauthGrants.apiKeyId }).from(oauthGrants).where(eq(oauthGrants.userId, userId))),
          isNull(apiKeys.revokedAt),
        ),
      ),
    db.delete(oauthGrants).where(eq(oauthGrants.userId, userId)),
    db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)),
    db.delete(session).where(eq(session.userId, userId)),
    db.delete(authAccount).where(eq(authAccount.userId, userId)),
    db.delete(passkey).where(eq(passkey.userId, userId)),
    db.delete(verification).where(or(eq(verification.identifier, email), eq(verification.value, userId))),
    db.delete(user).where(eq(user.id, userId)),
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

/** Read the plan and commit the batch. Writes nothing when the user is gone. */
export async function deleteUserAccountLocal(db: Db, userId: string, now: Date): Promise<DeleteAccountLocalResult> {
  const plan = await readDeletionPlan(db, userId);
  if (!plan) return { status: "not_found" };
  await db.batch(buildAccountDeletionBatch(db, plan, now));
  return { status: "deleted", accountIds: plan.ownedAccountIds, liveConnections: plan.liveConnections };
}

export type DeleteAccountResult =
  | {
      status: "deleted";
      accountIds: string[];
      deauthorizeErrors: Array<{ connectionId: string; stripeUserId: string; error: string }>;
    }
  | { status: "not_found" };

export interface DeleteAccountDeps {
  deleteLocal: (env: Env, userId: string, now: Date) => Promise<DeleteAccountLocalResult>;
  deauthorize: (env: Env, stripeUserId: string) => Promise<{ ok: boolean; error?: string }>;
  recordDeauthorizeFailure: (env: Env, userId: string, failure: DeauthorizeFailure) => Promise<void>;
}

const ACCOUNT_DELETION_DEAUTHORIZE_FAILED_ACTION = "user_self_deleted_account_deauthorize_failed";

/** One durable admin_audit_log row for a Stripe grant that could not be revoked
 *  after a deletion, through the one audit writer. Ids and the error only: the
 *  person's email and name are already gone and are not written back here. */
async function recordDeauthorizeFailure(db: Db, userId: string, failure: DeauthorizeFailure): Promise<void> {
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
 * Delete the signed-in user's account. The local commit first, then each
 * disconnected Stripe grant is revoked, best effort, cancelMerchant's posture:
 * a revoke that fails is reported and never undoes the deletion, because the
 * person asked to be deleted and is.
 */
export async function deleteUserAccount(
  env: Env,
  userId: string,
  deps: Partial<DeleteAccountDeps> = {},
): Promise<DeleteAccountResult> {
  const deleteLocal = deps.deleteLocal ?? ((e, id, now) => deleteUserAccountLocal(getDb(e), id, now));
  const deauthorize = deps.deauthorize ?? deauthorizeConnectedAccount;
  const recordFailure = deps.recordDeauthorizeFailure ?? ((e, id, f) => recordDeauthorizeFailure(getDb(e), id, f));

  const local = await deleteLocal(env, userId, new Date());
  if (local.status === "not_found") return local;

  const deauthorizeErrors = await revokeDisconnectedGrants(env, local.liveConnections, new Date(), deauthorize);
  for (const failure of deauthorizeErrors) {
    // Nobody is signed in to see this once the account is gone, so the
    // failure is written where an operator finds it (/admin/platform/audit-log),
    // beside the retry the revoke queued. A failed write is logged and never
    // reports the deletion as failed.
    try {
      await recordFailure(env, userId, failure);
    } catch (err) {
      console.error(`could not record deauthorize failure for connection ${failure.connectionId}:`, err);
    }
  }
  return { status: "deleted", accountIds: local.accountIds, deauthorizeErrors };
}

