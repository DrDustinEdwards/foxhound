import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import {
  accountMembers,
  accountSubscriptions,
  accounts,
  alertHistory,
  alerts,
  billingInvoices,
  billingLineItems,
  customerContext,
  disputeApprovals,
  disputeEvidence,
  disputes,
  expiringCardAlerts,
  failedPayments,
  healthScoreHistory,
  intelligenceReports,
  mrrSnapshots,
  predictions,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
  winBackSteps,
} from "~/db";
import { grantIntelligence } from "~/lib/admin/merchants.server";

import {
  DEMO_ACCOUNT_ID,
  DEMO_ACCOUNT_NAME,
  DEMO_MEMBER_EMAIL,
  DEMO_MEMBER_USER_ID,
} from "./constants";

// The demo seeder. Builds ONE real account (Teamflow) and populates every product
// table with believable, DETERMINISTIC data, so the REAL app routes render a
// convincing portfolio (audit priority #2, TASK-foxhound-demo-system.md). This is
// NOT a set of mock pages: /dashboard, /recovery/*, /disputes/*, /intelligence/*
// all read these rows through their normal loaders.
//
// Two hard invariants:
//  - Firewall: the account id carries DEMO_ACCOUNT_ID_PREFIX and the row is
//    billing_exempt + processing_paused, so every Stripe/AI account enumeration
//    (billable.ts, recovery-tick, intelligence sync/ai) skips it. The seeder
//    itself makes NO Stripe or Anthropic call: narratives/assessments are
//    pre-written strings, never a live model call.
//  - Deterministic + idempotent: a fixed PRNG + fixed ids mean the same data every
//    run, and the seed always deletes the demo account's rows first, so the reset
//    cron can rebuild it repeatedly without drift or duplicate rows.
//
// Money is integer cents. Timestamps are relative to the passed-in `now`, so the
// data always looks recent no matter when the reset cron last ran.

const CURRENCY = "usd";
const TOTAL_CUSTOMERS = 185;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic PRNG (mulberry32): same sequence every seed run. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)];
}

function intBetween(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

const NAME_PREFIXES = [
  "North", "Cobalt", "Ridge", "Harbor", "Summit", "Cedar", "Vertex", "Lumen",
  "Beacon", "Atlas", "Orbit", "Quartz", "Slate", "Willow", "Pine", "Maple",
  "Coral", "Ember", "Frost", "Nimbus", "Onyx", "Terra", "Vela", "Zephyr",
  "Anchor", "Brook", "Delta", "Echo", "Flint", "Grove",
];
const NAME_SUFFIXES = [
  "Labs", "Systems", "Digital", "Studio", "Works", "Group", "Analytics",
  "Cloud", "Software", "Collective", "Partners", "Technologies",
];
const PLANS = [
  { name: "Starter", tier: "starter", mrr: 2900 },
  { name: "Growth", tier: "growth", mrr: 9900 },
  { name: "Scale", tier: "scale", mrr: 24900 },
  { name: "Enterprise", tier: "enterprise", mrr: 49900 },
];

/** Weighted plan mix (mostly Starter/Growth) so 185 customers total ~$26k MRR,
 *  matching the legacy demo portfolio rather than an unrealistic enterprise-heavy one. */
function pickPlan(rand: () => number): (typeof PLANS)[number] {
  const r = rand();
  if (r < 0.35) return PLANS[0];
  if (r < 0.7) return PLANS[1];
  if (r < 0.92) return PLANS[2];
  return PLANS[3];
}

interface DemoCustomer {
  index: number;
  stripeCustomerId: string;
  name: string;
  email: string;
  planName: string;
  planTier: string;
  mrrCents: number;
  healthScore: number;
  factors: { signal: string; deltaPoints: number; detail: string }[];
  assessment: string | null;
  customerSinceMs: number;
}

const RISK_FACTORS = [
  { signal: "payment_latency_drift", deltaPoints: -18, detail: "Payments have been arriving progressively later each cycle." },
  { signal: "downgrade", deltaPoints: -14, detail: "Downgraded from an annual to a monthly plan last quarter." },
  { signal: "prior_failures", deltaPoints: -12, detail: "Two failed charges in the last 90 days." },
  { signal: "engagement_drop", deltaPoints: -9, detail: "Product logins fell sharply over the last month." },
];
const HEALTHY_FACTORS = [
  { signal: "tenure", deltaPoints: 12, detail: "On the same plan for over 18 months." },
  { signal: "expansion", deltaPoints: 10, detail: "Added seats twice in the last two quarters." },
  { signal: "clean_history", deltaPoints: 8, detail: "No failed payments, refunds, or disputes on record." },
];

/** Build the deterministic customer portfolio: 2 named high-risk anchors, ~100
 *  watch, ~83 healthy, summing to roughly $26k MRR (matches the legacy demo). */
function buildCustomers(now: number): DemoCustomer[] {
  const rand = makePrng(1013904223);
  const customers: DemoCustomer[] = [];

  const anchors: { name: string; score: number }[] = [
    { name: "Sycamore Co", score: 20 },
    { name: "Bluewave Studios", score: 28 },
  ];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const plan = PLANS[intBetween(rand, 1, 2)];
    customers.push({
      index: i,
      stripeCustomerId: `demo_cus_${i}`,
      name: a.name,
      email: `billing@${a.name.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      planName: plan.name,
      planTier: plan.tier,
      mrrCents: plan.mrr,
      healthScore: a.score,
      factors: RISK_FACTORS.slice(0, 3),
      assessment:
        `${a.name} shows the classic involuntary-churn signature: latency drift plus a recent downgrade. ` +
        `Reach out personally before the next renewal; a saved account here is worth roughly ${plan.mrr / 100} dollars a month.`,
      customerSinceMs: now - intBetween(rand, 300, 800) * DAY_MS,
    });
  }

  for (let i = anchors.length; i < TOTAL_CUSTOMERS; i++) {
    const name = `${pick(rand, NAME_PREFIXES)}${rand() < 0.5 ? " " : ""}${pick(rand, NAME_SUFFIXES)}`;
    const plan = pickPlan(rand);
    // ~100 watch (40-69), ~83 healthy (70-95). Bias by index so counts are stable.
    const watch = i < anchors.length + 100;
    const healthScore = watch ? intBetween(rand, 41, 68) : intBetween(rand, 71, 95);
    const factors = watch
      ? [pick(rand, RISK_FACTORS), pick(rand, HEALTHY_FACTORS)]
      : HEALTHY_FACTORS.slice(0, 2);
    customers.push({
      index: i,
      stripeCustomerId: `demo_cus_${i}`,
      name,
      email: `ap@${name.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      planName: plan.name,
      planTier: plan.tier,
      // Slight per-customer jitter around the plan MRR keeps the total believable.
      mrrCents: plan.mrr + intBetween(rand, -500, 800),
      healthScore,
      factors,
      assessment: null,
      customerSinceMs: now - intBetween(rand, 60, 900) * DAY_MS,
    });
  }
  return customers;
}

/** Split an array into fixed-size chunks (keeps D1 statement/param counts bounded). */
function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Run a list of write statements as batched transactions (<=50 per batch). */
async function runBatched(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  for (const group of chunk(statements, 50)) {
    if (group.length === 0) continue;
    await db.batch(group as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

/** Every demo row, deleted child-table-first so D1's foreign keys never block a
 *  reset. All demo rows carry the demo account id, so a single equality wipes each. */
async function wipeDemoAccount(db: Db): Promise<void> {
  const acct = DEMO_ACCOUNT_ID;
  // Order matters under real FK enforcement (D1): children before parents.
  await runBatched(db, [
    db.delete(billingLineItems).where(eq(billingLineItems.accountId, acct)),
    db.delete(billingInvoices).where(eq(billingInvoices.accountId, acct)),
    db.delete(disputeApprovals).where(eq(disputeApprovals.accountId, acct)),
    db.delete(disputeEvidence).where(eq(disputeEvidence.accountId, acct)),
    db.delete(disputes).where(eq(disputes.accountId, acct)),
    db.delete(healthScoreHistory).where(eq(healthScoreHistory.accountId, acct)),
    db.delete(predictions).where(eq(predictions.accountId, acct)),
    db.delete(recoveredPayments).where(eq(recoveredPayments.accountId, acct)),
    db.delete(recoverySteps).where(eq(recoverySteps.accountId, acct)),
    db.delete(failedPayments).where(eq(failedPayments.accountId, acct)),
    db.delete(winBackSteps).where(eq(winBackSteps.accountId, acct)),
    db.delete(winBackSequences).where(eq(winBackSequences.accountId, acct)),
    db.delete(expiringCardAlerts).where(eq(expiringCardAlerts.accountId, acct)),
    db.delete(customerContext).where(eq(customerContext.accountId, acct)),
    db.delete(mrrSnapshots).where(eq(mrrSnapshots.accountId, acct)),
    db.delete(intelligenceReports).where(eq(intelligenceReports.accountId, acct)),
    db.delete(alertHistory).where(eq(alertHistory.accountId, acct)),
    db.delete(alerts).where(eq(alerts.accountId, acct)),
    db.delete(accountSubscriptions).where(eq(accountSubscriptions.accountId, acct)),
    db.delete(accountMembers).where(eq(accountMembers.accountId, acct)),
  ]);
  await db.delete(accounts).where(eq(accounts.id, acct));
}

const DECLINE = [
  { code: "insufficient_funds", category: "soft" },
  { code: "processing_error", category: "network" },
  { code: "expired_card", category: "expired" },
  { code: "fraudulent", category: "fraud" },
  { code: "card_not_supported", category: "unknown" },
] as const;

const CARD_BRANDS = ["visa", "mastercard", "amex"] as const;

interface FailedPaymentPlan {
  id: string;
  customer: DemoCustomer;
  decline: (typeof DECLINE)[number];
  amountCents: number;
  status: "active" | "recovered";
  detectedAtMs: number;
  steps: { type: string; result: string | null; opened: boolean; clicked: boolean; offsetDays: number }[];
  recovered: { method: string; attribution: string; offsetDays: number } | null;
}

/** Build the recovery portfolio: a spread of failed payments across categories and
 *  states, each with a believable step timeline. Some in-flight, some recovered. */
function buildRecovery(customers: DemoCustomer[], now: number): FailedPaymentPlan[] {
  const rand = makePrng(2246822519);
  const plans: FailedPaymentPlan[] = [];
  const COUNT = 44;
  for (let i = 0; i < COUNT; i++) {
    const customer = customers[intBetween(rand, 0, customers.length - 1)];
    const decline = DECLINE[i % DECLINE.length];
    const amountCents = customer.mrrCents;
    const recovered = i % 5 !== 0; // ~80% eventually recovered
    const detectedAtMs = now - intBetween(rand, 1, 40) * DAY_MS;
    const isRetryable = decline.category === "soft" || decline.category === "network";

    // A short, believable timeline: first step then (if recovered) a success.
    const steps: FailedPaymentPlan["steps"] = [];
    if (isRetryable) {
      steps.push({ type: "retry_early", result: recovered && i % 3 === 0 ? "retry_succeeded" : "retry_card_declined", opened: false, clicked: false, offsetDays: 0 });
    }
    steps.push({ type: "email_day1", result: "email_sent", opened: true, clicked: recovered, offsetDays: 1 });
    if (!recovered) {
      steps.push({ type: "email_day3", result: i % 2 === 0 ? "email_sent" : null, opened: i % 2 === 0, clicked: false, offsetDays: 3 });
    }

    const recoveredByRetry = recovered && isRetryable && i % 3 === 0;
    plans.push({
      id: `demo_fp_${i}`,
      customer,
      decline,
      amountCents,
      status: recovered ? "recovered" : "active",
      detectedAtMs,
      steps,
      recovered: recovered
        ? {
            method: recoveredByRetry ? "foxhound_retry" : decline.category === "expired" ? "card_update" : "email_engaged",
            attribution: recoveredByRetry ? "foxhound_retry" : decline.category === "expired" ? "card_update" : "email_engaged",
            offsetDays: intBetween(rand, 1, 6),
          }
        : null,
    });
  }
  return plans;
}

const DISPUTE_REASONS = ["fraudulent", "subscription_canceled", "unrecognized"] as const;

/** Pre-written narrative for the intelligence report (NEVER an AI call). */
const DEMO_NARRATIVE =
  "Teamflow's portfolio is stable this month. Total MRR held near $26k across 185 active customers, " +
  "with net revenue retention just under 100%. Two accounts, Sycamore Co and Bluewave Studios, moved " +
  "into the high-risk band on payment-latency drift and a recent downgrade; both are worth a personal " +
  "outreach before their next renewal. Involuntary churn stayed low as Foxhound recovered the bulk of " +
  "failed charges within the first week, led by silent retries on soft declines and card-update links on " +
  "expired cards. No disputes were lost that Foxhound submitted evidence for.";

/**
 * Seed (or re-seed) the demo account and all its data. Deletes the demo account's
 * existing rows first, so it is safe to run on every reset. Deterministic: same
 * `now` in, same data out (ids and PRNG are fixed). Makes NO external call.
 */
export async function seedDemoAccount(db: Db, now: Date): Promise<void> {
  const nowMs = now.getTime();
  await wipeDemoAccount(db);

  const customers = buildCustomers(nowMs);
  const recovery = buildRecovery(customers, nowMs);
  const totalMrr = customers.reduce((sum, c) => sum + c.mrrCents, 0);

  // 1) Account + member. billing_exempt + processing_paused = the firewall flags
  //    (belt and suspenders alongside the demo_ id prefix).
  await db.insert(accounts).values({
    id: DEMO_ACCOUNT_ID,
    name: DEMO_ACCOUNT_NAME,
    currency: CURRENCY,
    createdAt: new Date(nowMs - 400 * DAY_MS),
    billingExempt: true,
    processingPaused: true,
    onboardingCompleted: true,
    theme: "dark",
    mrrEstimateCents: totalMrr,
    notificationEmail: DEMO_MEMBER_EMAIL,
    digestEmail: DEMO_MEMBER_EMAIL,
  });
  await db.insert(accountMembers).values({
    id: `${DEMO_ACCOUNT_ID}_member`,
    accountId: DEMO_ACCOUNT_ID,
    userId: DEMO_MEMBER_USER_ID,
    role: "owner",
    status: "active",
    createdAt: new Date(nowMs - 400 * DAY_MS),
  });

  // 2) Intelligence entitlement, via the real admin grant path (pure DB row,
  //    admin_granted, never Stripe), so the paid /intelligence surfaces render.
  await grantIntelligence(db, DEMO_ACCOUNT_ID, now);

  // 3) Customer portfolio + health history + predictions.
  const customerStmts: BatchItem<"sqlite">[] = [];
  const historyStmts: BatchItem<"sqlite">[] = [];
  const predictionStmts: BatchItem<"sqlite">[] = [];
  for (const c of customers) {
    const ctxId = `demo_ctx_${c.index}`;
    customerStmts.push(
      db.insert(customerContext).values({
        id: ctxId,
        accountId: DEMO_ACCOUNT_ID,
        stripeCustomerId: c.stripeCustomerId,
        customerEmail: c.email,
        customerName: c.name,
        customerSince: new Date(c.customerSinceMs),
        lastSeenAt: new Date(nowMs - intBetween(makePrng(c.index + 1), 0, 20) * DAY_MS),
        mrrContributionCents: c.mrrCents,
        ltvCents: c.mrrCents * 14,
        currency: CURRENCY,
        activeSubscriptionsCount: 1,
        currentPlanName: c.planName,
        currentPlanTier: c.planTier,
        healthScore: c.healthScore,
        healthScoreCalculatedAt: now,
        healthFactors: c.factors,
        aiAssessment: c.assessment,
        aiAssessmentGeneratedAt: c.assessment ? now : null,
        createdAt: new Date(c.customerSinceMs),
        updatedAt: now,
      }),
    );
    // A short health sparkline: 6 monthly points drifting toward the current score.
    for (let p = 5; p >= 0; p--) {
      const drift = Math.round((6 - p) * ((c.healthScore - 60) / 12));
      const score = Math.max(0, Math.min(100, 60 + drift));
      historyStmts.push(
        db.insert(healthScoreHistory).values({
          id: `demo_hsh_${c.index}_${p}`,
          accountId: DEMO_ACCOUNT_ID,
          customerContextId: ctxId,
          stripeCustomerId: c.stripeCustomerId,
          recordedAt: new Date(nowMs - p * 30 * DAY_MS),
          healthScore: p === 0 ? c.healthScore : score,
          healthFactors: c.factors,
          scoreSource: "deterministic_v1",
        }),
      );
    }
    if (c.healthScore < 70) {
      predictionStmts.push(
        db.insert(predictions).values({
          id: `demo_pred_${c.index}`,
          accountId: DEMO_ACCOUNT_ID,
          stripeCustomerId: c.stripeCustomerId,
          score: c.healthScore,
          bandEvidenceHash: `demo_${c.healthScore}`,
          horizonDays: 30,
          predictedAt: new Date(nowMs - 5 * DAY_MS),
          realizedOutcome: null,
        }),
      );
    }
  }
  await runBatched(db, customerStmts);
  await runBatched(db, historyStmts);
  await runBatched(db, predictionStmts);

  // 4) Recovery: failed payments + steps + recovered payments.
  const fpStmts: BatchItem<"sqlite">[] = [];
  const stepStmts: BatchItem<"sqlite">[] = [];
  const recoveredStmts: BatchItem<"sqlite">[] = [];
  const rand = makePrng(3266489917);
  for (const fp of recovery) {
    fpStmts.push(
      db.insert(failedPayments).values({
        id: fp.id,
        stripeEventId: `demo_evt_${fp.id}`,
        stripeInvoiceId: `demo_in_${fp.id}`,
        stripeCustomerId: fp.customer.stripeCustomerId,
        customerEmail: fp.customer.email,
        customerName: fp.customer.name,
        amountCents: fp.amountCents,
        currency: CURRENCY,
        declineCode: fp.decline.code,
        declineCategory: fp.decline.category,
        planName: fp.customer.planName,
        customerSince: new Date(fp.customer.customerSinceMs),
        status: fp.status,
        detectedAt: new Date(fp.detectedAtMs),
        resolvedAt: fp.status === "recovered" && fp.recovered ? new Date(fp.detectedAtMs + fp.recovered.offsetDays * DAY_MS) : null,
        cardBrand: pick(rand, CARD_BRANDS),
        customerLtvCents: fp.customer.mrrCents * 14,
        accountId: DEMO_ACCOUNT_ID,
        isRenewalNoise: false,
      }),
    );
    fp.steps.forEach((s, si) => {
      const scheduledAt = new Date(fp.detectedAtMs + s.offsetDays * DAY_MS);
      const executed = s.result !== null;
      stepStmts.push(
        db.insert(recoverySteps).values({
          id: `${fp.id}_step_${si}`,
          failedPaymentId: fp.id,
          stepType: s.type,
          stepNumber: si + 1,
          scheduledAt,
          executedAt: executed ? scheduledAt : null,
          result: s.result,
          aiSubject: s.type.startsWith("email") ? `A quick note about your ${fp.customer.planName} plan` : null,
          openedAt: s.opened ? new Date(scheduledAt.getTime() + 3600_000) : null,
          clickedAt: s.clicked ? new Date(scheduledAt.getTime() + 7200_000) : null,
          accountId: DEMO_ACCOUNT_ID,
          attemptCount: executed ? 1 : 0,
        }),
      );
    });
    if (fp.status === "recovered" && fp.recovered) {
      const recoveredAt = new Date(fp.detectedAtMs + fp.recovered.offsetDays * DAY_MS);
      recoveredStmts.push(
        db.insert(recoveredPayments).values({
          id: `${fp.id}_rec`,
          failedPaymentId: fp.id,
          recoveredAt,
          amountCents: fp.amountCents,
          currency: CURRENCY,
          recoveryMethod: fp.recovered.method,
          daysToRecover: fp.recovered.offsetDays,
          recoveryTrigger: fp.recovered.attribution,
          accountId: DEMO_ACCOUNT_ID,
          attributionKind: fp.recovered.attribution,
          attributedAt: recoveredAt,
        }),
      );
    }
  }
  await runBatched(db, fpStmts);
  await runBatched(db, stepStmts);
  await runBatched(db, recoveredStmts);

  // 5) Disputes across states, with evidence + approvals for the submitted ones.
  const disputeStates: { state: string; status: string }[] = [
    { state: "pending_review", status: "needs_response" },
    { state: "submitted", status: "under_review" },
    { state: "resolved_won", status: "won" },
    { state: "resolved_lost", status: "lost" },
    { state: "draft", status: "needs_response" },
    { state: "resolved_won", status: "won" },
  ];
  const disputeStmts: BatchItem<"sqlite">[] = [];
  const evidenceStmts: BatchItem<"sqlite">[] = [];
  const approvalStmts: BatchItem<"sqlite">[] = [];
  disputeStates.forEach((d, i) => {
    const customer = customers[i + 2];
    const amountCents = customer.mrrCents;
    const createdAtMs = nowMs - intBetween(rand, 2, 30) * DAY_MS;
    const submitted = d.state === "submitted" || d.state.startsWith("resolved");
    const won = d.state === "resolved_won";
    disputeStmts.push(
      db.insert(disputes).values({
        id: `demo_dp_${i}`,
        accountId: DEMO_ACCOUNT_ID,
        stripeDisputeId: `demo_dp_stripe_${i}`,
        stripeChargeId: `demo_ch_${i}`,
        stripeCustomerId: customer.stripeCustomerId,
        customerEmail: customer.email,
        customerName: customer.name,
        amountCents,
        currency: CURRENCY,
        reason: DISPUTE_REASONS[i % DISPUTE_REASONS.length],
        status: d.status,
        state: d.state,
        evidenceDeadline: new Date(createdAtMs + 12 * DAY_MS),
        submittedAt: submitted ? new Date(createdAtMs + 2 * DAY_MS) : null,
        resolvedAt: d.state.startsWith("resolved") ? new Date(createdAtMs + 20 * DAY_MS) : null,
        createdAt: new Date(createdAtMs),
        resolvedFeeCents: won ? Math.min(Math.round(amountCents * 0.2), 50000) : null,
        resolvedFeeCurrency: won ? CURRENCY : null,
        priorChargesCount: intBetween(rand, 3, 24),
        priorChargesTotal: amountCents * intBetween(rand, 3, 12),
      }),
    );
    if (d.state !== "draft") {
      evidenceStmts.push(
        db.insert(disputeEvidence).values({
          id: `demo_dpe_${i}_desc`,
          disputeId: `demo_dp_${i}`,
          accountId: DEMO_ACCOUNT_ID,
          fieldName: "product_description",
          fieldValue: `${customer.planName} plan, billed monthly. Active subscription with a clean payment history prior to this charge.`,
          createdAt: new Date(createdAtMs + DAY_MS),
        }),
      );
      evidenceStmts.push(
        db.insert(disputeEvidence).values({
          id: `demo_dpe_${i}_comm`,
          disputeId: `demo_dp_${i}`,
          accountId: DEMO_ACCOUNT_ID,
          fieldName: "customer_communication",
          fieldValue: "Customer opened two recovery emails and clicked the payment link before the dispute was filed.",
          createdAt: new Date(createdAtMs + DAY_MS),
        }),
      );
    }
    if (submitted) {
      approvalStmts.push(
        db.insert(disputeApprovals).values({
          id: `demo_dpa_${i}`,
          disputeId: `demo_dp_${i}`,
          accountId: DEMO_ACCOUNT_ID,
          approvedByEmail: DEMO_MEMBER_EMAIL,
          evidenceVersionHash: `demo_hash_${i}`,
          approvedAt: new Date(createdAtMs + 2 * DAY_MS),
        }),
      );
    }
  });
  await runBatched(db, disputeStmts);
  await runBatched(db, evidenceStmts);
  await runBatched(db, approvalStmts);

  // 6) Win-back sequences + steps (seeded so the surface renders; the real engine
  //    is a separate parity slice).
  const winbackStmts: BatchItem<"sqlite">[] = [];
  const winbackStatuses = ["active", "reactivated", "exhausted", "active", "resolved"];
  winbackStatuses.forEach((status, i) => {
    const customer = customers[20 + i];
    const seqId = `demo_wb_${i}`;
    const createdAtMs = nowMs - intBetween(rand, 3, 25) * DAY_MS;
    winbackStmts.push(
      db.insert(winBackSequences).values({
        id: seqId,
        stripeCustomerId: customer.stripeCustomerId,
        stripeSubscriptionId: `demo_sub_wb_${i}`,
        customerEmail: customer.email,
        customerName: customer.name,
        planName: customer.planName,
        amountCents: customer.mrrCents,
        currency: CURRENCY,
        cancelReason: "voluntary_cancellation",
        status,
        createdAt: new Date(createdAtMs),
        resolvedAt: status === "reactivated" || status === "resolved" || status === "exhausted" ? new Date(createdAtMs + 10 * DAY_MS) : null,
        reactivatedAt: status === "reactivated" ? new Date(createdAtMs + 8 * DAY_MS) : null,
        accountId: DEMO_ACCOUNT_ID,
      }),
    );
    for (let s = 0; s < 3; s++) {
      const scheduledAt = new Date(createdAtMs + [0, 4, 14][s] * DAY_MS);
      const executed = s === 0 || status !== "active";
      winbackStmts.push(
        db.insert(winBackSteps).values({
          id: `${seqId}_step_${s}`,
          winBackSequenceId: seqId,
          stepNumber: s + 1,
          scheduledAt,
          executedAt: executed ? scheduledAt : null,
          result: executed ? "email_sent" : null,
          accountId: DEMO_ACCOUNT_ID,
          attemptCount: executed ? 1 : 0,
        }),
      );
    }
  });
  await runBatched(db, winbackStmts);

  // 7) Expiring-card alerts.
  const expiringStmts: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < 8; i++) {
    const customer = customers[40 + i];
    const monthsAhead = intBetween(rand, 0, 2);
    const target = new Date(nowMs + monthsAhead * 30 * DAY_MS);
    expiringStmts.push(
      db.insert(expiringCardAlerts).values({
        id: `demo_exp_${i}`,
        stripeCustomerId: customer.stripeCustomerId,
        customerEmail: customer.email,
        customerName: customer.name,
        cardLast4: String(1000 + intBetween(rand, 0, 8999)),
        cardBrand: pick(rand, CARD_BRANDS),
        expiresMonth: target.getUTCMonth() + 1,
        expiresYear: target.getUTCFullYear(),
        alertSentAt: i % 2 === 0 ? new Date(nowMs - 2 * DAY_MS) : null,
        createdAt: new Date(nowMs - intBetween(rand, 1, 10) * DAY_MS),
        accountId: DEMO_ACCOUNT_ID,
      }),
    );
  }
  await runBatched(db, expiringStmts);

  // 8) MRR snapshots (12 months) for the dashboard + intelligence trend/waterfall.
  const mrrStmts: BatchItem<"sqlite">[] = [];
  for (let m = 11; m >= 0; m--) {
    const growth = Math.round(totalMrr * (1 - m * 0.012));
    mrrStmts.push(
      db.insert(mrrSnapshots).values({
        id: `demo_mrr_${m}`,
        accountId: DEMO_ACCOUNT_ID,
        snapshotDate: new Date(nowMs - m * 30 * DAY_MS),
        totalMrrCents: growth,
        newMrrCents: Math.round(growth * 0.04),
        expansionMrrCents: Math.round(growth * 0.02),
        contractionMrrCents: Math.round(growth * 0.01),
        churnMrrCents: Math.round(growth * 0.015),
        reactivationMrrCents: Math.round(growth * 0.005),
        activeCustomersCount: TOTAL_CUSTOMERS - m,
        newCustomersCount: intBetween(rand, 3, 9),
        churnedCustomersCount: intBetween(rand, 1, 4),
        perPlanBreakdown: {},
        perCohortBreakdown: {},
        perChannelBreakdown: {},
        voluntaryChurnRateBps: 120,
        involuntaryChurnRateBps: 60,
        netRevenueRetentionBps: 9993,
        grossRevenueRetentionBps: 9820,
        currency: CURRENCY,
        createdAt: new Date(nowMs - m * 30 * DAY_MS),
      }),
    );
  }
  await runBatched(db, mrrStmts);

  // 9) Intelligence report narrative (pre-written, NEVER an AI call).
  await db.insert(intelligenceReports).values({
    id: "demo_report_0",
    accountId: DEMO_ACCOUNT_ID,
    reportMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    narrative: DEMO_NARRATIVE,
    generatedAt: now,
  });

  // 10) Alerts + a couple of firings, so /intelligence/alerts is not empty.
  await db.insert(alerts).values([
    { id: "demo_alert_0", accountId: DEMO_ACCOUNT_ID, metric: "mrr_at_risk_cents", thresholdValue: 200000, direction: "above", channel: "email", label: "MRR at risk over $2,000", enabled: true, createdAt: new Date(nowMs - 30 * DAY_MS) },
    { id: "demo_alert_1", accountId: DEMO_ACCOUNT_ID, metric: "high_risk_customer_count", thresholdValue: 3, direction: "above", channel: "email", label: "More than 3 high-risk customers", enabled: true, createdAt: new Date(nowMs - 30 * DAY_MS) },
  ]);
  await db.insert(alertHistory).values({
    id: "demo_alert_hist_0",
    alertId: "demo_alert_0",
    accountId: DEMO_ACCOUNT_ID,
    metric: "mrr_at_risk_cents",
    thresholdValue: 200000,
    direction: "above",
    actualValue: 247300,
    channel: "email",
    firedAt: new Date(nowMs - 3 * DAY_MS),
    notificationSent: true,
  });

  // 11) Billing ledger: one finalized invoice with real evidence-linked line items,
  //     so /billing renders a believable ledger (the demo account is firewalled out
  //     of the live billing run, so this is seeded directly).
  const wonDispute = "demo_dp_2";
  const firstRecovered = recovery.find((r) => r.status === "recovered");
  await db.insert(billingInvoices).values({
    id: "demo_inv_0",
    accountId: DEMO_ACCOUNT_ID,
    currency: CURRENCY,
    periodStart: new Date(nowMs - 30 * DAY_MS),
    periodEnd: new Date(nowMs),
    status: "paid",
    totalCents: 0,
    idempotencyKey: `demo_inv_0_${DEMO_ACCOUNT_ID}`,
    createdAt: new Date(nowMs - 2 * DAY_MS),
    finalizedAt: new Date(nowMs - 2 * DAY_MS),
  });
  const lineItems: BatchItem<"sqlite">[] = [];
  let invoiceTotal = 0;
  if (firstRecovered) {
    const fee = Math.round(firstRecovered.amountCents * 0.2);
    invoiceTotal += fee;
    lineItems.push(
      db.insert(billingLineItems).values({
        id: "demo_li_recovery",
        invoiceId: "demo_inv_0",
        accountId: DEMO_ACCOUNT_ID,
        type: "recovery_fee",
        currency: CURRENCY,
        amountCents: fee,
        feeCents: fee,
        recoveredPaymentId: `${firstRecovered.id}_rec`,
        description: "20% of a recovered payment",
        createdAt: new Date(nowMs - 2 * DAY_MS),
      }),
    );
  }
  const wonFee = Math.min(Math.round(customers[4].mrrCents * 0.2), 50000);
  invoiceTotal += wonFee;
  lineItems.push(
    db.insert(billingLineItems).values({
      id: "demo_li_dispute",
      invoiceId: "demo_inv_0",
      accountId: DEMO_ACCOUNT_ID,
      type: "dispute_fee",
      currency: CURRENCY,
      amountCents: wonFee,
      feeCents: wonFee,
      disputeId: wonDispute,
      description: "20% of a won dispute (capped at $500)",
      createdAt: new Date(nowMs - 2 * DAY_MS),
    }),
  );
  await runBatched(db, lineItems);
  await db.update(billingInvoices).set({ totalCents: invoiceTotal }).where(eq(billingInvoices.id, "demo_inv_0"));
}
