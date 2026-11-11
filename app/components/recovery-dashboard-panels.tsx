// The recovery dashboard's panels (routes/app/recovery/index.tsx split): range
// selector, onboarding checklist, stat cards, ROI, win-back, queue,
// deliverability and the payments table. Presentational.

import { relative, toMs, until } from "capsomer/behavior/time";
import type { ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Clock,
  CreditCard,
  Percent,
  RefreshCw,
  Send,
  Tag,
  TrendingUp,
} from "lucide-react";
import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { StaticStatTile, StatTiles } from "capsomer/react/stat-tile";
import { Pill, Status, type Tone as StatusTone } from "capsomer/react/status";
import "capsomer/stat-tile.css";
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
import { recoveryRateBand, recoveryRateTileTone } from "~/lib/dashboard/recovery-rate";
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
    <TabsNav
      aria-label="Date range"
      size="sm"
      renderLink={({ href, ...props }) => <Link to={href} {...props} />}
    >
      {RECOVERY_RANGES.map((r) => (
        <TabLink key={r} href={`/recovery/dashboard?range=${r}`} current={range === r}>
          {r}
        </TabLink>
      ))}
    </TabsNav>
  );
}

// ---- Banners above the head (Recova's hasBanners block) ----

/** One row of a list that is read, not opened: Capsomer's row look without a
 *  link or button inside, because Capsomer's Row is always interactive (gap
 *  named in the J74 pull request). */
export function StaticRow({
  title,
  detail,
  status,
  meta,
  actions,
}: {
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="cap-row" data-variant="outline">
      {status != null ? <span className="cap-row-status">{status}</span> : null}
      <div className="cap-row-title">{title}</div>
      {detail != null ? <p className="cap-row-detail">{detail}</p> : null}
      {meta != null ? <span className="cap-row-meta">{meta}</span> : null}
      {actions != null ? <div className="cap-row-actions">{actions}</div> : null}
    </li>
  );
}

export function ChecklistStatus({ done }: { done: boolean }) {
  return done ? <Status tone="ok">Done</Status> : <Status tone="nodata">To do</Status>;
}

export function OnboardingChecklist({
  connected,
  senderNameSet,
  alertAddressSet,
}: OnboardingChecklistState) {
  const allDone = connected && senderNameSet && alertAddressSet;
  return (
    <Panel title="Getting started">
      <ul className="cap-rows" role="list" data-gap="sm">
        <StaticRow
          status={<ChecklistStatus done={connected} />}
          title="Connect Stripe"
          detail="Link your Stripe account so Foxhound can detect failed payments"
          actions={
            connected ? null : (
              <Link to="/connect" className="cap-btn" data-variant="primary" data-size="sm">
                Connect
              </Link>
            )
          }
        />
        <StaticRow
          status={<ChecklistStatus done={senderNameSet} />}
          title="Set your sender name"
          detail="Customers will see this name in recovery emails"
          actions={
            senderNameSet ? null : (
              <Link to="/settings" className="cap-btn" data-size="sm">
                Go to settings
              </Link>
            )
          }
        />
        <StaticRow
          status={<ChecklistStatus done={alertAddressSet} />}
          title="Set your notification email"
          detail="We'll send you an alert when a payment is recovered."
          actions={
            alertAddressSet ? null : (
              <Link to="/settings" className="cap-btn" data-size="sm">
                Go to settings
              </Link>
            )
          }
        />
        <StaticRow
          status={<ChecklistStatus done={allDone} />}
          title="You're ready"
          detail="Foxhound will automatically detect and recover failed payments"
        />
      </ul>
    </Panel>
  );
}

// ---- Stat cards ----

export function StatCardsPrimary({ w }: { w: RecoveryDashboardWindow }) {
  const atRiskPct = atRiskPctOfMrr(w.atRiskRevenue, w.connection?.mrrEstimateCents ?? null);
  return (
    <StatTiles layout="grid" label="Recovery figures">
      <StaticStatTile
        size="lg"
        icon={<TrendingUp strokeWidth={1.5} />}
        label="Recovered (30d)"
        figure={formatCurrencyTotals(w.recoveredRevenue)}
      />
      <StaticStatTile
        size="lg"
        icon={<AlertCircle strokeWidth={1.5} />}
        label="Currently at risk"
        figure={formatCurrencyTotals(w.atRiskRevenue)}
        detail={atRiskPct !== null ? `${atRiskPct}% of MRR` : undefined}
      />
      {/* A rate with nothing failed is no rate: Foxhound shows "-" and says
          why, where Recova printed 0%. */}
      <StaticStatTile
        size="lg"
        icon={<Percent strokeWidth={1.5} />}
        label="Recovery rate"
        figure={w.recoveryRatePct === null ? "-" : `${w.recoveryRatePct}%`}
        tone={recoveryRateTileTone(w.recoveryRatePct)}
        detail={recoveryRateBand(w.recoveryRatePct)}
      />
    </StatTiles>
  );
}

export function StatCardsSecondary({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <StatTiles layout="grid" label="Recovery activity">
      <StaticStatTile
        icon={<Activity strokeWidth={1.5} />}
        label="Active sequences"
        figure={String(w.activePaymentsCount)}
      />
      <StaticStatTile
        icon={<RefreshCw strokeWidth={1.5} />}
        label="Win-backs active"
        figure={String(w.activeWinbacksCount)}
      />
      <StaticStatTile
        icon={<CreditCard strokeWidth={1.5} />}
        label="Cards expiring"
        figure={String(w.expiringCardsCount)}
      />
      <StaticStatTile
        icon={<Clock strokeWidth={1.5} />}
        label="Avg days to recovery"
        figure={w.avgDaysToRecovery === null ? "-" : `${w.avgDaysToRecovery}d`}
        detail={w.avgDaysToRecovery === null ? "No data" : `across ${w.recoveryDaysCount}`}
      />
      <StaticStatTile
        icon={<Tag strokeWidth={1.5} />}
        label="Best category"
        figure={w.bestCategory ? DECLINE_CATEGORY_LABELS[w.bestCategory.cat] : "-"}
        detail={w.bestCategory ? `${w.bestCategory.rate}% recovery` : "Need more"}
      />
      <StaticStatTile
        icon={<Send strokeWidth={1.5} />}
        label="Emails sent"
        figure={String(w.emailsSentInRange.sent)}
        detail={`${w.emailsSentInRange.openRatePct}% open · ${w.emailsSentInRange.clickRatePct}% click`}
      />
    </StatTiles>
  );
}

// ---- ROI widget ----

function RoiLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-label text-text-secondary">{label}</dt>
      <dd
        className={`m-0 font-mono text-body tabular-nums ${strong ? "font-semibold text-text" : "text-text-tertiary"}`}
      >
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
        <p className="m-0 text-label text-text-subtle">
          No attributed recoveries yet. Foxhound monitors every failed payment automatically.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h3 className="m-0 mb-3 text-micro font-medium uppercase tracking-wide text-text-tertiary">
              This month
            </h3>
            <dl className="m-0 flex flex-col gap-2">
              <RoiLine label="Recovered" value={formatCurrencyTotals(roi.thisMonth.recovered)} />
              <RoiLine
                label={`Foxhound fee (${RECOVERY_FEE_LABEL}, billed after ${RECOVERY_MATURITY_DAYS} days)`}
                value={formatCurrencyTotals(roi.thisMonth.fee)}
              />
              <RoiLine label="You keep" value={formatCurrencyTotals(roi.thisMonth.kept)} strong />
            </dl>
          </div>
          <div>
            <h3 className="m-0 mb-3 text-micro font-medium uppercase tracking-wide text-text-tertiary">
              All time
            </h3>
            <dl className="m-0 flex flex-col gap-2">
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
          <p className="m-0 mb-3 text-label text-text-subtle">No reactivations yet</p>
          {/* Recova's sentence named a 90-day window its engine kept; Foxhound
              credits a reactivation to the win-back sequence named in the
              checkout the email's link opens, with no window
              (app/lib/recovery/winback-reactivation.server.ts). */}
          <p className="m-0 text-micro text-text-subtle">
            When a customer who canceled reactivates their subscription from a win-back email, it
            appears here.
          </p>
        </div>
      ) : (
        <div>
          <p className="m-0 font-mono text-display font-semibold tabular-nums text-text">
            {w.reactivatedCount}
          </p>
          <p className="m-0 text-micro text-text-tertiary">
            customer{w.reactivatedCount !== 1 ? "s" : ""} reactivated
          </p>
          {w.reactivatedRevenue.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="m-0 text-micro text-text-tertiary">Monthly revenue recovered</p>
              <p className="m-0 font-mono text-title font-semibold tabular-nums text-text">
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
      <p className="m-0 px-1 py-3 text-label text-text-subtle">
        Nothing in the queue. All your recent payments came through clean.
      </p>
    );
  }
  return (
    <Panel title={`Recovery queue · next ${hours}h`}>
      <ul className="cap-rows" role="list" data-gap="xs">
        {w.upcomingSteps.map((s) => (
          <StaticRow
            key={s.id}
            title={s.customerName ?? s.customerEmail}
            detail={`${formatStepType(s.stepType)} · ${formatMoney(s.amountCents, s.currency)}`}
            meta={
              <span className="font-mono text-micro text-brand-text">
                {until(toMs(s.scheduledAt), nowMs)}
              </span>
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
    <p className="m-0">
      <span
        className={
          small
            ? "font-mono text-label tabular-nums text-text-subtle"
            : "font-mono text-title font-semibold tabular-nums text-text"
        }
      >
        {value}
      </span>{" "}
      <span className="text-micro text-text-tertiary">{label}</span>
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
    <div className="mb-5">
      <Panel title={`Email deliverability · ${rangeLabel}`}>
        {f === null ? (
          <p className="m-0 text-label text-text-subtle">
            No bounces or spam reports in this range.
          </p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-6">
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
        <span className="flex items-center gap-4 text-label">
          {/* Recova counted "active" among the eight rows on show; this is
              every payment in recovery now, which is what the word claims. */}
          <span className="text-text-subtle">
            {w.totalFailedCount} total · {w.activePaymentsCount} active
          </span>
          <Link to="/recovery/payments" className="text-brand-text">
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
          <ul className="cap-rows sm:hidden" role="list">
            {payments.map((p) => (
              <StaticRow
                key={p.id}
                title={p.customerName ?? p.customerEmail}
                detail={
                  <span className="flex flex-wrap items-center gap-2">
                    <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                    <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Pill>
                  </span>
                }
                meta={
                  <span className="font-mono text-label text-text">
                    {formatMoney(p.amountCents, p.currency)}
                  </span>
                }
                actions={
                  <Link
                    to={`/recovery/payments/${p.id}`}
                    aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                    className="text-micro text-brand-text"
                  >
                    View
                  </Link>
                }
              />
            ))}
          </ul>

          <div className="hidden sm:block">
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
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-text">
                              {p.customerName ?? p.customerEmail}
                            </span>
                            {prior > 0 ? <Pill tone="warn">{prior + 1}x failure</Pill> : null}
                          </span>
                          {p.customerName ? (
                            <span className="block text-micro font-normal text-text-subtle">
                              {p.customerEmail}
                            </span>
                          ) : null}
                          {p.planName ? (
                            <span className="block text-micro font-normal text-text-subtle">
                              {p.planName}
                            </span>
                          ) : null}
                        </th>
                        <td data-label="Amount" className="whitespace-nowrap font-mono">
                          {formatMoney(p.amountCents, p.currency)}
                        </td>
                        <td data-label="Decline">
                          <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                          {p.declineCode ? (
                            <span className="block font-mono text-micro text-text-subtle">
                              {p.declineCode}
                            </span>
                          ) : null}
                        </td>
                        <td data-label="Steps">
                          <span
                            className={`font-mono text-micro ${s.completed > 0 ? "text-text" : "text-text-subtle"}`}
                          >
                            {s.completed}/{s.total}
                          </span>
                          {s.next ? (
                            <span className="block text-micro text-brand-text">Next: {s.next}</span>
                          ) : null}
                        </td>
                        <td data-label="Status">
                          <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                            {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                          </Pill>
                        </td>
                        <td
                          data-label="Detected"
                          className="whitespace-nowrap text-micro text-text-subtle"
                        >
                          <span className="block">
                            {relative(toMs(p.detectedAt), nowMs, "UTC", { granularity: "day" })}
                          </span>
                          <span className="block">{formatLongDate(p.detectedAt)}</span>
                        </td>
                        <td data-label="Actions">
                          <Link
                            to={`/recovery/payments/${p.id}`}
                            aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                            className="whitespace-nowrap text-micro text-brand-text"
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
