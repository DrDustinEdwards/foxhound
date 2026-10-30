import { and, count, desc, eq, gte, isNotNull, isNull, like, lte, ne, notInArray, sql } from "drizzle-orm";

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
import { DAY_MS, FAILED_PAYMENT_STATUS_ACTIVE, HOUR_MS, type AlertMetric } from "~/lib/constants";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import {
  CRITICAL_CUSTOMERS_ALERT_LIVE,
  loadAlertTarget,
  notifyCriticalCustomers,
  notifyThresholdAlert,
  type CriticalNotifyOutcome,
} from "./alert-notify.server";
import {
  ALERT_COOLDOWN_WINDOW_MS,
  CRITICAL_CUSTOMERS_METRIC,
  CRITICAL_HEALTH_SCORE_MAX,
  buildAlertHistoryInsert,
  buildCriticalAlertHistoryInsert,
  buildAlertLastTriggeredUpdate,
  evaluateAlerts,
  type AlertConfig,
} from "./alerts";
import { accountProcessingEligible } from "./sync.server";

// Recova's evaluateAlerts (lib/alert-evaluation.ts, blob 0e28ecbf), which ran
// at the tail of its recovery, disputes and scheduled-audit crons: each
// account's enabled alerts against Recova's eleven metrics, then the always-on
// critical customers check. Foxhound runs it on the recovery tick
// (app/lib/cron/registry.ts), which is every five minutes, so an alert is
// noticed no later than Recova noticed it; the 24 hour cooldown keeps the
// mail to one a day.

/** Recova's computeMetrics, metric for metric, on Foxhound's tables. Three
 *  words differ, each because Foxhound already has one definition:
 *  the recovery rate is the dashboard's (getRecoveryStats), "open" for a
 *  dispute is a state not yet resolved (the digest's), and the high-risk band
 *  is Recova's health score of 33 or less. Amounts are summed per currency,
 *  never across currencies. */
async function computeAlertMetrics(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<Record<AlertMetric, number>> {
  const sevenDaysAgo = new Date(nowMs - 7 * DAY_MS);
  const fortyEightHoursOut = new Date(nowMs + 48 * HOUR_MS);
  const openDispute = and(eq(disputes.accountId, accountId), notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]));
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
          like(recoverySteps.stepType, "email_%"),
          like(recoverySteps.result, "email_sent%"),
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
      .where(and(openDispute, isNotNull(disputes.evidenceDeadline), lte(disputes.evidenceDeadline, fortyEightHoursOut))),
    db
      .select({ n: count(), cents: sql<number>`coalesce(sum(${customerContext.mrrContributionCents}), 0)` })
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

  // Counts add across currencies; amounts never do (hard rule 2). A threshold
  // is one number, so an amount alert compares against the largest
  // single-currency total: it fires when any one currency crosses it.
  const totalCount = (rows: { n: number }[]) => rows.reduce((sum, r) => sum + r.n, 0);
  const largestCents = (rows: { cents: number }[]) => Math.max(0, ...rows.map((r) => Number(r.cents)));
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
    // Recova's: 0 without a prior run, so "above 0" cannot fire on the first.
    audit_leaking_delta_cents: auditRows.length >= 2 ? leaking(auditRows[0]) - leaking(auditRows[1]) : 0,
  };
}

/**
 * Evaluate the account's enabled alerts and, for each that fires, notify and
 * then record, in Recova's order (lib/alert-evaluation.ts, blob 0e28ecbf):
 * the email or Slack post first, then the alert_history row with whether it
 * went, then last_triggered_at, which starts the 24 hour cooldown. Returns the
 * number of alerts that fired. A notification never throws (alert-notify), so
 * one failed send never stops the next alert or the run.
 */
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

  const target = await loadAlertTarget(db, accountId);
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

/**
 * The customers that are critical now: an active, undeleted failed payment, a
 * customer_context health score of 33 or less, and an open dispute, for the
 * same Stripe customer on the same account. One query with joins rather than
 * Recova's three reads with growing id lists, because D1 caps bound
 * parameters (RULES.md 3.11).
 *
 * "OPEN" IS FOXHOUND'S. Recova reads disputes.status in (needs_response,
 * under_review); Foxhound stores Stripe's status at intake and never updates
 * it, and keeps the dispute's life in `state`, so open is a state not yet
 * resolved, the same predicate the digest counts (RULES.md 3.20). The dispute's
 * customer is stripe_customer_id, which Foxhound writes at intake; Recova's
 * customer_id is a provenance column here.
 */
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
      and(eq(disputes.accountId, failedPayments.accountId), eq(disputes.stripeCustomerId, failedPayments.stripeCustomerId)),
    )
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        isNull(failedPayments.deletedAt),
        // Recova drops the empty string its webhook writes for a missing customer.
        ne(failedPayments.stripeCustomerId, ""),
        lte(customerContext.healthScore, CRITICAL_HEALTH_SCORE_MAX),
        notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
      ),
    );
  return rows.map((r) => r.stripeCustomerId);
}

/**
 * Recova's cross-product critical customer check (E22), for one account, in
 * Recova's order: the cooldown on the account's last cross_product_critical
 * row, the customers, the notification (notifyCriticalCustomers: email first,
 * Slack without an address), then one alert_history row with whether it went.
 * The row is written here, not in the notification module (RULES.md 3.2), as
 * evaluateAndRecordAlerts does for E21. Never throws.
 */
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`critical customers alert failed for account ${accountId}:`, message);
    return { kind: "error", message };
  }
}

/**
 * One account's alerts, as Recova's evaluateAlerts runs them: the metrics are
 * read only when the account has an enabled alert, then the critical
 * customers check, which needs none. Returns how many threshold alerts fired.
 */
async function evaluateAccountAlerts(env: Env, db: Db, accountId: string, now: Date): Promise<number> {
  const [enabled] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.accountId, accountId), eq(alerts.enabled, true)))
    .limit(1);
  const fired = enabled
    ? await evaluateAndRecordAlerts(env, db, accountId, await computeAlertMetrics(db, accountId, now.getTime()), now)
    : 0;
  if (CRITICAL_CUSTOMERS_ALERT_LIVE) await runCriticalCustomersCheck(env, db, accountId, now);
  return fired;
}

/** Every processing-eligible account's alerts. One account's failure never
 *  stops the rest, as Recova's per-account try/catch. */
export async function runAlertsForAllAccounts(env: Env, nowMs: number): Promise<{ accounts: number; fired: number }> {
  const db = getDb(env);
  const now = new Date(nowMs);
  const eligible = await db.select({ id: accounts.id }).from(accounts).where(accountProcessingEligible());
  let fired = 0;
  for (const { id } of eligible) {
    try {
      fired += await evaluateAccountAlerts(env, db, id, now);
    } catch (err) {
      console.error(`alert evaluation failed for account ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { accounts: eligible.length, fired };
}
