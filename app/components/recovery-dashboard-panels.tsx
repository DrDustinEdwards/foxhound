// The recovery dashboard's panels (routes/app/recovery/index.tsx split): range
// selector, onboarding steps, stat cards, ROI, win-back, queue,
// deliverability and the payments table. Presentational.

import { relative, toMs, until } from "capsomer/behavior/time";
import {
  Icon,
  iconActivity,
  iconAlert,
  iconCard,
  iconClock,
  iconPercent,
  iconRefresh,
  iconSend,
  iconTag,
  iconTrendingUp,
} from "capsomer/react/icons";
import { Link, routerRenderLink } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row } from "capsomer/react/row-list";
import type { SetupStep } from "capsomer/react/setup-checklist";
import { Pill, type Tone as StatusTone } from "capsomer/react/status";
import { TabLink, TabsNav } from "capsomer/react/tabs";
import { RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import type { RecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import {
  RECOVERY_RANGES,
  type RecoveryRange,
  type WebhookHealthTone,
} from "~/lib/dashboard/recovery-window";
import {
  atRiskPctOfMrr,
  declineLabel,
  deliverabilityFigures,
  formatCurrencyTotals,
  formatLongDate,
  RECOVERY_FEE_LABEL,
  type OnboardingChecklistState,
  type PaymentStepSummary,
  type RoiColumn,
} from "~/lib/dashboard/recovery-dashboard";
import { recoveryRateBand, recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { priorFailureCount } from "~/lib/recovery/prior-failures";
import {
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  failedPaymentStatusTone,
  formatStepType,
} from "~/lib/recovery/labels";

// ---- Head ----

export const WEBHOOK_TONE: Record<WebhookHealthTone, StatusTone> = {
  success: "ok",
  neutral: "info",
  failure: "crit",
};

export function RangeSelector({ range }: { range: RecoveryRange }) {
  return (
    <TabsNav aria-label="Date range" size="sm" renderLink={routerRenderLink}>
      {RECOVERY_RANGES.map((r) => (
        <TabLink key={r} href={`/recovery/dashboard?range=${r}`} current={range === r}>
          {r}
        </TabLink>
      ))}
    </TabsNav>
  );
}

// ---- Banners above the head (Recova's hasBanners block) ----

/** Recova's OnboardingChecklist steps, for Capsomer's setup checklist: each
 *  one Done or To do, with its one way to do it until it is done. */
export function onboardingSteps({
  connected,
  senderNameSet,
  alertAddressSet,
}: OnboardingChecklistState): SetupStep[] {
  return [
    {
      id: "connect",
      title: "Connect Stripe",
      detail: "Link your Stripe account so Foxhound can detect failed payments",
      done: connected,
      action: (
        <Link to="/connect" className="cap-btn" data-variant="primary" data-size="sm">
          Connect
        </Link>
      ),
    },
    {
      id: "sender",
      title: "Set your sender name",
      detail: "Customers will see this name in recovery emails",
      done: senderNameSet,
      action: (
        <Link to="/settings" className="cap-btn" data-size="sm">
          Go to settings
        </Link>
      ),
    },
    {
      id: "alerts",
      title: "Set your notification email",
      detail: "We'll send you an alert when a payment is recovered.",
      done: alertAddressSet,
      action: (
        <Link to="/settings" className="cap-btn" data-size="sm">
          Go to settings
        </Link>
      ),
    },
  ];
}

export const ONBOARDING_READY = {
  title: "You're ready",
  detail: "Foxhound will automatically detect and recover failed payments",
};

// ---- Stat cards ----

/** Recova's PrimaryCard and SecondaryCard: an icon, the label, the figure and
 *  an optional line under it, here as a small Capsomer panel (Capsomer's stat
 *  tile is always a link or a button, and Recova's cards lead nowhere). */

function StatCard({
  icon,
  label,
  value,
  sub,
  valueClassName,
  primary,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
  primary?: boolean;
}) {
  return (
    <Panel
      size="sm"
      title={
        <span className="fh-recpanel-label">
          <Icon d={icon} className="fh-icon-16 fh-icon-fine" />
          {label}
        </span>
      }
    >
      <p
        className={`fh-mono fh-medium cap-num ${primary ? "fh-display" : "fh-title"} ${valueClassName ?? "fh-text"}`}
      >
        {value}
      </p>
      {sub ? <p className="fh-tiny fh-faint">{sub}</p> : null}
    </Panel>
  );
}

export function StatCardsPrimary({ w }: { w: RecoveryDashboardWindow }) {
  const atRiskPct = atRiskPctOfMrr(w.atRiskRevenue, w.connection?.mrrEstimateCents ?? null);
  return (
    <div className="fh-recpanel-hero">
      <StatCard
        primary
        icon={iconTrendingUp}
        label="Recovered (30d)"
        value={formatCurrencyTotals(w.recoveredRevenue)}
      />
      <StatCard
        primary
        icon={iconAlert}
        label="Currently at risk"
        value={formatCurrencyTotals(w.atRiskRevenue)}
        sub={atRiskPct !== null ? `${atRiskPct}% of MRR` : undefined}
      />
      {/* A rate with nothing failed is no rate: Foxhound shows "-" and says
          why, where Recova printed 0%. */}
      <StatCard
        primary
        icon={iconPercent}
        label="Recovery rate"
        value={w.recoveryRatePct === null ? "-" : `${w.recoveryRatePct}%`}
        valueClassName={
          w.recoveryRatePct === null ? undefined : recoveryRateClassName(w.recoveryRatePct)
        }
        sub={recoveryRateBand(w.recoveryRatePct)}
      />
    </div>
  );
}

export function StatCardsSecondary({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <div className="fh-recpanel-tiles">
      <StatCard
        icon={iconActivity}
        label="Active sequences"
        value={String(w.activePaymentsCount)}
      />
      <StatCard icon={iconRefresh} label="Win-backs active" value={String(w.activeWinbacksCount)} />
      <StatCard icon={iconCard} label="Cards expiring" value={String(w.expiringCardsCount)} />
      <StatCard
        icon={iconClock}
        label="Avg days to recovery"
        value={w.avgDaysToRecovery === null ? "-" : `${w.avgDaysToRecovery}d`}
        sub={w.avgDaysToRecovery === null ? "No data" : `across ${w.recoveryDaysCount}`}
      />
      <StatCard
        icon={iconTag}
        label="Best category"
        value={w.bestCategory ? DECLINE_CATEGORY_LABELS[w.bestCategory.cat] : "-"}
        sub={w.bestCategory ? `${w.bestCategory.rate}% recovery` : "Need more"}
      />
      <StatCard
        icon={iconSend}
        label="Emails sent"
        value={String(w.emailsSentInRange.sent)}
        sub={`${w.emailsSentInRange.openRatePct}% open · ${w.emailsSentInRange.clickRatePct}% click`}
      />
    </div>
  );
}

// ---- ROI widget ----

function RoiLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="fh-recpanel-line">
      <dt className="fh-small fh-soft">{label}</dt>
      <dd className={`fh-mono fh-body cap-num ${strong ? "fh-semibold fh-text" : "fh-quiet"}`}>
        {value}
      </dd>
    </div>
  );
}

/** Recova's ROIWidget, its two columns and six lines, on the figures Foxhound
 *  bills: attributed recoveries that have matured, with the fee from the
 *  pricing constant. Recova's "Recova fee (20%)" over every retry, click and
 *  manual recovery is the unratified claim not copied (ROWS-S S5, 181); the
 *  panel title says which recoveries these are, and "fees paid" became "fees",
 *  because Foxhound cannot know an invoice was paid from this page. */
export function RoiWidget({ roi }: { roi: { thisMonth: RoiColumn; allTime: RoiColumn } }) {
  const empty = roi.thisMonth.recovered.length === 0 && roi.allTime.recovered.length === 0;
  return (
    <Panel
      title="Foxhound-attributed revenue"
      description={
        empty
          ? undefined
          : `Recoveries where a Foxhound action preceded payment. This month counts every attributed recovery since the 1st; all time counts those that have held for ${RECOVERY_MATURITY_DAYS} days, which are the ones Foxhound bills. Stripe's own recoveries are never billed.`
      }
    >
      {empty ? (
        <p className="fh-small fh-faint">
          No attributed recoveries yet. Foxhound monitors every failed payment automatically.
        </p>
      ) : (
        <div className="fh-recpanel-pair">
          <div>
            <h3 className="fh-recpanel-title fh-tiny fh-medium fh-quiet fh-caps">This month</h3>
            <dl className="cap-stack" data-gap="3">
              <RoiLine label="Recovered" value={formatCurrencyTotals(roi.thisMonth.recovered)} />
              <RoiLine
                label={`Foxhound fee (${RECOVERY_FEE_LABEL}, billed after ${RECOVERY_MATURITY_DAYS} days)`}
                value={formatCurrencyTotals(roi.thisMonth.fee)}
              />
              <RoiLine label="You keep" value={formatCurrencyTotals(roi.thisMonth.kept)} strong />
            </dl>
          </div>
          <div>
            <h3 className="fh-recpanel-title fh-tiny fh-medium fh-quiet fh-caps">All time</h3>
            <dl className="cap-stack" data-gap="3">
              <RoiLine
                label="Total recovered"
                value={formatCurrencyTotals(roi.allTime.recovered)}
              />
              <RoiLine label="Total fees" value={formatCurrencyTotals(roi.allTime.fee)} />
              <RoiLine label="Net to you" value={formatCurrencyTotals(roi.allTime.kept)} strong />
            </dl>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ---- Win-back, queue ----

export function WinBackCard({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <Panel title={`Win-back attribution · ${w.rangeLabel}`}>
      {w.reactivatedCount === 0 ? (
        <div>
          <p className="fh-recpanel-title fh-small fh-faint">No reactivations yet</p>
          {/* Recova's sentence named a 90-day window its engine kept; Foxhound
              credits a reactivation to the win-back sequence named in the
              checkout the email's link opens, with no window
              (app/lib/recovery/winback-reactivation.server.ts). */}
          <p className="fh-tiny fh-faint">
            When a customer who canceled reactivates their subscription from a win-back email, it
            appears here.
          </p>
        </div>
      ) : (
        <div>
          <p className="fh-mono fh-display fh-semibold cap-num fh-text">{w.reactivatedCount}</p>
          <p className="fh-tiny fh-quiet">
            customer{w.reactivatedCount !== 1 ? "s" : ""} reactivated
          </p>
          {w.reactivatedRevenue.length > 0 ? (
            <div className="fh-recpanel-foot">
              <p className="fh-tiny fh-quiet">Monthly revenue recovered</p>
              <p className="fh-mono fh-title fh-semibold cap-num fh-text">
                {formatCurrencyTotals(w.reactivatedRevenue)}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

export function RecoveryQueue({
  w,
  nowMs,
  hours,
}: {
  w: RecoveryDashboardWindow;
  nowMs: number;
  hours: number;
}) {
  if (w.upcomingSteps.length === 0) {
    return (
      <p className="fh-recpanel-empty fh-small fh-faint">
        Nothing in the queue. All your recent payments came through clean.
      </p>
    );
  }
  return (
    <Panel title={`Recovery queue · next ${hours}h`}>
      <ul className="cap-rows" role="list" data-gap="xs">
        {w.upcomingSteps.map((s) => (
          <Row
            variant="outline"
            key={s.id}
            title={s.customerName ?? s.customerEmail}
            detail={`${formatStepType(s.stepType)} · ${formatMoney(s.amountCents, s.currency)}`}
            meta={
              <span className="fh-mono fh-tiny fh-brand">{until(toMs(s.scheduledAt), nowMs)}</span>
            }
          />
        ))}
      </ul>
    </Panel>
  );
}

// ---- Failed payments ----

const PILL_TONE: Record<"success" | "failure" | "neutral", StatusTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

function DeliverabilityFigure({
  value,
  label,
  small,
}: {
  value: string;
  label: string;
  small?: boolean;
}) {
  return (
    <p className="">
      <span
        className={
          small
            ? "fh-mono fh-small cap-num fh-faint"
            : "fh-mono fh-title fh-semibold cap-num fh-text"
        }
      >
        {value}
      </span>{" "}
      <span className="fh-tiny fh-quiet">{label}</span>
    </p>
  );
}

/** Recova's DeliverabilityPanel (blob 87a88d88) on what Foxhound records.
 *  Recova's "delivered" figure and its alert are not shown: Foxhound stores no
 *  delivered event. Its empty state named Recova's old email provider; this
 *  one names Email Service. */
export function DeliverabilityPanel({
  counts,
  rangeLabel,
}: {
  counts: { sent: number; bounced: number; complaints: number };
  rangeLabel: string;
}) {
  const f = deliverabilityFigures(counts);
  const rate = (pct: number | null) => (pct === null ? "-" : `${pct}%`);
  return (
    <div className="fh-recpanel-figures">
      <Panel title={`Email deliverability · ${rangeLabel}`}>
        {f === null ? (
          <p className="fh-small fh-faint">No bounces or spam reports in this range.</p>
        ) : (
          <div className="fh-recpanel-figure-row">
            <DeliverabilityFigure value={rate(f.bounceRatePct)} label="bounced" />
            <DeliverabilityFigure value={rate(f.spamRatePct)} label="spam" />
            <DeliverabilityFigure value={String(f.sent)} label="sent" small />
          </div>
        )}
      </Panel>
    </div>
  );
}

export function PaymentsTable({
  w,
  steps,
  nowMs,
}: {
  w: RecoveryDashboardWindow;
  steps: Record<string, PaymentStepSummary>;
  nowMs: number;
}) {
  const payments = w.recentPayments;
  return (
    <Panel
      title="Failed payments"
      flush
      actions={
        <span className="fh-recpanel-legend fh-small">
          {/* Recova counted "active" among the eight rows on show; this is
              every payment in recovery now, which is what the word claims. */}
          <span className="fh-faint">
            {w.totalFailedCount} total · {w.activePaymentsCount} active
          </span>
          <Link to="/recovery/payments" className="fh-brand">
            View all
          </Link>
        </span>
      }
    >
      {payments.length === 0 ? (
        <Empty kind="nothing-yet" title="No failed payments yet" flush>
          Failed payments will appear here when detected.
        </Empty>
      ) : (
        <>
          {/* Recova's phone layout: one card per payment. */}
          <ul className="fh-phone-list cap-rows" role="list">
            {payments.map((p) => (
              <Row
                variant="outline"
                key={p.id}
                title={p.customerName ?? p.customerEmail}
                detail={
                  <span className="cap-cluster" data-gap="3">
                    <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                    <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Pill>
                  </span>
                }
                meta={
                  <span className="fh-mono fh-small fh-text">
                    {formatMoney(p.amountCents, p.currency)}
                  </span>
                }
                actions={
                  <Link
                    to={`/recovery/payments/${p.id}`}
                    aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                    className="fh-tiny fh-brand"
                  >
                    View
                  </Link>
                }
              />
            ))}
          </ul>

          <div className="fh-wide-list">
            <div
              className="cap-table-wrap"
              data-reflow="medium"
              data-cap="table"
              role="region"
              aria-label="Failed payments"
              tabIndex={0}
            >
              <table className="cap-table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Decline</th>
                    <th scope="col">Steps</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detected</th>
                    <th scope="col">
                      <span className="cap-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const prior = priorFailureCount(w.previousFailureCounts[p.stripeCustomerId]);
                    const s = steps[p.id] ?? { completed: 0, total: 0, next: null };
                    return (
                      <tr key={p.id}>
                        <th scope="row">
                          <span className="cap-cluster" data-gap="3">
                            <span className="fh-medium fh-text">
                              {p.customerName ?? p.customerEmail}
                            </span>
                            {prior > 0 ? <Pill tone="warn">{prior + 1}x failure</Pill> : null}
                          </span>
                          {p.customerName ? (
                            <span className="fh-line fh-tiny fh-regular fh-faint">
                              {p.customerEmail}
                            </span>
                          ) : null}
                          {p.planName ? (
                            <span className="fh-line fh-tiny fh-regular fh-faint">
                              {p.planName}
                            </span>
                          ) : null}
                        </th>
                        <td data-label="Amount" className="fh-nowrap fh-mono">
                          {formatMoney(p.amountCents, p.currency)}
                        </td>
                        <td data-label="Decline">
                          <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                          {p.declineCode ? (
                            <span className="fh-line fh-mono fh-tiny fh-faint">
                              {p.declineCode}
                            </span>
                          ) : null}
                        </td>
                        <td data-label="Steps">
                          <span
                            className={`fh-mono fh-tiny ${s.completed > 0 ? "fh-text" : "fh-faint"}`}
                          >
                            {s.completed}/{s.total}
                          </span>
                          {s.next ? (
                            <span className="fh-line fh-tiny fh-brand">Next: {s.next}</span>
                          ) : null}
                        </td>
                        <td data-label="Status">
                          <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                            {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                          </Pill>
                        </td>
                        <td data-label="Detected" className="fh-nowrap fh-tiny fh-faint">
                          <span className="fh-line">
                            {relative(toMs(p.detectedAt), nowMs, "UTC", { granularity: "day" })}
                          </span>
                          <span className="fh-line">{formatLongDate(p.detectedAt)}</span>
                        </td>
                        <td data-label="Actions">
                          <Link
                            to={`/recovery/payments/${p.id}`}
                            aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                            className="fh-nowrap fh-tiny fh-brand"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
