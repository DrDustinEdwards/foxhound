// The per-account scrub statements for account deletion
// (delete-account.server.ts split): what is deleted, what is anonymized, and
// the evidence a billed fee or recovery keeps.

import { and, eq, exists, inArray, isNotNull, not, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  type Db,
  accountMembers,
  accountSubscriptions,
  accounts,
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
  healthScoreHistory,
  intelligenceNotificationPreferences,
  intelligenceReports,
  mrrSnapshots,
  oauthAuthorizationCodes,
  oauthGrants,
  predictions,
  recommendationLog,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
  webhookEvents,
  winBackSequences,
  winBackSteps,
} from "~/db";

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
        brandVoiceSamples: null,
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
    db.delete(recommendationLog).where(eq(recommendationLog.accountId, accountId)),
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
