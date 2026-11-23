import { likeStartsWith } from "@dustinedwards/site-runtime/d1";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import {
  accounts,
  alertHistory,
  alerts,
  auditRuns,
  customerContext,
  disputes,
  failedPayments,
  getDb,
  recoverySteps,
  type Db,
} from "~/db";
import {
  CRITICAL_HEALTH_SCORE_MAX,
  DAY_MS,
  FAILED_PAYMENT_STATUS_ACTIVE,
  HOUR_MS,
  type AlertMetric,
} from "~/lib/constants";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import {
  loadAlertTarget,
  notifyCriticalCustomers,
  notifyThresholdAlert,
  type CriticalNotifyOutcome,
} from "./alert-notify.server";
import {
  ALERT_COOLDOWN_WINDOW_MS,
  CRITICAL_CUSTOMERS_METRIC,
  buildAlertHistoryInsert,
  buildCriticalAlertHistoryInsert,
  buildAlertLastTriggeredUpdate,
  evaluateAlerts,
  type AlertConfig,
} from "./alerts";
import { accountProcessingEligible } from "./sync.server";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// Evaluates each account's enabled alerts against the eleven metrics, then the always-on critical customers
// check. Runs on the five-minute recovery tick (app/lib/cron/registry.ts); the 24 hour cooldown keeps the mail to one a day.

/** The alert metrics on Foxhound's tables. Where Foxhound already has a definition it is used: the recovery rate is
 *  the dashboard's (getRecoveryStats), "open" for a dispute is a state not yet resolved, and the high-risk band
 *  is a health score of 33 or less. Amounts are summed per currency, never across currencies. */
async function computeAlertMetrics(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<Record<AlertMetric, number>> {
  const sevenDaysAgo = new Date(nowMs - 7 * DAY_MS);
  const fortyEightHoursOut = new Date(nowMs + 48 * HOUR_MS);
  const openDispute = and(
    eq(disputes.accountId, accountId),
    notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
  );
  const highRisk = and(
    eq(customerContext.accountId, accountId),
    isNotNull(customerContext.healthScore),
    lte(customerContext.healthScore, CRITICAL_HEALTH_SCORE_MAX),
  );

  const [stats, active, emails, openDisputes, dueSoon, highRiskRow, auditRows] = await Promise.all([
    getRecoveryStats(db, accountId, nowMs),
    db
      .select({ n: count(), cents: sql<number>`coalesce(sum(${failedPayments.amountCents}), 0)` })
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.accountId, accountId),
          isNull(failedPayments.deletedAt),
          eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        ),
      )
      .groupBy(failedPayments.currency),
    db
      .select({ n: count() })
      .from(recoverySteps)
      .where(
        and(
          eq(recoverySteps.accountId, accountId),
          isNull(recoverySteps.deletedAt),
          likeStartsWith(recoverySteps.stepType, "email_"),
          likeStartsWith(recoverySteps.result, "email_sent"),
          gte(recoverySteps.executedAt, sevenDaysAgo),
        ),
      ),
    db
      .select({ n: count(), cents: sql<number>`coalesce(sum(${disputes.amountCents}), 0)` })
      .from(disputes)
      .where(openDispute)
      .groupBy(disputes.currency),
    db
      .select({ n: count() })
      .from(disputes)
      .where(
        and(
          openDispute,
          isNotNull(disputes.evidenceDeadline),
          lte(disputes.evidenceDeadline, fortyEightHoursOut),
        ),
      ),
    db
      .select({
        n: count(),
        cents: sql<number>`coalesce(sum(${customerContext.mrrContributionCents}), 0)`,
      })
      .from(customerContext)
      .where(highRisk)
      .groupBy(customerContext.currency),
    db
      .select({ failed: auditRuns.failedInvoicesCents, disputed: auditRuns.openDisputesCents })
      .from(auditRuns)
      .where(eq(auditRuns.accountId, accountId))
      .orderBy(desc(auditRuns.runAt))
      .limit(2),
  ]);

  // Counts add across currencies; amounts never do (hard rule 2). A threshold is one number, so an amount alert
  // fires when any one currency's largest total crosses it.
  const totalCount = (rows: { n: number }[]) => rows.reduce((sum, r) => sum + r.n, 0);
  const largestCents = (rows: { cents: number }[]) =>
    Math.max(0, ...rows.map((r) => Number(r.cents)));
  const leaking = (r: { failed: number | null; disputed: number | null } | undefined) =>
    r ? (r.failed ?? 0) + (r.disputed ?? 0) : 0;
  return {
    recovery_rate_pct: stats.recoveryRatePct ?? 0,
    mrr_at_risk_cents: largestCents(active),
    active_sequences: totalCount(active),
    emails_sent_7d: emails[0]?.n ?? 0,
    open_disputes_count: totalCount(openDisputes),
    disputes_due_48h: dueSoon[0]?.n ?? 0,
    dispute_amount_at_stake_cents: largestCents(openDisputes),
    high_risk_customers_count: totalCount(highRiskRow),
    intelligence_mrr_at_risk_cents: largestCents(highRiskRow),
    audit_leaking_cents: leaking(auditRows[0]),
    // 0 without a prior run, so "above 0" cannot fire on the first.
    audit_leaking_delta_cents:
      auditRows.length >= 2 ? leaking(auditRows[0]) - leaking(auditRows[1]) : 0,
  };
}

/** Evaluate the account's enabled alerts; for each that fires, notify, then record the alert_history row (with
 *  whether it went), then last_triggered_at, which starts the 24 hour cooldown. Returns the number fired. A
 *  notification never throws, so one failed send never stops the run. */
export async function evaluateAndRecordAlerts(
  env: Env,
  db: Db,
  accountId: string,
  metrics: Record<string, number>,
  now: Date,
): Promise<number> {
  const configs: AlertConfig[] = await db
    .select({
      id: alerts.id,
      accountId: alerts.accountId,
      metric: alerts.metric,
      thresholdValue: alerts.thresholdValue,
      direction: alerts.direction,
      channel: alerts.channel,
      lastTriggeredAt: alerts.lastTriggeredAt,
    })
    .from(alerts)
    .where(and(eq(alerts.accountId, accountId), eq(alerts.enabled, true)));
  if (configs.length === 0) return 0;

  const firings = evaluateAlerts(configs, metrics, now.getTime());
  if (firings.length === 0) return 0;

  const target = await loadAlertTarget(env, db, accountId);
  for (const f of firings) {
    const outcome = await notifyThresholdAlert(env, target, f, now);
    await db.batch([
      buildAlertHistoryInsert(db, f, now, outcome.sent),
      buildAlertLastTriggeredUpdate(db, f.alertId, now),
    ]);
  }
  return firings.length;
}

export type CriticalCustomersOutcome =
  | { kind: "skipped"; reason: "cooldown" | "none_critical" }
  | {
      kind: "fired";
      count: number;
      channel: "email" | "slack" | "none";
      notificationSent: boolean;
      detail: CriticalNotifyOutcome["detail"];
    }
  | { kind: "error"; message: string };

/** The critical customers: an active, undeleted failed payment, a health score of 33 or less, and an open
 *  dispute, for the same Stripe customer on the same account, in one query (D1 caps bound parameters). "Open"
 *  is a dispute `state` not yet resolved (Stripe's status is stored at intake and never updated), the same
 *  predicate the digest counts. Matches on stripe_customer_id. */
async function findCriticalCustomerIds(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ stripeCustomerId: failedPayments.stripeCustomerId })
    .from(failedPayments)
    .innerJoin(
      customerContext,
      and(
        eq(customerContext.accountId, failedPayments.accountId),
        eq(customerContext.stripeCustomerId, failedPayments.stripeCustomerId),
      ),
    )
    .innerJoin(
      disputes,
      and(
        eq(disputes.accountId, failedPayments.accountId),
        eq(disputes.stripeCustomerId, failedPayments.stripeCustomerId),
      ),
    )
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        isNull(failedPayments.deletedAt),
        // The webhook writes "" for a missing customer.
        ne(failedPayments.stripeCustomerId, ""),
        lte(customerContext.healthScore, CRITICAL_HEALTH_SCORE_MAX),
        notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
      ),
    );
  return rows.map((r) => r.stripeCustomerId);
}

/** The cross-product critical customer check for one account: cooldown on the last cross_product_critical row,
 *  the customers, the notification, then one alert_history row with whether it went. The row is written here,
 *  not in the notification module. Never throws. */
export async function runCriticalCustomersCheck(
  env: Env,
  db: Db,
  accountId: string,
  now: Date,
): Promise<CriticalCustomersOutcome> {
  try {
    const [recent] = await db
      .select({ id: alertHistory.id })
      .from(alertHistory)
      .where(
        and(
          eq(alertHistory.accountId, accountId),
          eq(alertHistory.metric, CRITICAL_CUSTOMERS_METRIC),
          gte(alertHistory.firedAt, new Date(now.getTime() - ALERT_COOLDOWN_WINDOW_MS)),
        ),
      )
      .limit(1);
    if (recent) return { kind: "skipped", reason: "cooldown" };

    const critical = await findCriticalCustomerIds(db, accountId);
    if (critical.length === 0) return { kind: "skipped", reason: "none_critical" };
    const count = critical.length;

    const sent = await notifyCriticalCustomers(env, db, accountId, count, now);
    await buildCriticalAlertHistoryInsert(db, {
      accountId,
      count,
      channel: sent.channel,
      notificationSent: sent.notificationSent,
      firedAt: now,
    });
    return { kind: "fired", count, ...sent };
  } catch (err) {
    const message = errorMessage(err);
    console.error(`critical customers alert failed for account ${accountId}:`, message);
    return { kind: "error", message };
  }
}

/** One account's alerts: metrics are read only when it has an enabled alert, then the critical customers check
 *  (which needs none). Returns how many threshold alerts fired. */
async function evaluateAccountAlerts(
  env: Env,
  db: Db,
  account: { id: string; hasEnabledAlert: boolean },
  now: Date,
): Promise<number> {
  const fired = account.hasEnabledAlert
    ? await evaluateAndRecordAlerts(
        env,
        db,
        account.id,
        await computeAlertMetrics(db, account.id, now.getTime()),
        now,
      )
    : 0;
  await runCriticalCustomersCheck(env, db, account.id, now);
  return fired;
}

/** Every processing-eligible account's alerts; one account's failure never stops the rest. */
export async function runAlertsForAllAccounts(
  env: Env,
  nowMs: number,
): Promise<{ accounts: number; fired: number }> {
  const db = getDb(env);
  const now = new Date(nowMs);
  // Whether each account has an enabled alert comes with the account list: one query, not one per account.
  const eligible = await db
    .select({
      id: accounts.id,
      hasEnabledAlert: exists(
        db
          .select({ one: sql`1` })
          .from(alerts)
          .where(and(eq(alerts.accountId, accounts.id), eq(alerts.enabled, true))),
      ).mapWith(Boolean),
    })
    .from(accounts)
    .where(accountProcessingEligible());
  let fired = 0;
  for (const account of eligible) {
    const { id } = account;
    try {
      fired += await evaluateAccountAlerts(env, db, account, now);
    } catch (err) {
      console.error(`alert evaluation failed for account ${id}:`, errorMessage(err));
    }
  }
  return { accounts: eligible.length, fired };
}
