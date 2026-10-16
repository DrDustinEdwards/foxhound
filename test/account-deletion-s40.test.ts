import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { account as authAccount, session, user, verification } from "~/db/auth-schema";
import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";
import { getBillingLedger } from "~/lib/billing/queries.server";
import { getBillingPreview } from "~/lib/billing/preview.server";
import { cancelMerchantLocal } from "~/lib/admin/merchants.server";
import { deleteUserAccountLocal } from "~/lib/auth/delete-account.server";
import type { Db } from "~/db";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S40: account deletion that keeps fee evidence (job J08, Q14 and Q16).
//
// Recova's delete_account_cascade destroys recovered_payments, the rows
// Foxhound's fees are billed on. Dustin ruled (Q14, Q16) that deletion removes
// the merchant's personal data AND their end customers' names, emails and
// other personal details, while the payments Foxhound recovered survive with
// only what proves the fee: amounts, currency, dates, Stripe ids and the
// attribution chain.
//
// THE DATABASE ENFORCES FOREIGN KEYS HERE, as D1 does in production. The
// shared harness leaves them off (RULES.md 3.11), so a delete in the wrong
// order would pass there and fail on D1. Every test in this file runs with
// foreign_keys = ON and ends with a foreign_key_check.

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 9, 14, 12));
const OLD = new Date(NOW.getTime() - 45 * DAY); // matured: billable
const OLDER = new Date(NOW.getTime() - 80 * DAY); // billed last month

// Every personal value seeded into the deleting merchant's data. After
// deletion none of these may appear ANYWHERE in the database, in any column of
// any table. Scanning the whole database rather than a list of columns is the
// point: a column nobody remembered is still caught.
const OWNER_EMAIL = "owner@acme.test";
const OWNER_NAME = "Olive Owner";
const TEAMMATE_EMAIL = "teammate@acme.test";
const PERSONAL_VALUES = [
  OWNER_EMAIL,
  OWNER_NAME,
  TEAMMATE_EMAIL,
  "Acme Widgets LLC",
  "notify@acme.test",
  "digest@acme.test",
  "https://hooks.slack.com/services/T000/B000/acme",
  "Acme Billing Team",
  "replies@acme.test",
  "Warm and friendly, Acme voice",
  "Ada Customer",
  "ada@customer.test",
  "Bea Lapsed",
  "bea@customer.test",
  "Cy Disputer",
  "cy@customer.test",
  "203.0.113.77",
  "1 Elm Street, Springfield",
  "Ada left a note",
  "Hi Ada, your card was declined",
  "Ada wrote back angrily",
  "Too expensive, said Ada",
  "TRACK-ADA-1",
  "pk_live_acme",
  "sk_live_acme_secret",
  "the industry is Ada widgets",
  "Ada key",
];

// The other merchant: a different user owning a different account. Nothing
// about them may change.
const OTHER_EMAIL = "other@globex.test";

let sqlite: Database.Database;
let db: Db;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  sqlite.pragma("foreign_keys = ON");
});

function foreignKeyViolations(): unknown[] {
  return sqlite.prepare("PRAGMA foreign_key_check").all();
}

function tableNames(): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT LIKE '%_fts%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** Every row of every table, as text. */
function dumpAll(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const name of tableNames()) {
    out[name] = sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return out;
}

/** The rows of every table that carry the given account id, or belong to the given user. */
function dumpFor(accountId: string, userId: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const all = dumpAll();
  for (const [name, rows] of Object.entries(all)) {
    const text = rows.filter((r) => {
      const s = JSON.stringify(r);
      return s.includes(accountId) || s.includes(userId);
    });
    if (text.length > 0) out[name] = text;
  }
  return out;
}

interface Seeded {
  userId: string;
  accountId: string;
}

async function seedMerchant(opts: {
  userId: string;
  email: string;
  name: string;
  accountId: string;
  prefix: string;
  personal: boolean;
}): Promise<Seeded> {
  const { userId, accountId, prefix: p } = opts;
  // The other merchant's values are the deleting merchant's REVERSED, so they
  // are just as present but can never contain one of PERSONAL_VALUES.
  const t = (s: string) => (opts.personal ? s : `${p}:${[...s].reverse().join("")}`);
  const at = (ms: number) => new Date(ms);

  await db.insert(user).values({ id: userId, name: opts.name, email: opts.email, emailVerified: true, updatedAt: OLD });
  await db.insert(session).values({
    id: `${p}-sess`,
    token: `${p}-token`,
    userId,
    expiresAt: at(NOW.getTime() + DAY),
    updatedAt: OLD,
    ipAddress: t("203.0.113.77"),
    userAgent: "test",
    activeAccountId: accountId,
  });
  await db.insert(authAccount).values({
    id: `${p}-ba`,
    accountId: userId,
    providerId: "credential",
    userId,
    password: "hash",
    updatedAt: OLD,
  });
  await db.insert(verification).values({
    id: `${p}-ver`,
    identifier: opts.email,
    value: userId,
    expiresAt: at(NOW.getTime() + DAY),
  });

  await db.insert(schema.accounts).values({
    id: accountId,
    name: t("Acme Widgets LLC"),
    notificationEmail: t("notify@acme.test"),
    digestEmail: t("digest@acme.test"),
    slackWebhookUrl: t("https://hooks.slack.com/services/T000/B000/acme"),
    merchantIndustry: t("the industry is Ada widgets"),
    primaryCustomerType: "b2b",
    merchantMrrSelfReported: 500_000,
    mrrEstimateCents: 500_000,
    lastVisitedPath: "/recovery/payments",
    disputeProductDescription: t("Ada widgets, hand made"),
    createdAt: OLDER,
    platformStripeCustomerId: `cus_platform_${p}`,
    liveSendsEnabled: true,
    currency: "usd",
  });
  await db.insert(schema.accountMembers).values({
    id: `${p}-owner`,
    accountId,
    userId,
    role: "owner",
    status: "active",
    createdAt: OLDER,
  });
  await db.insert(schema.accountMembers).values({
    id: `${p}-invite`,
    accountId,
    userId: null,
    role: "member",
    invitedEmail: t(TEAMMATE_EMAIL),
    status: "pending",
    inviteToken: `${p}-invite-token`,
    createdAt: OLDER,
  });
  await db.insert(schema.stripeConnections).values({
    id: `${p}-conn`,
    accountId,
    stripeUserId: `acct_${p}`,
    stripeAccessToken: t("sk_live_acme_secret"),
    stripePublishableKey: t("pk_live_acme"),
    name: t("Acme Widgets LLC"),
    isPrimary: true,
    connectedAt: OLDER,
    createdAt: OLDER,
    senderName: t("Acme Billing Team"),
    replyToEmail: t("replies@acme.test"),
    brandVoice: t("Warm and friendly, Acme voice"),
  });
  await db.insert(schema.accountSubscriptions).values({
    id: `${p}-sub`,
    accountId,
    product: "intelligence",
    status: "canceled",
    createdAt: OLDER,
    canceledAt: OLD,
    cancellationReason: "too_expensive",
    cancellationFeedback: t("Too expensive, said Ada"),
  });
  await db.insert(schema.apiKeys).values({
    id: `${p}-key`,
    accountId,
    keyHash: `${p}-hash`,
    label: t("Ada key"),
    scope: "read",
    createdAt: OLDER,
  });
  // An external agent connected over OAuth (J79): its client, the code the
  // owner approved and the grant whose access token is the key above. The
  // grant points at the key, so the key cannot go first.
  await db.insert(schema.oauthClients).values({
    id: `${p}-client`,
    clientName: "Agent",
    redirectUris: ["https://agent.example.com/callback"],
    createdAt: OLDER,
  });
  await db.insert(schema.oauthAuthorizationCodes).values({
    id: `${p}-code`,
    codeHash: `${p}-code-hash`,
    clientId: `${p}-client`,
    accountId,
    userId,
    redirectUri: "https://agent.example.com/callback",
    codeChallenge: "x".repeat(43),
    expiresAt: OLDER,
    usedAt: OLDER,
    createdAt: OLDER,
  });
  await db.insert(schema.oauthGrants).values({
    id: `${p}-grant`,
    clientId: `${p}-client`,
    accountId,
    apiKeyId: `${p}-key`,
    userId,
    codeId: `${p}-code`,
    refreshHash: `${p}-refresh-hash`,
    refreshExpiresAt: NOW,
    createdAt: OLDER,
  });

  // ---- Recovery: three failed payments ----
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
      customerTimezone: "America/Chicago",
      customerLtvCents: 120_000,
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

  const recovered = (id: string, fp: string, recoveredAt: Date, kind: string, stepId: string | null) =>
    db.insert(schema.recoveredPayments).values({
      id: `${p}-${id}`,
      failedPaymentId: `${p}-${fp}`,
      recoveredAt,
      amountCents: 10_000,
      currency: "usd",
      recoveryMethod: kind === "stripe_baseline" ? "stripe_baseline" : "foxhound_retry",
      recoveredByStepId: stepId ? `${p}-${stepId}` : null,
      recoveryTrigger: kind === "stripe_baseline" ? "unknown" : "retry",
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

  // ---- Disputes ----
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

  // ---- Billing: one invoice already issued for rp-billed ----
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

  // ---- Everything else that carries personal data ----
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
  await db.insert(schema.customerNotes).values({
    id: `${p}-note`,
    accountId,
    stripeCustomerId: `cus_${p}_ada`,
    body: t("Ada left a note"),
    createdBy: userId,
    createdAt: OLD,
  });
  await db.insert(schema.intelligenceNotificationPreferences).values({
    id: `${p}-inp`,
    accountId,
    userId,
    createdAt: OLD,
    updatedAt: OLD,
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
    payload: { data: { object: { customer_email: t("ada@customer.test"), customer_name: t("Ada Customer") } } },
  });

  return { userId, accountId };
}

async function seedBoth(): Promise<{ me: Seeded; other: Seeded }> {
  const me = await seedMerchant({
    userId: "user_me",
    email: OWNER_EMAIL,
    name: OWNER_NAME,
    accountId: "acct_me",
    prefix: "me",
    personal: true,
  });
  const other = await seedMerchant({
    userId: "user_other",
    email: OTHER_EMAIL,
    name: "Otto Other",
    accountId: "acct_other",
    prefix: "ot",
    personal: false,
  });
  return { me, other };
}

/** The numbers the fee is computed from: the billable sets, the preview the
 *  /billing page shows, and the evidence ledger, reduced to amounts and ids. */
async function feePicture(accountId: string) {
  const recoveries = await getBillableRecoveries(db, accountId, NOW.getTime());
  const disputes = await getBillableDisputes(db, accountId, NOW.getTime());
  const preview = await getBillingPreview(db, accountId, NOW.getTime());
  const ledger = await getBillingLedger(db, accountId);
  return {
    billableRecoveries: recoveries.map((r) => ({ id: r.id, amountCents: r.amountCents, currency: r.currency })),
    billableDisputes: disputes.map((d) => ({ id: d.id, amountCents: d.amountCents, fee: d.resolvedFeeCents })),
    estimatedInvoice: preview.estimatedInvoice,
    ledgerLines: ledger.lineItems.map((l) => ({
      line: l.lineItem.id,
      amountCents: l.lineItem.amountCents,
      recovered: l.recoveredPayment?.id ?? null,
      recoveredAmount: l.recoveredPayment?.amountCents ?? null,
      attribution: l.recoveredPayment?.attributionKind ?? null,
      step: l.creditedStepType,
    })),
    free: ledger.freeRecoveries.map((f) => ({ id: f.recoveredPayment.id, amountCents: f.recoveredPayment.amountCents })),
  };
}

describe("S40 account deletion: the fee survives", () => {
  it("the fee for the account computes to the same amount after deletion as before", async () => {
    const { me } = await seedBoth();
    const before = await feePicture(me.accountId);
    // The fixture must actually bill something, or "unchanged" proves nothing.
    expect(before.billableRecoveries).toHaveLength(1);
    expect(before.billableDisputes).toHaveLength(1);
    expect(before.estimatedInvoice).toEqual([{ currency: "usd", cents: 2_000 + 10_000 }]);
    expect(before.ledgerLines).toHaveLength(1);
    expect(before.free).toHaveLength(1);

    const result = await deleteUserAccountLocal(db, me.userId, NOW);
    expect(result.status).toBe("deleted");

    expect(await feePicture(me.accountId)).toEqual(before);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("keeps the evidence chain action -> recovery -> line item, by id", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);

    const rp = await db.select().from(schema.recoveredPayments).where(eq(schema.recoveredPayments.accountId, me.accountId));
    expect(rp.map((r) => r.id).sort()).toEqual(["me-rp-billable", "me-rp-billed", "me-rp-free"]);
    const steps = await db.select().from(schema.recoverySteps).where(eq(schema.recoverySteps.accountId, me.accountId));
    expect(steps.map((s) => s.id).sort()).toEqual(["me-step-billable", "me-step-billed"]);
    // The attributing click survives with its timing, so email_engaged stays provable.
    const clicks = await db.select().from(schema.engagementEvents).where(eq(schema.engagementEvents.accountId, me.accountId));
    expect(clicks.map((c) => c.id)).toEqual(["me-click-billable"]);
    expect(clicks[0].occurredAt).toEqual(OLDER);
    const fps = await db.select().from(schema.failedPayments).where(eq(schema.failedPayments.accountId, me.accountId));
    expect(fps.map((f) => f.id).sort()).toEqual(["me-fp-billable", "me-fp-billed", "me-fp-free"]);
    for (const fp of fps) {
      expect(fp.stripeInvoiceId).toBe(`in_me_${fp.id.slice(3)}`);
      expect(fp.stripeCustomerId).toBe("cus_me_ada");
      expect(fp.amountCents).toBe(10_000);
      expect(fp.currency).toBe("usd");
    }
    const disputes = await db.select().from(schema.disputes).where(eq(schema.disputes.accountId, me.accountId));
    expect(disputes.map((d) => d.id)).toEqual(["me-d-won"]);
    expect(disputes[0]).toMatchObject({ stripeDisputeId: "dp_me_d-won", amountCents: 50_000, resolvedFeeCents: 10_000 });
    const approvals = await db.select().from(schema.disputeApprovals).where(eq(schema.disputeApprovals.accountId, me.accountId));
    expect(approvals.map((a) => a.id)).toEqual(["me-d-won-approval"]);
    const lines = await db.select().from(schema.billingLineItems).where(eq(schema.billingLineItems.accountId, me.accountId));
    expect(lines.map((l) => l.recoveredPaymentId)).toEqual(["me-rp-billed"]);
    // The account row survives as the key the fee and its invoices hang from,
    // with the platform customer the invoice is charged to.
    const acct = await db.select().from(schema.accounts).where(eq(schema.accounts.id, me.accountId));
    expect(acct).toHaveLength(1);
    expect(acct[0].platformStripeCustomerId).toBe("cus_platform_me");
    expect(acct[0].cancelledAt).toEqual(NOW);
    expect(acct[0].liveSendsEnabled).toBe(false);
  });
});

describe("S40 account deletion: the personal data is gone", () => {
  it("no personal value of the merchant or their customers appears in any column of any table", async () => {
    const { me } = await seedBoth();
    // The scan must be able to find what it looks for (RULES.md 6.4).
    const beforeText = JSON.stringify(dumpAll());
    for (const value of PERSONAL_VALUES) expect(beforeText, value).toContain(value);

    await deleteUserAccountLocal(db, me.userId, NOW);

    const after = dumpAll();
    for (const [table, rows] of Object.entries(after)) {
      const text = JSON.stringify(rows);
      for (const value of PERSONAL_VALUES) {
        expect(text.includes(value), `${table} still holds "${value}"`).toBe(false);
      }
    }
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("removes the user, their sessions, sign-in methods, verification tokens and memberships", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);
    expect(await db.select().from(user).where(eq(user.id, me.userId))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, me.userId))).toEqual([]);
    expect(await db.select().from(authAccount).where(eq(authAccount.userId, me.userId))).toEqual([]);
    expect(await db.select().from(verification).where(eq(verification.value, me.userId))).toEqual([]);
    expect(await db.select().from(schema.accountMembers).where(eq(schema.accountMembers.accountId, me.accountId))).toEqual([]);
  });

  it("deletes the rows that are not fee evidence, as Recova's delete does", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);
    const emptyTables = [
      schema.apiKeys,
      schema.oauthGrants,
      schema.oauthAuthorizationCodes,
      schema.winBackSequences,
      schema.winBackSteps,
      schema.expiringCardAlerts,
      schema.emailSuppressions,
      schema.emailDeadLetters,
      schema.customerContext,
      schema.healthScoreHistory,
      schema.predictions,
      schema.customerNotes,
      schema.intelligenceNotificationPreferences,
      schema.intelligenceReports,
      schema.alerts,
      schema.alertHistory,
      schema.mrrSnapshots,
      schema.auditRuns,
      schema.auditDigestRuns,
      schema.aiCalls,
      schema.disputeEvidence,
    ] as const;
    for (const table of emptyTables) {
      const rows = (await db.select().from(table)) as Array<{ accountId?: string | null }>;
      expect(rows.filter((r) => r.accountId === me.accountId)).toEqual([]);
    }
    const sends = await db.select().from(schema.emailSends).where(eq(schema.emailSends.accountId, me.accountId));
    expect(sends.map((s) => s.id)).toEqual(["me-send-billable"]);
    expect(sends[0].recipientHash).toBeNull();
  });

  it("records the deletion in the admin audit log without the person's email", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);
    const rows = await db.select().from(schema.adminAuditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "user_self_deleted_account", targetUserId: me.userId, targetEmail: null });
    expect(JSON.stringify(rows[0])).not.toContain(OWNER_EMAIL);
  });
});

describe("S40 account deletion: scope", () => {
  it("leaves another account and its user exactly as they were", async () => {
    const { me, other } = await seedBoth();
    const before = dumpFor(other.accountId, other.userId);
    expect(Object.keys(before).length).toBeGreaterThan(20);
    await deleteUserAccountLocal(db, me.userId, NOW);
    expect(dumpFor(other.accountId, other.userId)).toEqual(before);
  });

  it("a second deletion is a no-op and writes nothing", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);
    const after = dumpAll();
    const second = await deleteUserAccountLocal(db, me.userId, new Date(NOW.getTime() + DAY));
    expect(second.status).toBe("not_found");
    expect(dumpAll()).toEqual(after);
  });

  it("a member who owns nothing loses only their own membership and personal rows", async () => {
    const { other } = await seedBoth();
    await db.insert(user).values({ id: "user_teammate", name: "Tess Teammate", email: "tess@globex.test", updatedAt: OLD });
    await db.insert(schema.accountMembers).values({
      id: "ot-tess",
      accountId: other.accountId,
      userId: "user_teammate",
      role: "member",
      status: "active",
      createdAt: OLD,
    });
    await db.insert(schema.disputeApprovals).values({
      id: "ot-tess-approval",
      disputeId: "ot-d-open",
      accountId: other.accountId,
      approvedByUserId: "user_teammate",
      approvedByEmail: "tess@globex.test",
      evidenceVersionHash: "h",
      approvedAt: OLD,
    });
    const accountBefore = await db.select().from(schema.accounts).where(eq(schema.accounts.id, other.accountId));

    const result = await deleteUserAccountLocal(db, "user_teammate", NOW);
    expect(result).toEqual({ status: "deleted", accountIds: [], liveConnections: [] });

    expect(await db.select().from(user).where(eq(user.id, "user_teammate"))).toEqual([]);
    expect(await db.select().from(schema.accountMembers).where(eq(schema.accountMembers.id, "ot-tess"))).toEqual([]);
    // The owner's membership and the account itself are untouched.
    expect(await db.select().from(schema.accountMembers).where(eq(schema.accountMembers.id, "ot-owner"))).toHaveLength(1);
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.id, other.accountId))).toEqual(accountBefore);
    // Their email is gone from the approval they signed, and the approval stays.
    const approval = await db.select().from(schema.disputeApprovals).where(eq(schema.disputeApprovals.id, "ot-tess-approval"));
    expect(approval[0]).toMatchObject({ approvedByEmail: null, approvedByUserId: null, evidenceVersionHash: "h" });
    expect(JSON.stringify(dumpAll())).not.toContain("tess@globex.test");
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("an owner's deletion removes the other members of the accounts they own, and keeps those people", async () => {
    const { me } = await seedBoth();
    await db.insert(user).values({ id: "user_mate", name: "Mo Mate", email: "mo@acme-staff.test", updatedAt: OLD });
    await db.insert(schema.accountMembers).values({
      id: "me-mo",
      accountId: me.accountId,
      userId: "user_mate",
      role: "member",
      status: "active",
      createdAt: OLD,
    });
    await deleteUserAccountLocal(db, me.userId, NOW);
    expect(await db.select().from(schema.accountMembers).where(eq(schema.accountMembers.userId, "user_mate"))).toEqual([]);
    expect(await db.select().from(user).where(eq(user.id, "user_mate"))).toHaveLength(1);
  });

  it("returns the live Stripe connections it disconnected, so their grants can be revoked", async () => {
    const { me } = await seedBoth();
    const result = await deleteUserAccountLocal(db, me.userId, NOW);
    expect(result).toEqual({
      status: "deleted",
      accountIds: [me.accountId],
      liveConnections: [{ id: "me-conn", stripeUserId: "acct_me" }],
    });
    const conn = await db.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.id, "me-conn"));
    expect(conn[0]).toMatchObject({ disconnectedAt: NOW, stripeAccessToken: null, stripeUserId: "acct_me" });
  });
});

describe("S40: the cancel path is unchanged", () => {
  it("cancel still stamps cancelled_at and disconnects, and deletes or scrubs nothing", async () => {
    const { me } = await seedBoth();
    const before = dumpAll();
    await cancelMerchantLocal(db, me.accountId, NOW);
    const after = dumpAll();
    const changed = Object.keys(after).filter((t) => JSON.stringify(after[t]) !== JSON.stringify(before[t]));
    expect(changed.sort()).toEqual(["accounts", "stripe_connections"]);
    const acct = await db.select().from(schema.accounts).where(eq(schema.accounts.id, me.accountId));
    expect(acct[0]).toMatchObject({ cancelledAt: NOW, name: "Acme Widgets LLC", notificationEmail: "notify@acme.test" });
    expect(await db.select().from(user).where(eq(user.id, me.userId))).toHaveLength(1);
  });
});
