import type Stripe from "stripe";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, isNull, notLike } from "drizzle-orm";

import {
  accounts,
  customerContext,
  disputes,
  engagementEvents,
  failedPayments,
  getDb,
  mrrSnapshots,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
  type Db,
} from "~/db";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  INTELLIGENCE_MAX_CHARGES_PER_CUSTOMER,
  INTELLIGENCE_MAX_CUSTOMERS_SCANNED,
  INTELLIGENCE_MAX_INVOICES_PER_CUSTOMER,
} from "~/lib/constants";
import { decryptToken } from "~/lib/stripe/encryption";
import { getConnectedStripe } from "~/lib/stripe/client";
import {
  buildCustomerContextFields,
  monthlyEquivalentCents,
  type ActiveSubscriptionSnapshot,
  type BillingInterval,
  type CustomerContextFields,
  type DisputeSignalRow,
  type EngagementSignalRow,
  type InvoicePaymentObservation,
  type RawBillingLineObservation,
  type RecoverySignalRow,
} from "./signals";
import { buildMrrSnapshotFields, type ChurnReason, type CustomerMrrPoint } from "./mrr";

// The live Stripe + D1 seam for the Intelligence deterministic engine
// (TASK-foxhound-intelligence-deterministic.md's "key architectural fact":
// there is no subscription/customer store, so this is the ONE enumeration
// that feeds both customer_context (universal per-customer signals) and
// mrr_snapshots (the account-wide free MRR tier), read once per account per
// run rather than hitting Stripe twice. Like card-update's
// createCardUpdateSession, this typechecks and is built for real but needs a live Stripe test-mode
// connected account to exercise; that is Phase 8, not this pass. The pure
// math it calls into (signals.ts, mrr.ts) is what carries the unit-test load.
//
// customer_context / mrr_snapshots writes are operational, not money
// (gotcha #25: only recovered_payments + outcomes ride the per-account
// money-write DO), so everything here is a plain db.batch()/insert() via
// getDb, never executeMoneyWrite.

function monthKeyUTC(when: Date): string {
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The account's Stripe connection to read from. Mirrors the established
 *  precedent (app/routes/app/settings/index.tsx): the earliest-connected
 *  still-active connection, since nothing here has a per-row hint (unlike
 *  card-update.tsx's resolveConnectionForFailedPayment) to disambiguate an
 *  account with more than one active connection (gotcha #22). */
async function resolveAccountConnection(
  db: Db,
  accountId: string,
): Promise<{ id: string; stripeAccessToken: string | null } | null> {
  const rows = await db
    .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)))
    .orderBy(stripeConnections.connectedAt)
    .limit(1);
  return rows[0] ?? null;
}

function priceInterval(price: Stripe.Price | null | undefined): BillingInterval {
  const interval = price?.recurring?.interval;
  return interval === "day" || interval === "week" || interval === "month" || interval === "year"
    ? interval
    : "month";
}

function productName(product: Stripe.Price["product"] | undefined): string | null {
  if (!product || typeof product === "string") return null;
  if ("deleted" in product && product.deleted) return null;
  return (product as Stripe.Product).name ?? null;
}

function subscriptionCancellationChurnReason(sub: Stripe.Subscription): ChurnReason {
  const reason = sub.cancellation_details?.reason;
  if (!reason) return null;
  return reason === "payment_failed" || reason === "payment_disputed" ? "involuntary" : "voluntary";
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

interface CustomerStripeSnapshot {
  activeSubscriptions: ActiveSubscriptionSnapshot[];
  billingHistory: RawBillingLineObservation[];
  invoiceHistory: InvoicePaymentObservation[];
  refundCount: number;
  disputeCount: number;
  churnReason: ChurnReason;
}

/** Reads one customer's subscriptions, invoices, and charges from the
 *  connected account and normalizes them into the shapes signals.ts derives
 *  from. Bounded per customer (INTELLIGENCE_MAX_INVOICES_PER_CUSTOMER /
 *  INTELLIGENCE_MAX_CHARGES_PER_CUSTOMER), mirroring the audit's bounded-scan
 *  discipline. */
async function fetchCustomerStripeSnapshot(
  stripe: Stripe,
  stripeCustomerId: string,
): Promise<CustomerStripeSnapshot> {
  const activeSubscriptions: ActiveSubscriptionSnapshot[] = [];
  // Raw, uncollapsed lines: a multi-item subscription or a multi-line invoice
  // pushes more than one entry at the SAME timestamp here on purpose.
  // buildCustomerContextFields (signals.ts) collapses same-instant lines down
  // to one representative observation before diffing, so this seam only has
  // to report every line honestly, not pre-guess which one "matters".
  const billingHistory: RawBillingLineObservation[] = [];
  let churnReason: ChurnReason = null;

  for await (const sub of stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price.product"],
  })) {
    for (const item of sub.items.data) {
      const interval = priceInterval(item.price);
      const quantity = item.quantity ?? 1;
      const unitAmountCents = item.price.unit_amount ?? 0;
      if (ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
        activeSubscriptions.push({
          priceId: item.price.id,
          productName: productName(item.price.product),
          quantity,
          interval,
          unitAmountCents,
        });
      }
      billingHistory.push({
        at: sub.created * 1000,
        priceId: item.price.id,
        quantity,
        interval,
        // Ranking signal only (collapseBillingObservations): the item with
        // the largest monthly-equivalent amount represents this instant, the
        // same rule summarizeActiveSubscriptions uses for "current plan".
        valueCents: monthlyEquivalentCents(unitAmountCents, quantity, interval),
      });
    }
    if (sub.status === "canceled") {
      const reason = subscriptionCancellationChurnReason(sub);
      if (reason) churnReason = reason;
    }
  }

  const invoiceHistory: InvoicePaymentObservation[] = [];
  let invoicesScanned = 0;
  for await (const invoice of stripe.invoices.list({
    customer: stripeCustomerId,
    limit: 100,
    expand: ["data.lines.data.pricing.price_details.price"],
  })) {
    invoicesScanned += 1;
    if (invoicesScanned > INTELLIGENCE_MAX_INVOICES_PER_CUSTOMER) break;
    invoiceHistory.push({
      dueAt: invoice.due_date ? invoice.due_date * 1000 : null,
      paidAt: invoice.status_transitions?.paid_at ? invoice.status_transitions.paid_at * 1000 : null,
    });
    for (const line of invoice.lines.data) {
      const priceDetails = line.pricing?.price_details;
      if (!priceDetails) continue;
      const price = typeof priceDetails.price === "string" ? null : priceDetails.price;
      const priceId = typeof priceDetails.price === "string" ? priceDetails.price : priceDetails.price.id;
      billingHistory.push({
        at: invoice.created * 1000,
        priceId,
        quantity: line.quantity ?? 1,
        interval: priceInterval(price),
        // The line's own signed amount (negative for a proration credit), so
        // an upgrade invoice's real new-plan charge always outranks the
        // credit line it arrives alongside.
        valueCents: line.amount,
      });
    }
  }

  let refundCount = 0;
  let disputeCount = 0;
  let chargesScanned = 0;
  for await (const charge of stripe.charges.list({ customer: stripeCustomerId, limit: 100 })) {
    chargesScanned += 1;
    if (chargesScanned > INTELLIGENCE_MAX_CHARGES_PER_CUSTOMER) break;
    if (charge.refunded) refundCount += 1;
    if (charge.disputed) disputeCount += 1;
  }

  return { activeSubscriptions, billingHistory, invoiceHistory, refundCount, disputeCount, churnReason };
}

/** Foxhound's own account-scoped recovery/dispute/engagement history, read
 *  once per run and grouped by stripeCustomerId in memory (avoids an N+1 query
 *  per Stripe customer). SCHEMA.md: "Engagement signals read from
 *  engagement_events aggregates, not denormalized counters." */
async function fetchFoxhoundHistoryByCustomer(db: Db, accountId: string) {
  const [recoveryRows, disputeRows, engagementRows] = await Promise.all([
    db
      .select({
        stripeCustomerId: failedPayments.stripeCustomerId,
        status: failedPayments.status,
        daysToRecover: recoveredPayments.daysToRecover,
      })
      .from(failedPayments)
      .leftJoin(recoveredPayments, eq(recoveredPayments.failedPaymentId, failedPayments.id))
      .where(and(eq(failedPayments.accountId, accountId), isNull(failedPayments.deletedAt))),
    db
      .select({ stripeCustomerId: disputes.stripeCustomerId, state: disputes.state })
      .from(disputes)
      .where(eq(disputes.accountId, accountId)),
    db
      .select({
        stripeCustomerId: failedPayments.stripeCustomerId,
        eventType: engagementEvents.eventType,
        occurredAt: engagementEvents.occurredAt,
      })
      .from(engagementEvents)
      .innerJoin(recoverySteps, eq(recoverySteps.id, engagementEvents.recoveryStepId))
      .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
      .where(eq(engagementEvents.accountId, accountId)),
  ]);

  const byCustomer = <T>(): Map<string, T[]> => new Map<string, T[]>();
  const recovery = byCustomer<RecoverySignalRow>();
  for (const r of recoveryRows) {
    const list = recovery.get(r.stripeCustomerId) ?? [];
    list.push({ status: r.status, daysToRecover: r.daysToRecover });
    recovery.set(r.stripeCustomerId, list);
  }
  const dispute = byCustomer<DisputeSignalRow>();
  for (const d of disputeRows) {
    if (!d.stripeCustomerId) continue;
    const list = dispute.get(d.stripeCustomerId) ?? [];
    list.push({ state: d.state });
    dispute.set(d.stripeCustomerId, list);
  }
  const engagement = byCustomer<EngagementSignalRow>();
  for (const e of engagementRows) {
    const list = engagement.get(e.stripeCustomerId) ?? [];
    list.push({ eventType: e.eventType, occurredAt: e.occurredAt.getTime() });
    engagement.set(e.stripeCustomerId, list);
  }
  return { recovery, dispute, engagement };
}

function buildCustomerContextUpsert(
  db: Db,
  input: {
    accountId: string;
    stripeCustomerId: string;
    customerEmail: string | null;
    customerName: string | null;
    customerSince: Date;
    now: Date;
    fields: CustomerContextFields;
  },
): BatchItem<"sqlite"> {
  const { fields } = input;
  const shared = {
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    customerSince: input.customerSince,
    lastSeenAt: input.now,
    mrrContributionCents: fields.mrrContributionCents,
    activeSubscriptionsCount: fields.activeSubscriptionsCount,
    currentPlanName: fields.currentPlanName,
    recoverySignals: fields.recoverySignals,
    disputeSignals: fields.disputeSignals,
    engagementSignals: fields.engagementSignals,
    subscriptionAgeDays: fields.subscriptionAgeDays,
    planChangeCount: fields.planChangeCount,
    seatChangeCount: fields.seatChangeCount,
    intervalSwitchCount: fields.intervalSwitchCount,
    paymentLatencyDriftDays: fields.paymentLatencyDriftDays,
    refundCount: fields.refundCount,
    disputeCount: fields.disputeCount,
    updatedAt: input.now,
  };
  // onConflictDoUpdate's `set` deliberately omits healthScore / healthFactors /
  // aiAssessment / aiAssessmentGeneratedAt / aiRecommendedActions /
  // currentPlanTier, so a re-run of this deterministic sync never clobbers
  // whatever the separate AI half (or a future tier taxonomy) has written.
  // currency and ltvCents are omitted too: honest unknowns this slice has no
  // source for, not fields something else is expected to fill in later (see
  // buildCustomerContextFields's doc comment in signals.ts).
  return db
    .insert(customerContext)
    .values({
      accountId: input.accountId,
      stripeCustomerId: input.stripeCustomerId,
      createdAt: input.now,
      ...shared,
    })
    .onConflictDoUpdate({
      target: [customerContext.accountId, customerContext.stripeCustomerId],
      set: shared,
    });
}

export interface AccountSyncResult {
  accountId: string;
  customersProcessed: number;
  snapshotWritten: boolean;
  /** True when this run hit INTELLIGENCE_MAX_CUSTOMERS_SCANNED and stopped
   *  before the connected account's customer list was exhausted. There is no
   *  cross-run resumption cursor (that would need persisted per-account state:
   *  a schema column, out of scope for this slice, or a KV entry, a bigger
   *  change than this pass warrants for a pre-launch account base). Stripe's
   *  default list order is newest-first, so a truncated account rescans the
   *  same customers every run; this flag is how that becomes visible in
   *  cron_run_history instead of silently under-covering the account forever. */
  truncated: boolean;
}

/** Runs the deterministic Intelligence sync for one account: enumerates every
 *  Stripe customer, upserts its customer_context row, and writes one
 *  mrr_snapshots row for the run. A no-op (customersProcessed: 0,
 *  snapshotWritten: false) when the account has no active Stripe connection
 *  yet, never an error. */
export async function runIntelligenceSyncForAccount(
  env: Env,
  accountId: string,
  nowMs: number,
): Promise<AccountSyncResult> {
  const db = getDb(env);
  const connection = await resolveAccountConnection(db, accountId);
  if (!connection?.stripeAccessToken) {
    return { accountId, customersProcessed: 0, snapshotWritten: false, truncated: false };
  }

  const [account] = await db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const currency = account?.currency ?? "usd";

  const accessToken = await decryptToken(env, connection.stripeAccessToken);
  const stripe = getConnectedStripe(accessToken);

  const [priorSnapshotRows, priorContextRows, history] = await Promise.all([
    db.select({ id: mrrSnapshots.id }).from(mrrSnapshots).where(eq(mrrSnapshots.accountId, accountId)).limit(1),
    db
      .select({
        stripeCustomerId: customerContext.stripeCustomerId,
        mrrContributionCents: customerContext.mrrContributionCents,
      })
      .from(customerContext)
      .where(eq(customerContext.accountId, accountId)),
    fetchFoxhoundHistoryByCustomer(db, accountId),
  ]);
  const hasPriorSnapshot = priorSnapshotRows.length > 0;
  const priorByCustomer = hasPriorSnapshot
    ? new Map(priorContextRows.map((r) => [r.stripeCustomerId, r.mrrContributionCents ?? 0]))
    : null;

  const now = new Date(nowMs);
  const currentPoints: CustomerMrrPoint[] = [];
  const upserts: BatchItem<"sqlite">[] = [];
  let scanned = 0;
  let truncated = false;

  for await (const customer of stripe.customers.list({ limit: 100 })) {
    scanned += 1;
    if (scanned > INTELLIGENCE_MAX_CUSTOMERS_SCANNED) {
      truncated = true;
      break;
    }
    if (customer.deleted) continue;

    const snapshot = await fetchCustomerStripeSnapshot(stripe, customer.id);
    const customerSinceMs = customer.created * 1000;
    const fields = buildCustomerContextFields({
      customerSinceMs,
      nowMs,
      activeSubscriptions: snapshot.activeSubscriptions,
      billingHistory: snapshot.billingHistory,
      invoiceHistory: snapshot.invoiceHistory,
      refundCount: snapshot.refundCount,
      disputeCount: snapshot.disputeCount,
      recoveryRows: history.recovery.get(customer.id) ?? [],
      disputeRows: history.dispute.get(customer.id) ?? [],
      engagementRows: history.engagement.get(customer.id) ?? [],
    });

    currentPoints.push({
      stripeCustomerId: customer.id,
      mrrCents: fields.mrrContributionCents,
      planName: fields.currentPlanName,
      cohortKey: monthKeyUTC(new Date(customerSinceMs)),
      churnReason: snapshot.churnReason,
    });

    upserts.push(
      buildCustomerContextUpsert(db, {
        accountId,
        stripeCustomerId: customer.id,
        customerEmail: customer.email ?? null,
        customerName: customer.name ?? null,
        customerSince: new Date(customerSinceMs),
        now,
        fields,
      }),
    );
  }

  if (upserts.length > 0) {
    await db.batch([upserts[0], ...upserts.slice(1)]);
  }

  // Nothing to snapshot: no customers now and no prior snapshot to compare
  // against would just record an all-zero row with no future trend value.
  if (currentPoints.length === 0 && !hasPriorSnapshot) {
    return { accountId, customersProcessed: 0, snapshotWritten: false, truncated };
  }

  const snapshotFields = buildMrrSnapshotFields(priorByCustomer, currentPoints);
  await db.insert(mrrSnapshots).values({
    accountId,
    snapshotDate: now,
    currency,
    totalMrrCents: snapshotFields.totalMrrCents,
    newMrrCents: snapshotFields.newMrrCents,
    expansionMrrCents: snapshotFields.expansionMrrCents,
    contractionMrrCents: snapshotFields.contractionMrrCents,
    churnMrrCents: snapshotFields.churnMrrCents,
    reactivationMrrCents: snapshotFields.reactivationMrrCents,
    activeCustomersCount: snapshotFields.activeCustomersCount,
    newCustomersCount: snapshotFields.newCustomersCount,
    churnedCustomersCount: snapshotFields.churnedCustomersCount,
    perPlanBreakdown: snapshotFields.perPlanBreakdown,
    perCohortBreakdown: snapshotFields.perCohortBreakdown,
    perChannelBreakdown: snapshotFields.perChannelBreakdown,
    voluntaryChurnRateBps: snapshotFields.voluntaryChurnRateBps,
    involuntaryChurnRateBps: snapshotFields.involuntaryChurnRateBps,
    netRevenueRetentionBps: snapshotFields.netRevenueRetentionBps,
    grossRevenueRetentionBps: snapshotFields.grossRevenueRetentionBps,
    createdAt: now,
  });

  // Recova's compute-daily-metrics wrote accounts.mrr_estimate nightly from the
  // active subscriptions, normalized to a month; this total is the same
  // measure. A truncated scan would understate it, so it is left as it was.
  if (!truncated) {
    await db
      .update(accounts)
      .set({ mrrEstimateCents: snapshotFields.totalMrrCents })
      .where(eq(accounts.id, accountId));
  }

  return { accountId, customersProcessed: currentPoints.length, snapshotWritten: true, truncated };
}

/** Account-level gate for Intelligence sync: respects processing_paused and
 *  cancelledAt (admin Pass 2), and excludes demo accounts (ARCHITECTURE.md
 *  non-negotiable #7: "demo accounts excluded from all processing"). Deliberately
 *  does not gate on billing_exempt: the free MRR tier is not a billing action,
 *  so a billing-exempt account still gets its own analytics. Exported so its SQL
 *  shape is directly testable, mirroring recovery-tick.ts's
 *  accountProcessingEligibleCondition. */
export function accountProcessingEligible() {
  return and(
    eq(accounts.processingPaused, false),
    isNull(accounts.cancelledAt),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  );
}

/** The full sync run: every processing-eligible account. Mirrors
 *  runMonthlyBilling's per-account try/catch-continue (one account's failure
 *  never aborts the rest). This is the Phase-4e-style Cron Trigger entry point
 *  (app/lib/cron/registry.ts). */
export async function runIntelligenceSyncForAllAccounts(
  env: Env,
  nowMs: number,
): Promise<AccountSyncResult[]> {
  const db = getDb(env);
  const eligible = await db.select({ id: accounts.id }).from(accounts).where(accountProcessingEligible());

  const results: AccountSyncResult[] = [];
  for (const { id } of eligible) {
    try {
      results.push(await runIntelligenceSyncForAccount(env, id, nowMs));
    } catch (err) {
      results.push({ accountId: id, customersProcessed: 0, snapshotWritten: false, truncated: false });
      console.error(`intelligence sync failed for account ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
