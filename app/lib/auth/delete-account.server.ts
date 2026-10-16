import { and, eq, exists, inArray, isNotNull, isNull, not, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type { Db } from "~/db";
import {
  account as authAccount,
  accountMembers,
  accountSubscriptions,
  accounts,
  adminAuditLog,
  aiCalls,
  alertHistory,
  alerts,
  apiKeys,
  auditDigestRuns,
  auditRuns,
  billingLineItems,
  customerContext,
  customerNotes,
  disputeApprovals,
  disputeEvidence,
  disputes,
  emailDeadLetters,
  emailSends,
  emailSuppressions,
  engagementEvents,
  expiringCardAlerts,
  failedPayments,
  getDb,
  healthScoreHistory,
  intelligenceNotificationPreferences,
  intelligenceReports,
  mrrSnapshots,
  oauthAuthorizationCodes,
  oauthGrants,
  predictions,
  recoveredPayments,
  recoverySteps,
  session,
  stripeConnections,
  user,
  verification,
  webhookEvents,
  winBackSequences,
  winBackSteps,
} from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { deauthorizeConnectedAccount } from "~/lib/stripe/connect";

import { MEMBER_ROLE, MEMBER_STATUS } from "./roles";

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
export const ACCOUNT_DELETION_AUDIT_ACTION = "user_self_deleted_account";

/** Who the audit row names as the actor. Recova writes the person's email here;
 *  Foxhound keeps the record and drops the address, because the address is the
 *  personal data being deleted. The user id stays as the target. */
export const ACCOUNT_DELETION_AUDIT_ACTOR = "account-owner";

type DeletionBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export interface DeletedConnection {
  id: string;
  stripeUserId: string;
}

export interface DeletionPlan {
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
export async function readDeletionPlan(db: Db, userId: string): Promise<DeletionPlan | null> {
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

// ---------------------------------------------------------------------------
// What counts as fee evidence. Each is a correlated EXISTS on the outer row's
// column, which is false (never NULL) when that column is NULL.
// ---------------------------------------------------------------------------

/** A failed payment is evidence when a recovery was recorded against it. */
function paymentRecovered(db: Db, failedPaymentId: AnySQLiteColumn): SQL {
  return exists(
    db.select({ one: sql`1` }).from(recoveredPayments).where(eq(recoveredPayments.failedPaymentId, failedPaymentId)),
  );
}

/** A recovery step is evidence when its payment was recovered: the steps are
 *  the actions the attribution chose between (PRICING.md, "action -> recovery
 *  -> fee"), so every step of a recovered payment is kept, not only the
 *  credited one. */
function stepKept(db: Db, stepId: AnySQLiteColumn): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(recoverySteps)
      .innerJoin(recoveredPayments, eq(recoveredPayments.failedPaymentId, recoverySteps.failedPaymentId))
      .where(eq(recoverySteps.id, stepId)),
  );
}

/** A send is evidence when its step is. */
function sendKept(db: Db, sendId: AnySQLiteColumn): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(emailSends)
      .innerJoin(recoverySteps, eq(recoverySteps.id, emailSends.recoveryStepId))
      .innerJoin(recoveredPayments, eq(recoveredPayments.failedPaymentId, recoverySteps.failedPaymentId))
      .where(eq(emailSends.id, sendId)),
  );
}

/** A dispute was billed when any line item points at it (a fee or its credit). */
function disputeBilled(db: Db, disputeId: AnySQLiteColumn): SQL {
  return exists(db.select({ one: sql`1` }).from(billingLineItems).where(eq(billingLineItems.disputeId, disputeId)));
}

/**
 * The statements that delete one owned account's personal data, in
 * foreign-key order. Pure: compiles without a database.
 */
export function buildAccountScrubStatements(db: Db, accountId: string, now: Date): BatchItem<"sqlite">[] {
  const nowMs = now.getTime();

  // The account's own rows in tables whose account_id is nullable, reached
  // through their parent as well, so a row written without its account id is
  // still found and cannot block its parent's delete.
  const stepsOfAccount = db.select({ id: recoverySteps.id }).from(recoverySteps).where(eq(recoverySteps.accountId, accountId));
  const sequencesOfAccount = db
    .select({ id: winBackSequences.id })
    .from(winBackSequences)
    .where(eq(winBackSequences.accountId, accountId));
  const winBackStepsOfAccount = db
    .select({ id: winBackSteps.id })
    .from(winBackSteps)
    .where(or(eq(winBackSteps.accountId, accountId), inArray(winBackSteps.winBackSequenceId, sequencesOfAccount)));
  const sendsOfAccount = db
    .select({ id: emailSends.id })
    .from(emailSends)
    .where(
      or(
        eq(emailSends.accountId, accountId),
        inArray(emailSends.recoveryStepId, stepsOfAccount),
        inArray(emailSends.winBackStepId, winBackStepsOfAccount),
      ),
    );
  const engagementOfAccount = or(
    eq(engagementEvents.accountId, accountId),
    inArray(engagementEvents.recoveryStepId, stepsOfAccount),
    inArray(engagementEvents.emailSendId, sendsOfAccount),
  ) as SQL;
  const sendOfAccount = or(
    eq(emailSends.accountId, accountId),
    inArray(emailSends.recoveryStepId, stepsOfAccount),
    inArray(emailSends.winBackStepId, winBackStepsOfAccount),
  ) as SQL;

  return [
    // ---- the account row: kept as the fee's key, every personal field cleared.
    db
      .update(accounts)
      .set({
        name: null,
        notificationEmail: null,
        slackWebhookUrl: null,
        digestEmail: null,
        lastVisitedPath: null,
        lastVisitedProduct: null,
        mrrEstimateCents: null,
        merchantIndustry: null,
        primaryCustomerType: null,
        merchantMrrSelfReported: null,
        disputeProductDescription: null,
        disputeShipsPhysical: null,
        liveSendsEnabled: false,
        // The cancel stamp, kept if the account was already cancelled so the
        // date the merchant actually cancelled is not overwritten.
        cancelledAt: sql`coalesce(${accounts.cancelledAt}, ${nowMs})`,
        deletedAt: sql`coalesce(${accounts.deletedAt}, ${nowMs})`,
      })
      .where(eq(accounts.id, accountId)),

    // ---- Stripe connections: kept because kept payments and disputes point at
    // them; disconnected, and the token and every merchant-written field cleared.
    db
      .update(stripeConnections)
      .set({
        stripeAccessToken: null,
        stripePublishableKey: null,
        name: null,
        senderName: null,
        senderDomain: null,
        replyToEmail: null,
        brandVoice: null,
        brandVoiceSoft: null,
        brandVoiceExpired: null,
        brandVoiceNetwork: null,
        brandVoiceFraud: null,
        disconnectedAt: sql`coalesce(${stripeConnections.disconnectedAt}, ${nowMs})`,
      })
      .where(eq(stripeConnections.accountId, accountId)),

    // ---- clicks and sends: the attribution proof is kept, the rest deleted.
    db
      .delete(engagementEvents)
      .where(
        and(
          engagementOfAccount,
          not(or(stepKept(db, engagementEvents.recoveryStepId), sendKept(db, engagementEvents.emailSendId)) as SQL),
        ),
      ),
    db.update(engagementEvents).set({ targetUrl: null }).where(engagementOfAccount),
    db.delete(emailSends).where(and(sendOfAccount, not(stepKept(db, emailSends.recoveryStepId)))),
    db.update(emailSends).set({ recipientHash: null, error: null }).where(sendOfAccount),
    db.delete(emailDeadLetters).where(eq(emailDeadLetters.accountId, accountId)),

    // ---- win-back: never billable (RULES.md 3.2), so none of it is evidence.
    db.delete(winBackSteps).where(inArray(winBackSteps.id, winBackStepsOfAccount)),
    db.delete(winBackSequences).where(eq(winBackSequences.accountId, accountId)),

    // ---- recovery steps and failed payments: kept for recovered payments only.
    db
      .delete(recoverySteps)
      .where(and(eq(recoverySteps.accountId, accountId), not(paymentRecovered(db, recoverySteps.failedPaymentId)))),
    db
      .update(recoverySteps)
      .set({ aiSubject: null, aiBodyHtml: null, customBody: null, lastAttemptError: null })
      .where(eq(recoverySteps.accountId, accountId)),
    db
      .delete(failedPayments)
      .where(and(eq(failedPayments.accountId, accountId), not(paymentRecovered(db, failedPayments.id)))),
    db
      .update(failedPayments)
      .set({
        // NOT NULL in the schema, so the address is replaced with an empty
        // string rather than nulled: relaxing NOT NULL on D1 means recreating
        // the table (RULES.md 3.11), a migration this job does not need.
        customerEmail: "",
        customerName: null,
        planName: null,
        customerSince: null,
        notes: null,
        cardBrand: null,
        cardCountry: null,
        cardFunding: null,
        customerLtvCents: null,
        customerTimezone: null,
        subscriptionStart: null,
        timeOfFailureHour: null,
        failureDayOfWeek: null,
        priorFailureCount: null,
        isFirstFailureEver: null,
        merchantMrrRange: null,
        merchantIndustry: null,
        planInterval: null,
        amountTier: null,
        abTestGroup: null,
        customerAgeDays: null,
      })
      .where(eq(failedPayments.accountId, accountId)),

    db.delete(expiringCardAlerts).where(eq(expiringCardAlerts.accountId, accountId)),
    db.delete(emailSuppressions).where(eq(emailSuppressions.accountId, accountId)),

    // ---- disputes: a dispute that was billed, or is billable (won, submitted
    // by Foxhound, approved: app/db/billable.ts's predicate without the run
    // date), is kept with its approval. Drafts, open and lost disputes are not.
    db.delete(disputeEvidence).where(eq(disputeEvidence.accountId, accountId)),
    db.delete(disputeApprovals).where(
      and(
        eq(disputeApprovals.accountId, accountId),
        not(disputeBilled(db, disputeApprovals.disputeId)),
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(disputes)
              .where(
                and(
                  eq(disputes.id, disputeApprovals.disputeId),
                  eq(disputes.state, "resolved_won"),
                  isNotNull(disputes.submittedAt),
                ),
              ),
          ),
        ),
      ),
    ),
    db
      .update(disputeApprovals)
      .set({ approvedByEmail: null, approvedByUserId: null })
      .where(eq(disputeApprovals.accountId, accountId)),
    db.delete(disputes).where(
      and(
        eq(disputes.accountId, accountId),
        not(disputeBilled(db, disputes.id)),
        not(
          and(
            eq(disputes.state, "resolved_won"),
            isNotNull(disputes.submittedAt),
            exists(db.select({ one: sql`1` }).from(disputeApprovals).where(eq(disputeApprovals.disputeId, disputes.id))),
          ) as SQL,
        ),
      ),
    ),
    db
      .update(disputes)
      .set({
        customerEmail: null,
        customerName: null,
        customerId: null,
        customerIp: null,
        billingAddress: null,
        avsResult: null,
        cvvResult: null,
        radarRiskScore: null,
        radarRiskLevel: null,
        threeDSecure: null,
        priorChargesCount: null,
        priorChargesTotal: null,
        priorChargesJson: null,
        subscriptionJson: null,
        recoveryEmailsJson: null,
        structuredEvidenceJson: null,
        aiResponseText: null,
        triageRecommendation: null,
        triageConfidence: null,
        triageReasoning: null,
        submittedBy: null,
        shippingTrackingNumber: null,
        shippingCarrier: null,
        shippingDate: null,
      })
      .where(eq(disputes.accountId, accountId)),

    // ---- Intelligence and audit: none of it is evidence.
    db.delete(healthScoreHistory).where(eq(healthScoreHistory.accountId, accountId)),
    db.delete(customerContext).where(eq(customerContext.accountId, accountId)),
    db.delete(predictions).where(eq(predictions.accountId, accountId)),
    db.delete(customerNotes).where(eq(customerNotes.accountId, accountId)),
    db.delete(mrrSnapshots).where(eq(mrrSnapshots.accountId, accountId)),
    db.delete(intelligenceReports).where(eq(intelligenceReports.accountId, accountId)),
    db.delete(alertHistory).where(eq(alertHistory.accountId, accountId)),
    db.delete(alerts).where(eq(alerts.accountId, accountId)),
    db.delete(intelligenceNotificationPreferences).where(eq(intelligenceNotificationPreferences.accountId, accountId)),
    db.delete(auditRuns).where(eq(auditRuns.accountId, accountId)),
    db.delete(auditDigestRuns).where(eq(auditDigestRuns.accountId, accountId)),
    db.delete(aiCalls).where(eq(aiCalls.accountId, accountId)),

    // ---- credentials, subscriptions, webhook payloads, members.
    // An OAuth grant points at the api_keys row that is its access token, so
    // the grants go first, then the codes, then the keys (J79).
    db.delete(oauthGrants).where(eq(oauthGrants.accountId, accountId)),
    db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.accountId, accountId)),
    db.delete(apiKeys).where(eq(apiKeys.accountId, accountId)),
    db
      .update(accountSubscriptions)
      .set({ cancellationFeedback: null })
      .where(eq(accountSubscriptions.accountId, accountId)),
    // The claim row stays (its stripe_event_id is what stops a redelivered
    // event being processed twice); the Stripe payload, full of customer
    // details, goes.
    db.update(webhookEvents).set({ payload: {}, errorMessage: null }).where(eq(webhookEvents.accountId, accountId)),
    db.delete(accountMembers).where(eq(accountMembers.accountId, accountId)),
  ];
}

/**
 * The statements that delete the person: their memberships elsewhere, their
 * notification preferences, their name on any approval they signed, then the
 * Better Auth rows and the user. Recova's cascade ends the same way, with the
 * residual memberships and the user.
 */
export function buildUserDeletionStatements(db: Db, plan: Pick<DeletionPlan, "userId" | "email">): BatchItem<"sqlite">[] {
  const { userId, email } = plan;
  return [
    db.delete(accountMembers).where(eq(accountMembers.userId, userId)),
    db.delete(intelligenceNotificationPreferences).where(eq(intelligenceNotificationPreferences.userId, userId)),
    db
      .update(disputeApprovals)
      .set({ approvedByEmail: null, approvedByUserId: null })
      .where(eq(disputeApprovals.approvedByUserId, userId)),
    // Codes this person approved on an account they do not own (J79).
    db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)),
    db.delete(session).where(eq(session.userId, userId)),
    db.delete(authAccount).where(eq(authAccount.userId, userId)),
    db.delete(verification).where(or(eq(verification.identifier, email), eq(verification.value, userId))),
    db.delete(user).where(eq(user.id, userId)),
  ];
}

/** The whole deletion as one atomic batch, the audit row first. Pure. */
export function buildAccountDeletionBatch(db: Db, plan: DeletionPlan, now: Date): DeletionBatch {
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
    ...buildUserDeletionStatements(db, plan),
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

export interface DeauthorizeFailure {
  connectionId: string;
  stripeUserId: string;
  error: string;
}

export const ACCOUNT_DELETION_DEAUTHORIZE_FAILED_ACTION = "user_self_deleted_account_deauthorize_failed";

/** One durable admin_audit_log row for a Stripe grant that could not be revoked
 *  after a deletion, through the one audit writer. Ids and the error only: the
 *  person's email and name are already gone and are not written back here. */
export async function recordDeauthorizeFailure(db: Db, userId: string, failure: DeauthorizeFailure): Promise<void> {
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

  const deauthorizeErrors: Array<{ connectionId: string; stripeUserId: string; error: string }> = [];
  for (const c of local.liveConnections) {
    const result = await deauthorize(env, c.stripeUserId);
    if (!result.ok) {
      const failure = { connectionId: c.id, stripeUserId: c.stripeUserId, error: result.error ?? "unknown error" };
      deauthorizeErrors.push(failure);
      console.error(`stripe deauthorize failed after account deletion, connection ${c.id}:`, result.error);
      // Nobody is signed in to see this once the account is gone, so the
      // failure is written where an operator finds it (/admin/platform/audit-log). A
      // failed write is logged and never reports the deletion as failed.
      try {
        await recordFailure(env, userId, failure);
      } catch (err) {
        console.error(`could not record deauthorize failure for connection ${c.id}:`, err);
      }
    }
  }
  return { status: "deleted", accountIds: local.accountIds, deauthorizeErrors };
}

