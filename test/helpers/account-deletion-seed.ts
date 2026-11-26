import * as schema from "~/db/schema";
import type { Db } from "~/db";

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = new Date(Date.UTC(2026, 9, 14, 12));
export const OLD = new Date(NOW.getTime() - 45 * DAY); // matured: billable
export const OLDER = new Date(NOW.getTime() - 80 * DAY); // billed last month

export const OWNER_EMAIL = "owner@acme.test";

/** The merchant's records: failed and recovered payments, disputes, billing,
 *  win-back, intelligence, alerts, audits and webhooks. */
export async function seedRecords(
  db: Db,
  opts: { userId: string; email: string; accountId: string; prefix: string },
  t: (s: string) => string,
): Promise<void> {
  const { userId, accountId, prefix: p } = opts;
  const at = (ms: number) => new Date(ms);

  // fp-billed: recovered 80 days ago, ALREADY billed (line item exists).
  // fp-billable: recovered 45 days ago by a Foxhound retry, matured, NOT billed yet.
  // fp-free: recovered by Stripe on its own (baseline), never billed.
  // fp-open: never recovered. Not fee evidence.
  const failed = (id: string, detectedAt: Date, status: string) =>
    db.insert(schema.failedPayments).values({
      id: `${p}-${id}`,
      stripeEventId: `evt_${p}_${id}`,
      stripeInvoiceId: `in_${p}_${id}`,
      stripeCustomerId: `cus_${p}_ada`,
      customerEmail: t("ada@customer.test"),
      customerName: t("Ada Customer"),
      amountCents: 10_000,
      currency: "usd",
      declineCode: "insufficient_funds",
      declineCategory: "soft",
      planName: "Pro",
      customerSince: OLDER,
      status,
      detectedAt,
      notes: t("Ada left a note"),
      cardBrand: "visa",
      cardCountry: "US",
      accountId,
      stripeConnectionId: `${p}-conn`,
      subscriptionId: `sub_${p}_ada`,
    });
  await failed("fp-billed", at(OLDER.getTime() - 5 * DAY), "recovered");
  await failed("fp-billable", at(OLD.getTime() - 5 * DAY), "recovered");
  await failed("fp-free", at(OLD.getTime() - 5 * DAY), "recovered");
  await failed("fp-open", at(NOW.getTime() - 3 * DAY), "active");

  const step = (id: string, fp: string) =>
    db.insert(schema.recoverySteps).values({
      id: `${p}-${id}`,
      failedPaymentId: `${p}-${fp}`,
      stepType: "email",
      stepNumber: 1,
      scheduledAt: OLDER,
      executedAt: OLDER,
      result: "sent",
      aiSubject: t("Hi Ada, your card was declined"),
      aiBodyHtml: `<p>${t("Hi Ada, your card was declined")}</p>`,
      customBody: t("Ada wrote back angrily"),
      clickedAt: OLDER,
      accountId,
      lastAttemptError: `bounce for ${t("ada@customer.test")}`,
    });
  await step("step-billed", "fp-billed");
  await step("step-billable", "fp-billable");
  await step("step-open", "fp-open");

  const send = (id: string, stepId: string) =>
    db.insert(schema.emailSends).values({
      id: `${p}-${id}`,
      accountId,
      recoveryStepId: `${p}-${stepId}`,
      template: "dunning",
      recipientHash: `hash-of-${t("ada@customer.test")}`,
      status: "sent",
      error: null,
      sentAt: OLDER,
      idempotencyKey: `${p}-${id}-key`,
      createdAt: OLDER,
    });
  await send("send-billable", "step-billable");
  await send("send-open", "step-open");

  const click = (id: string, stepId: string, sendId: string) =>
    db.insert(schema.engagementEvents).values({
      id: `${p}-${id}`,
      accountId,
      emailSendId: `${p}-${sendId}`,
      recoveryStepId: `${p}-${stepId}`,
      eventType: "click",
      idempotencyKey: `${p}-${id}-key`,
      targetUrl: `https://foxhoundapp.com/u/${p}?email=${t("ada@customer.test")}`,
      occurredAt: OLDER,
      createdAt: OLDER,
    });
  await click("click-billable", "step-billable", "send-billable");
  await click("click-open", "step-open", "send-open");

  const recovered = (
    id: string,
    fp: string,
    recoveredAt: Date,
    kind: string,
    stepId: string | null,
  ) =>
    db.insert(schema.recoveredPayments).values({
      id: `${p}-${id}`,
      failedPaymentId: `${p}-${fp}`,
      recoveredAt,
      amountCents: 10_000,
      currency: "usd",
      recoveryMethod: kind === "stripe_baseline" ? "stripe_baseline" : "foxhound_retry",
      recoveredByStepId: stepId ? `${p}-${stepId}` : null,
      accountId,
      attributionKind: kind,
      attributionRef: stepId ? `${p}-${stepId}` : null,
      attributedAt: kind === "stripe_baseline" ? null : recoveredAt,
    });
  await recovered("rp-billed", "fp-billed", OLDER, "foxhound_retry", "step-billed");
  await recovered("rp-billable", "fp-billable", OLD, "foxhound_retry", "step-billable");
  await recovered("rp-free", "fp-free", OLD, "stripe_baseline", null);

  await db.insert(schema.outcomes).values({
    id: `${p}-outcome`,
    accountId,
    product: "recovery",
    eventType: "payment_recovered",
    eventData: { amountCents: 10_000, currency: "usd", method: "foxhound_retry" },
    outcome: "recovered_attributed",
    outcomeAt: OLD,
    createdAt: OLD,
    idempotencyKey: `recovery:${p}-fp-billable`,
    attributionKind: "foxhound_retry",
    attributedRef: `${p}-step-billable`,
  });

  // d-won: resolved won, Foxhound submitted it, approved: billable.
  // d-open: still a draft. Not fee evidence.
  const dispute = (id: string, state: string, submitted: boolean) =>
    db.insert(schema.disputes).values({
      id: `${p}-${id}`,
      accountId,
      stripeDisputeId: `dp_${p}_${id}`,
      stripeChargeId: `ch_${p}_${id}`,
      stripeCustomerId: `cus_${p}_cy`,
      customerEmail: t("cy@customer.test"),
      customerName: t("Cy Disputer"),
      amountCents: 50_000,
      currency: "usd",
      reason: "fraudulent",
      status: state === "resolved_won" ? "won" : "needs_response",
      createdAt: OLDER,
      stripeConnectionId: `${p}-conn`,
      resolvedAt: state === "resolved_won" ? OLD : null,
      submittedAt: submitted ? OLDER : null,
      customerIp: t("203.0.113.77"),
      billingAddress: t("1 Elm Street, Springfield"),
      aiResponseText: `Evidence about ${t("Cy Disputer")}`,
      submittedBy: t(OWNER_EMAIL),
      shippingTrackingNumber: t("TRACK-ADA-1"),
      priorChargesJson: [{ email: t("cy@customer.test") }],
      state,
      resolvedFeeCents: state === "resolved_won" ? 10_000 : null,
      resolvedFeeCurrency: state === "resolved_won" ? "usd" : null,
    });
  await dispute("d-won", "resolved_won", true);
  await dispute("d-open", "draft", false);
  for (const d of ["d-won", "d-open"]) {
    await db.insert(schema.disputeEvidence).values({
      id: `${p}-${d}-ev`,
      disputeId: `${p}-${d}`,
      accountId,
      fieldName: "customer_name",
      fieldValue: t("Cy Disputer"),
      createdAt: OLDER,
    });
  }
  await db.insert(schema.disputeApprovals).values({
    id: `${p}-d-won-approval`,
    disputeId: `${p}-d-won`,
    accountId,
    approvedByUserId: userId,
    approvedByEmail: opts.email,
    evidenceVersionHash: "hash",
    approvedAt: OLDER,
  });

  await db.insert(schema.billingInvoices).values({
    id: `${p}-inv`,
    accountId,
    currency: "usd",
    periodStart: OLDER,
    periodEnd: OLD,
    status: "paid",
    totalCents: 2_000,
    stripeInvoiceId: `in_platform_${p}`,
    idempotencyKey: `${p}-inv-key`,
    createdAt: OLD,
  });
  await db.insert(schema.billingLineItems).values({
    id: `${p}-line`,
    invoiceId: `${p}-inv`,
    accountId,
    type: "recovery_fee",
    currency: "usd",
    amountCents: 2_000,
    feeCents: 2_000,
    recoveredPaymentId: `${p}-rp-billed`,
    description: "Recovery fee",
    createdAt: OLD,
  });

  await db.insert(schema.winBackSequences).values({
    id: `${p}-wb`,
    stripeCustomerId: `cus_${p}_bea`,
    stripeSubscriptionId: `sub_${p}_bea`,
    customerEmail: t("bea@customer.test"),
    customerName: t("Bea Lapsed"),
    status: "active",
    createdAt: OLD,
    accountId,
    stripeConnectionId: `${p}-conn`,
  });
  await db.insert(schema.winBackSteps).values({
    id: `${p}-wbs`,
    winBackSequenceId: `${p}-wb`,
    stepNumber: 1,
    scheduledAt: OLD,
    aiSubject: `${t("Bea Lapsed")}, come back`,
    accountId,
  });
  await db.insert(schema.emailSends).values({
    id: `${p}-send-wb`,
    accountId,
    winBackStepId: `${p}-wbs`,
    template: "winback",
    recipientHash: `hash-of-${t("bea@customer.test")}`,
    status: "sent",
    createdAt: OLD,
  });
  await db.insert(schema.expiringCardAlerts).values({
    id: `${p}-eca`,
    stripeCustomerId: `cus_${p}_bea`,
    customerEmail: t("bea@customer.test"),
    customerName: t("Bea Lapsed"),
    cardLast4: "4242",
    expiresMonth: 12,
    expiresYear: 2026,
    createdAt: OLD,
    accountId,
  });
  await db.insert(schema.emailSuppressions).values({
    id: `${p}-supp`,
    email: t("bea@customer.test"),
    token: `${p}-supp-token`,
    accountId,
    reason: "unsubscribe",
  });
  await db.insert(schema.emailDeadLetters).values({
    id: `${p}-dlq`,
    accountId,
    recipientHash: `hash-of-${t("ada@customer.test")}`,
    error: `failed for ${t("ada@customer.test")}`,
    createdAt: OLD,
  });
  await db.insert(schema.customerContext).values({
    id: `${p}-cc`,
    accountId,
    stripeCustomerId: `cus_${p}_ada`,
    customerEmail: t("ada@customer.test"),
    customerName: t("Ada Customer"),
    aiAssessment: `${t("Ada Customer")} is at risk`,
    createdAt: OLD,
    updatedAt: OLD,
  });
  await db.insert(schema.healthScoreHistory).values({
    id: `${p}-hsh`,
    accountId,
    customerContextId: `${p}-cc`,
    stripeCustomerId: `cus_${p}_ada`,
    recordedAt: OLD,
    healthScore: 40,
    healthFactors: {},
    scoreSource: "rules",
  });
  await db.insert(schema.predictions).values({
    id: `${p}-pred`,
    accountId,
    stripeCustomerId: `cus_${p}_ada`,
    score: 40,
    horizonDays: 30,
    predictedAt: OLD,
  });
  await db.insert(schema.intelligenceReports).values({
    id: `${p}-ir`,
    accountId,
    reportMonth: OLD,
    narrative: `${t("Ada Customer")} churned`,
    generatedAt: OLD,
  });
  await db.insert(schema.alerts).values({
    id: `${p}-alert`,
    accountId,
    metric: "mrr",
    thresholdValue: 1,
    direction: "below",
    channel: "email",
    label: t("Ada key"),
    createdAt: OLD,
  });
  await db.insert(schema.alertHistory).values({
    id: `${p}-ah`,
    alertId: `${p}-alert`,
    accountId,
    metric: "mrr",
    thresholdValue: 1,
    direction: "below",
    actualValue: 0,
    channel: "email",
    firedAt: OLD,
  });
  await db.insert(schema.mrrSnapshots).values({
    id: `${p}-mrr`,
    accountId,
    snapshotDate: OLD,
    totalMrrCents: 1,
    newMrrCents: 0,
    expansionMrrCents: 0,
    contractionMrrCents: 0,
    churnMrrCents: 0,
    reactivationMrrCents: 0,
    activeCustomersCount: 1,
    newCustomersCount: 0,
    churnedCustomersCount: 0,
    perPlanBreakdown: {},
    perCohortBreakdown: {},
    perChannelBreakdown: {},
    currency: "usd",
    createdAt: OLD,
  });
  await db.insert(schema.auditRuns).values({
    id: `${p}-audit`,
    accountId,
    runAt: OLD,
    lookbackDays: 90,
    aiSummary: `${t("Acme Widgets LLC")} leaks revenue`,
    createdAt: OLD,
  });
  await db.insert(schema.auditDigestRuns).values({
    id: `${p}-adr`,
    accountId,
    periodMonth: "2026-08",
    status: "sent",
    createdAt: OLD,
  });
  await db.insert(schema.aiCalls).values({
    id: `${p}-ai`,
    accountId,
    source: "dunning",
    model: "m",
    promptTokens: 1,
    completionTokens: 1,
    costCents: 1,
    createdAt: OLD,
  });
  await db.insert(schema.webhookEvents).values({
    id: `${p}-wh`,
    stripeEventId: `evt_${p}_wh`,
    eventType: "invoice.payment_failed",
    receivedAt: OLD,
    accountId,
    processed: true,
    payload: {
      data: {
        object: { customer_email: t("ada@customer.test"), customer_name: t("Ada Customer") },
      },
    },
  });
}
