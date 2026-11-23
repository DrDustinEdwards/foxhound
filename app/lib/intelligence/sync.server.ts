import type Stripe from "stripe";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, isNull, notLike, sql } from "drizzle-orm";

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
  type Db,
} from "~/db";
import {
  DAY_MS,
  DEMO_ACCOUNT_ID_PREFIX,
  INTELLIGENCE_MAX_CHARGES_PER_CUSTOMER,
  INTELLIGENCE_MAX_CUSTOMERS_SCANNED,
  INTELLIGENCE_MAX_INVOICES_PER_CUSTOMER,
} from "~/lib/constants";
import { monthKey } from "@dustinedwards/site-runtime/time";
import { decryptToken } from "~/lib/stripe/encryption";
import { getConnectedStripe } from "~/lib/stripe/client";
import { findActiveConnection } from "~/lib/stripe/connections.server";
import { asId } from "~/lib/stripe/ids";
import { collectPaginated } from "~/lib/stripe/reads";
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
import {
  buildMrrSnapshotFields,
  churnReasonOf,
  type ChurnReason,
  type CustomerMrrPoint,
} from "./mrr";
import {
  discountedItemCents,
  earliestScheduledChange,
  nextScheduledChange,
  type CouponTerms,
  type DiscountTerms,
  type ItemTerms,
  type ScheduledChange,
  type ScheduleTerms,
} from "./subscription-terms";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import { stripeMs } from "~/lib/stripe/time";

// The live Stripe + D1 seam for the deterministic Intelligence engine: one enumeration per account per run
// feeds both customer_context (per-customer signals) and mrr_snapshots (the free MRR tier), so Stripe is read
// once. Needs a live Stripe test-mode account to exercise; the pure math (signals.ts, mrr.ts) carries the unit
// tests. These writes are operational, not money (only recovered_payments + outcomes ride the money DO), so
// plain db.batch()/insert() via getDb.

function priceInterval(price: Stripe.Price | null | undefined): BillingInterval {
  // The SDK types Stripe's enums as open, so equality does not narrow them: each known value is returned by name.
  switch (price?.recurring?.interval) {
    case "day":
      return "day";
    case "week":
      return "week";
    case "year":
      return "year";
    default:
      return "month";
  }
}

function productName(product: Stripe.Price["product"] | undefined): string | null {
  if (!product || typeof product === "string") return null;
  if ("deleted" in product && product.deleted) return null;
  return (product as Stripe.Product).name ?? null;
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

interface CustomerStripeSnapshot {
  activeSubscriptions: ActiveSubscriptionSnapshot[];
  billingHistory: RawBillingLineObservation[];
  invoiceHistory: InvoicePaymentObservation[];
  refundCount: number;
  disputeCount: number;
  churnReason: ChurnReason;
  /** The earliest planned change or cancellation across the customer's live subscriptions; null when none. */
  scheduledChange: ScheduledChange | null;
}

/** A subscription or item discount as read off Stripe: its coupon and when a repeating one ends. */
interface RawDiscount {
  couponId: string;
  embedded: Stripe.Coupon | null;
  endMs: number | null;
}

interface NarrowSubscriptionItem {
  priceId: string;
  productId: string | null;
  productName: string | null;
  unitAmountCents: number;
  quantity: number;
  interval: BillingInterval;
  intervalCount: number;
  discounts: RawDiscount[];
}

/** A subscription cut down to what the sync reads, as each page arrives, so expanded subscriptions are
 *  never held whole (the Worker's 128 MB). */
interface NarrowSubscription {
  status: Stripe.Subscription.Status;
  createdMs: number;
  currency: string;
  churnReason: ChurnReason;
  cancelAtMs: number | null;
  items: NarrowSubscriptionItem[];
  discounts: RawDiscount[];
  schedule: ScheduleTerms | null;
}

function narrowDiscounts(
  discounts: readonly (string | Stripe.Discount)[] | null | undefined,
): RawDiscount[] {
  const out: RawDiscount[] = [];
  for (const d of discounts ?? []) {
    if (typeof d === "string") continue;
    const coupon = d.source?.coupon;
    if (!coupon) continue;
    out.push({
      couponId: typeof coupon === "string" ? coupon : coupon.id,
      embedded: typeof coupon === "string" ? null : coupon,
      endMs: stripeMs(d.end),
    });
  }
  return out;
}

/** A schedule phase's billing terms as one comparable key (see subscription-terms.ts nextScheduledChange). */
function phaseBillingKey(phase: Stripe.SubscriptionSchedule.Phase): string {
  const items = phase.items.map((i) => `${asId(i.price) ?? ""}x${i.quantity ?? 1}`).sort();
  const discounts = phase.discounts
    .map((d) => asId(d.coupon) || asId(d.discount) || asId(d.promotion_code) || "")
    .sort();
  return `${items.join(",")}|${discounts.join(",")}`;
}

function narrowSchedule(schedule: Stripe.Subscription["schedule"]): ScheduleTerms | null {
  if (!schedule || typeof schedule === "string") return null;
  return {
    status: schedule.status,
    endBehavior: schedule.end_behavior,
    phases: schedule.phases.map((p) => ({
      startMs: stripeMs(p.start_date),
      endMs: stripeMs(p.end_date),
      billingKey: phaseBillingKey(p),
    })),
  };
}

function narrowSubscriptionForSync(sub: Stripe.Subscription): NarrowSubscription {
  return {
    status: sub.status,
    createdMs: stripeMs(sub.created),
    currency: sub.currency,
    churnReason: sub.status === "canceled" ? churnReasonOf(sub.cancellation_details?.reason) : null,
    cancelAtMs: stripeMs(sub.cancel_at),
    items: sub.items.data.map((item) => ({
      priceId: item.price.id,
      productId: asId(item.price.product) || null,
      productName: productName(item.price.product),
      unitAmountCents: item.price.unit_amount ?? 0,
      quantity: item.quantity ?? 1,
      interval: priceInterval(item.price),
      intervalCount: Math.max(1, item.price.recurring?.interval_count ?? 1),
      discounts: narrowDiscounts(item.discounts),
    })),
    discounts: narrowDiscounts(sub.discounts),
    schedule: narrowSchedule(sub.schedule),
  };
}

/** Coupons read once per sync run and shared across customers. Retrieved with applies_to and
 *  currency_options (Stripe includes them only on request). A coupon that cannot be retrieved (a deleted
 *  coupon still discounts its subscriptions) falls back to the embedded object. */
type CouponCache = Map<string, Promise<Stripe.Coupon | null>>;

function couponTermsIn(coupon: Stripe.Coupon, currency: string): CouponTerms {
  const amountOffCents =
    coupon.amount_off === null
      ? null
      : coupon.currency === currency
        ? coupon.amount_off
        : (coupon.currency_options?.[currency]?.amount_off ?? null);
  return {
    percentOff: coupon.percent_off,
    amountOffCents,
    // Anything but once or repeating counts as forever, as recurs() in subscription-terms.ts reads it.
    duration:
      coupon.duration === "once"
        ? "once"
        : coupon.duration === "repeating"
          ? "repeating"
          : "forever",
    appliesToProducts: coupon.applies_to?.products ?? null,
  };
}

async function resolveDiscounts(
  stripe: Stripe,
  cache: CouponCache,
  discounts: readonly RawDiscount[],
  currency: string,
): Promise<DiscountTerms[]> {
  const out: DiscountTerms[] = [];
  for (const d of discounts) {
    let pending = cache.get(d.couponId);
    if (!pending) {
      pending = stripe.coupons
        .retrieve(d.couponId, { expand: ["applies_to", "currency_options"] })
        .catch(() => null);
      cache.set(d.couponId, pending);
    }
    const coupon = (await pending) ?? d.embedded;
    if (coupon) out.push({ coupon: couponTermsIn(coupon, currency), endMs: d.endMs });
  }
  return out;
}

/** Reads one customer's subscriptions, invoices and charges from the connected account into the shapes
 *  signals.ts derives from. Bounded per customer (INTELLIGENCE_MAX_INVOICES/CHARGES_PER_CUSTOMER). */
async function fetchCustomerStripeSnapshot(
  stripe: Stripe,
  stripeCustomerId: string,
  coupons: CouponCache,
  nowMs: number,
): Promise<CustomerStripeSnapshot> {
  const activeSubscriptions: ActiveSubscriptionSnapshot[] = [];
  // Raw, uncollapsed lines: simultaneous lines are pushed on purpose; buildCustomerContextFields collapses
  // same-instant lines before diffing.
  const billingHistory: RawBillingLineObservation[] = [];
  let churnReason: ChurnReason = null;
  const scheduled: (ScheduledChange | null)[] = [];

  // Discounts and the schedule are expanded so MRR is what the customer pays after coupons; each path stays
  // within Stripe's four-level expansion limit.
  const subscriptions = await collectPaginated(
    stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 100,
      expand: [
        "data.items.data.price.product",
        "data.discounts",
        "data.items.data.discounts",
        "data.schedule",
      ],
    }),
    narrowSubscriptionForSync,
  );

  for (const sub of subscriptions) {
    const active = ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status);
    const subDiscounts = await resolveDiscounts(stripe, coupons, sub.discounts, sub.currency);
    const itemTerms: ItemTerms[] = [];
    for (const item of sub.items) {
      itemTerms.push({
        productId: item.productId,
        unitAmountCents: item.unitAmountCents,
        quantity: item.quantity,
        discounts: await resolveDiscounts(stripe, coupons, item.discounts, sub.currency),
      });
    }
    const periodCents = discountedItemCents(itemTerms, subDiscounts, nowMs);

    sub.items.forEach((item, i) => {
      // One unit's cost per billing period after discounts; monthlyEquivalentCents spreads it over interval_count.
      const unitAmountCents = item.quantity > 0 ? periodCents[i] / item.quantity : 0;
      if (active) {
        activeSubscriptions.push({
          priceId: item.priceId,
          productName: item.productName,
          quantity: item.quantity,
          interval: item.interval,
          intervalCount: item.intervalCount,
          unitAmountCents,
        });
      }
      billingHistory.push({
        at: sub.createdMs,
        priceId: item.priceId,
        quantity: item.quantity,
        interval: item.interval,
        // Ranking signal only (collapseBillingObservations): the largest monthly-equivalent item represents this instant.
        valueCents: monthlyEquivalentCents(
          unitAmountCents,
          item.quantity,
          item.interval,
          item.intervalCount,
        ),
      });
    });
    if (sub.churnReason) churnReason = sub.churnReason;
    if (active) {
      if (sub.schedule) scheduled.push(nextScheduledChange(sub.schedule, nowMs));
      if (sub.cancelAtMs !== null && sub.cancelAtMs > nowMs)
        scheduled.push({ kind: "cancel", atMs: sub.cancelAtMs });
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
      dueAt: stripeMs(invoice.due_date),
      paidAt: stripeMs(invoice.status_transitions?.paid_at),
    });
    for (const line of invoice.lines.data) {
      const priceDetails = line.pricing?.price_details;
      if (!priceDetails) continue;
      const price = typeof priceDetails.price === "string" ? null : priceDetails.price;
      const priceId =
        typeof priceDetails.price === "string" ? priceDetails.price : priceDetails.price.id;
      billingHistory.push({
        at: stripeMs(invoice.created),
        priceId,
        quantity: line.quantity ?? 1,
        interval: priceInterval(price),
        // The line's own signed amount (negative for a proration credit), so an upgrade's new-plan charge outranks its credit.
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

  return {
    activeSubscriptions,
    billingHistory,
    invoiceHistory,
    refundCount,
    disputeCount,
    churnReason,
    scheduledChange: earliestScheduledChange(scheduled),
  };
}

/** Foxhound's own recovery/dispute/engagement history, read once per run and grouped by stripeCustomerId
 *  in memory (avoids an N+1 query per customer). */
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
    scheduledChange: ScheduledChange | null;
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
    scheduledChangeKind: input.scheduledChange?.kind ?? null,
    scheduledChangeAt: input.scheduledChange ? new Date(input.scheduledChange.atMs) : null,
    updatedAt: input.now,
  };
  // onConflictDoUpdate's `set` omits healthScore / healthFactors / aiAssessment / aiAssessmentGeneratedAt /
  // aiRecommendedActions / currentPlanTier so a re-run never clobbers what the AI half wrote; currency and
  // ltvCents are omitted because nothing sources them (see signals.ts buildCustomerContextFields).
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
  /** True when this run hit INTELLIGENCE_MAX_CUSTOMERS_SCANNED before exhausting the customer list. There is no
   *  resumption cursor and Stripe lists newest-first, so a truncated account rescans the same customers every
   *  run; this flag makes that visible in cron_run_log instead of silently under-covering the account. */
  truncated: boolean;
  /** The failure that stopped this account's sync, else null. The cron handler fails the run on any. */
  error: string | null;
}

/** Runs the deterministic sync for one account: upserts every Stripe customer's customer_context row and
 *  writes one mrr_snapshots row. A no-op when the account has no active Stripe connection, never an error. */
export async function runIntelligenceSyncForAccount(
  env: Env,
  accountId: string,
  nowMs: number,
): Promise<AccountSyncResult> {
  const db = getDb(env);
  const connection = await findActiveConnection(db, accountId);
  if (!connection?.stripeAccessToken) {
    return {
      accountId,
      customersProcessed: 0,
      snapshotWritten: false,
      truncated: false,
      error: null,
    };
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
    db
      .select({ id: mrrSnapshots.id })
      .from(mrrSnapshots)
      .where(eq(mrrSnapshots.accountId, accountId))
      .limit(1),
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
  const coupons: CouponCache = new Map();
  let scanned = 0;
  let truncated = false;

  for await (const customer of stripe.customers.list({ limit: 100 })) {
    scanned += 1;
    if (scanned > INTELLIGENCE_MAX_CUSTOMERS_SCANNED) {
      truncated = true;
      break;
    }
    if (customer.deleted) continue;

    const snapshot = await fetchCustomerStripeSnapshot(stripe, customer.id, coupons, nowMs);
    const customerSinceMs = stripeMs(customer.created);
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
      cohortKey: monthKey(new Date(customerSinceMs)),
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
        scheduledChange: snapshot.scheduledChange,
      }),
    );
  }

  if (upserts.length > 0) {
    await db.batch([upserts[0], ...upserts.slice(1)]);
  }

  // Nothing to snapshot: no customers and no prior snapshot would just record an all-zero row.
  if (currentPoints.length === 0 && !hasPriorSnapshot) {
    return { accountId, customersProcessed: 0, snapshotWritten: false, truncated, error: null };
  }
  // A scan cut off at the cap saw only part of the customers, so its MRR row would chart a drop that never
  // happened. The run reports truncated and the charts keep the last complete day.
  if (truncated) {
    return {
      accountId,
      customersProcessed: currentPoints.length,
      snapshotWritten: false,
      truncated,
      error: null,
    };
  }

  const snapshotFields = buildMrrSnapshotFields(priorByCustomer, currentPoints);
  // One row per account per UTC day (mrr_snapshots_account_day_uq): a same-day re-sync replaces the row in one batch.
  const replaceDay = db
    .delete(mrrSnapshots)
    .where(
      and(
        eq(mrrSnapshots.accountId, accountId),
        sql`${mrrSnapshots.snapshotDate} / ${sql.raw(String(DAY_MS))} = ${Math.floor(now.getTime() / DAY_MS)}`,
      ),
    );
  const insertDay = db.insert(mrrSnapshots).values({
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
  await db.batch([replaceDay, insertDay]);

  // accounts.mrr_estimate: the active subscriptions normalized to a month (a truncated scan returned above).
  await db
    .update(accounts)
    .set({ mrrEstimateCents: snapshotFields.totalMrrCents })
    .where(eq(accounts.id, accountId));

  return {
    accountId,
    customersProcessed: currentPoints.length,
    snapshotWritten: true,
    truncated,
    error: null,
  };
}

/** Account-level gate for the sync: respects processing_paused and cancelledAt, excludes demo accounts
 *  (demo accounts are excluded from all processing). Does not gate on billing_exempt: the free MRR tier is
 *  not a billing action. Exported so its SQL shape is testable. */
export function accountProcessingEligible() {
  return and(
    eq(accounts.processingPaused, false),
    isNull(accounts.cancelledAt),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  );
}

/** The full sync run: every processing-eligible account; one account's failure never aborts the rest. */
export async function runIntelligenceSyncForAllAccounts(
  env: Env,
  nowMs: number,
): Promise<AccountSyncResult[]> {
  const db = getDb(env);
  const eligible = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(accountProcessingEligible());

  const results: AccountSyncResult[] = [];
  for (const { id } of eligible) {
    try {
      results.push(await runIntelligenceSyncForAccount(env, id, nowMs));
    } catch (err) {
      results.push({
        accountId: id,
        customersProcessed: 0,
        snapshotWritten: false,
        truncated: false,
        error: errorMessage(err),
      });
      console.error(`intelligence sync failed for account ${id}:`, errorMessage(err));
    }
  }
  return results;
}
