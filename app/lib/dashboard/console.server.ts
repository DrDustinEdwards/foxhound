import { and, count, eq, gte, lte, notInArray, sql } from "drizzle-orm";

import {
  auditRuns,
  customerContext,
  disputes,
  recoveredPayments,
  type Db,
} from "~/db";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { groupSumByCurrency } from "./stats.server";
import {
  ATTENTION_ROWS_PER_CATEGORY,
  DISPUTE_ATTENTION_LIMIT,
  DISPUTE_URGENT_HOURS,
  cardExpiryDate,
  deadlinePhrase,
  expiryPhrase,
  isCardInAttentionWindow,
  isSequenceExhausted,
} from "./console";
import {
  getConnectionSummary,
  listActiveFailedPayments,
  listExpiringCardAlerts,
  listStepsForFailedPayments,
} from "~/lib/recovery/queries.server";

// The console read model: the platform-level hero row, the four product tiles,
// and the needs-attention feed. Legacy's parity source is app/(app)/console/
// page.tsx plus lib/console-data.tsx (11 exported symbols).
//
// This is one page, served at Recova's /console since J09 (rulings 55 and 56;
// it was /dashboard before). There is one console and login lands there.
// Consolidating two routes into one was the decision; dropping the content was
// not, and the content had been dropped.
//
// THREE legacy behaviors are deliberately not reproduced. Each was verified
// against legacy source, not assumed:
//
// 1. Legacy's "At risk right now" hero value is the literal `const atRiskCents = 0`
//    (page.tsx, with a `see vault/backlog.md: console-at-risk-amount-sum` note).
//    It shipped a permanent $0 and pushed the real signal into the subtext.
//    Foxhound sums the actual active failed-payment amounts, uncapped.
// 2. Legacy's "Platform health" recomputes a LIFETIME rate whose denominator
//    omits the is_renewal_noise filter every other aggregation applies and whose
//    numerator has no deleted_at filter, so the same account showed a different
//    recovery rate on two adjacent screens. This reuses the one cohort-anchored
//    rate the rest of the app already renders.
// 3. Legacy gates all four tiles on `account_products`. That table exists in
//    Foxhound but nothing writes it (only an admin display list reads it), so
//    porting the gate would render every tile permanently "inactive". Each tile
//    is gated on the precondition that is actually real here instead: a Stripe
//    connection for Recovery, an Intelligence entitlement for Intelligence,
//    nothing for Disputes (intake is webhook-driven, there is no toggle) and
//    nothing for Audit (legacy had no inactive state there either).

export interface ConsoleHero {
  protectedThisMonthCents: number;
  protectedCurrency: string;
  recoveredAllTimeCount: number;
  atRiskCents: number;
  atRiskCurrency: string;
  activeSequenceCount: number;
  openDisputeCount: number;
  /** null when there is no failure history yet: a zero state, not a 0%. */
  recoveryRatePct: number | null;
}

export interface ConsoleTiles {
  stripeConnected: boolean;
  intelligenceEntitled: boolean;
  recoveredThisMonthCents: number;
  recoveredCurrency: string;
  recoveryRatePct: number | null;
  openDisputeCount: number;
  disputesDueSoonCount: number;
  highRiskMrrCents: number;
  highRiskCustomerCount: number;
  lastAuditAt: Date | null;
  auditLeakingCents: number;
}

export type AttentionTone = "urgent" | "warning" | "subtle";

export interface AttentionRow {
  key: string;
  tone: AttentionTone;
  /** The customer or subject the row is about. */
  subject: string;
  /** What is being asked of the merchant, rendered after the subject. */
  detail: string;
  /** Trailing emphasis phrase (a deadline, an expiry). Optional. */
  emphasis: string | null;
  /** Monetary emphasis in cents, formatted by the component so money
   *  formatting stays in one place. Optional. */
  mrrCents: number | null;
  href: string | null;
  ariaLabel: string;
  product: string;
}

export interface ConsoleView {
  hero: ConsoleHero;
  tiles: ConsoleTiles;
  attention: AttentionRow[];
}

/** The label a row uses for its subject, with legacy's fallback chain. */
function subjectLabel(name: string | null, email: string | null): string {
  return name || email || "Customer";
}

export async function getConsoleView(
  db: Db,
  accountId: string,
  nowMs: number,
  recoveryRatePct: number | null,
): Promise<ConsoleView> {
  const now = new Date(nowMs);
  // UTC month boundary, so "this month" is stable regardless of server zone and
  // matches what the billing run considers a month.
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const urgentBefore = new Date(nowMs + DISPUTE_URGENT_HOURS * 60 * 60 * 1000);

  const [
    monthRecovered,
    allTimeRecoveredCount,
    activeFailed,
    openDisputeRows,
    dueSoonDisputes,
    atRiskCustomers,
    expiringCards,
    lastAudit,
    connection,
    intelligenceEntitled,
  ] = await Promise.all([
    db
      .select({ cents: recoveredPayments.amountCents, currency: recoveredPayments.currency })
      .from(recoveredPayments)
      .where(and(eq(recoveredPayments.accountId, accountId), gte(recoveredPayments.recoveredAt, startOfMonth))),
    db
      .select({ n: count() })
      .from(recoveredPayments)
      .where(eq(recoveredPayments.accountId, accountId)),
    // Uncapped. Legacy read a CONSOLE_ACTIVE_FAILED_LIMIT-capped window and then
    // derived its at-risk figure and active-sequence count from it, so both were
    // silently truncated on any account with more active failures than the cap.
    listActiveFailedPayments(db, accountId),
    db
      .select({ n: count() })
      .from(disputes)
      .where(
        and(
          eq(disputes.accountId, accountId),
          notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
        ),
      ),
    db
      .select({
        id: disputes.id,
        customerName: disputes.customerName,
        customerEmail: disputes.customerEmail,
        evidenceDeadline: disputes.evidenceDeadline,
      })
      .from(disputes)
      .where(
        and(
          eq(disputes.accountId, accountId),
          notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
          sql`${disputes.evidenceDeadline} is not null`,
          lte(disputes.evidenceDeadline, urgentBefore),
        ),
      )
      .orderBy(disputes.evidenceDeadline)
      .limit(DISPUTE_ATTENTION_LIMIT),
    // Legacy's equivalent row filtered on health_factors->>recommended_action =
    // 'personal_outreach'. Nothing in Foxhound writes recommended_action: it
    // exists only as demo seed data and as the unwritten ai_recommended_actions
    // column, the same blocker that holds /intelligence/recommendations. So this
    // is Foxhound's own derivation from columns that ARE populated, high-MRR
    // customers in the at-risk health band, and the row copy says that rather
    // than implying an engine recommended it.
    db
      .select({
        stripeCustomerId: customerContext.stripeCustomerId,
        customerName: customerContext.customerName,
        customerEmail: customerContext.customerEmail,
        mrrContributionCents: customerContext.mrrContributionCents,
        healthScore: customerContext.healthScore,
      })
      .from(customerContext)
      .where(
        and(
          eq(customerContext.accountId, accountId),
          sql`${customerContext.healthScore} is not null`,
          sql`${customerContext.healthScore} < ${HEALTH_SCORE_AT_RISK_THRESHOLD}`,
        ),
      )
      .orderBy(sql`${customerContext.mrrContributionCents} desc`)
      .limit(ATTENTION_ROWS_PER_CATEGORY),
    listExpiringCardAlerts(db, accountId),
    db
      .select({
        runAt: auditRuns.runAt,
        failedInvoicesCents: auditRuns.failedInvoicesCents,
        openDisputesCents: auditRuns.openDisputesCents,
      })
      .from(auditRuns)
      .where(eq(auditRuns.accountId, accountId))
      .orderBy(sql`${auditRuns.runAt} desc`)
      .limit(1),
    getConnectionSummary(db, accountId),
    isIntelligenceEntitled(db, accountId),
  ]);

  const protectedThisMonthCents = monthRecovered.reduce((s, r) => s + r.cents, 0);
  const protectedCurrency = monthRecovered[0]?.currency ?? "usd";
  // Grouped per currency, never a flat reduce: summing amountCents across
  // currencies produced a total that was the arithmetic sum of USD and EUR
  // labelled with whichever row sorted first. `[0]` is the same convention
  // dashboard.tsx already uses for every other CurrencyAmount[] it renders.
  const atRisk = groupSumByCurrency(activeFailed)[0] ?? null;
  const atRiskCents = atRisk?.cents ?? 0;
  const atRiskCurrency = atRisk?.currency ?? "usd";
  const openDisputeCount = Number(openDisputeRows[0]?.n ?? 0);

  // Exhausted sequences need each active payment's steps. One batched read for
  // every active payment rather than a query per row.
  const activeStepRows = await listStepsForFailedPayments(
    db,
    accountId,
    activeFailed.map((p) => p.id),
  );
  const stepsByPayment = new Map<string, typeof activeStepRows>();
  for (const s of activeStepRows) {
    const list = stepsByPayment.get(s.failedPaymentId) ?? [];
    list.push(s);
    stepsByPayment.set(s.failedPaymentId, list);
  }
  const exhausted = activeFailed.filter((p) =>
    isSequenceExhausted(stepsByPayment.get(p.id) ?? [], nowMs),
  );

  const attention: AttentionRow[] = [];

  for (const d of dueSoonDisputes) {
    if (!d.evidenceDeadline) continue;
    const label = subjectLabel(d.customerName, d.customerEmail);
    attention.push({
      key: `dispute-${d.id}`,
      tone: "urgent",
      subject: label,
      detail: "dispute due",
      emphasis: deadlinePhrase(d.evidenceDeadline, nowMs),
      mrrCents: null,
      href: `/disputes/${d.id}`,
      ariaLabel: `Open dispute for ${label}`,
      product: "Disputes",
    });
  }

  const exhaustedShown = exhausted.slice(0, ATTENTION_ROWS_PER_CATEGORY);
  for (const p of exhaustedShown) {
    const label = subjectLabel(p.customerName, p.customerEmail);
    attention.push({
      key: `exhausted-${p.id}`,
      tone: "warning",
      subject: label,
      detail: "recovery sequence ended",
      emphasis: null,
      mrrCents: null,
      href: `/recovery/payments/${p.id}`,
      ariaLabel: `Open recovery payment for ${label}`,
      product: "Recovery",
    });
  }
  const exhaustedExtra = exhausted.length - exhaustedShown.length;
  if (exhaustedExtra > 0) {
    attention.push({
      key: "exhausted-more",
      tone: "warning",
      subject: `and ${exhaustedExtra} more`,
      detail: exhaustedExtra === 1 ? "recovery sequence ended" : "recovery sequences ended",
      emphasis: null,
      mrrCents: null,
      href: "/recovery/payments?status=active",
      ariaLabel: `View ${exhaustedExtra} more ended recovery sequences`,
      product: "Recovery",
    });
  }

  for (const c of atRiskCustomers) {
    const label = subjectLabel(c.customerName, c.customerEmail);
    attention.push({
      key: `at-risk-${c.stripeCustomerId}`,
      tone: "warning",
      subject: label,
      detail: "at risk, worth a personal reach out",
      emphasis: null,
      mrrCents: c.mrrContributionCents ?? null,
      href: `/intelligence/customers/${c.stripeCustomerId}`,
      ariaLabel: `Open customer ${label}`,
      product: "Intelligence",
    });
  }

  const expiringSoon = expiringCards
    .map((c) => ({ ...c, expiresAt: cardExpiryDate(c.expiresMonth, c.expiresYear) }))
    .filter((c) => isCardInAttentionWindow(c.expiresAt, nowMs))
    .slice(0, ATTENTION_ROWS_PER_CATEGORY);
  for (const c of expiringSoon) {
    const label = subjectLabel(c.customerName, c.customerEmail);
    attention.push({
      key: `card-${c.id}`,
      tone: "subtle",
      subject: label,
      detail: "card",
      emphasis: expiryPhrase(c.expiresAt, nowMs),
      mrrCents: null,
      href: intelligenceEntitled && c.stripeCustomerId ? `/intelligence/customers/${c.stripeCustomerId}` : null,
      ariaLabel: `View expiring card customer ${label}`,
      product: "Recovery",
    });
  }

  const audit = lastAudit[0] ?? null;

  return {
    hero: {
      protectedThisMonthCents,
      protectedCurrency,
      recoveredAllTimeCount: Number(allTimeRecoveredCount[0]?.n ?? 0),
      atRiskCents,
      atRiskCurrency,
      activeSequenceCount: activeFailed.length,
      openDisputeCount,
      recoveryRatePct,
    },
    tiles: {
      stripeConnected: connection !== null,
      intelligenceEntitled,
      recoveredThisMonthCents: protectedThisMonthCents,
      recoveredCurrency: protectedCurrency,
      recoveryRatePct,
      openDisputeCount,
      disputesDueSoonCount: dueSoonDisputes.length,
      highRiskMrrCents: atRiskCustomers.reduce((s, c) => s + (c.mrrContributionCents ?? 0), 0),
      highRiskCustomerCount: atRiskCustomers.length,
      lastAuditAt: audit?.runAt ?? null,
      auditLeakingCents: audit ? (audit.failedInvoicesCents ?? 0) + (audit.openDisputesCents ?? 0) : 0,
    },
    attention,
  };
}

