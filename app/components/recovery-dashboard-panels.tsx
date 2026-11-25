// The recovery dashboard's panels (routes/app/recovery/index.tsx split): range
// selector, onboarding steps, stat cards, ROI, win-back, queue,
// deliverability and the payments table. Presentational.

import { toMs, until } from "capsomer/behavior/time";
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
import { ButtonLink, routerRenderLink } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { Row } from "capsomer/react/row-list";
import type { SetupStep } from "capsomer/react/setup-checklist";
import { type Tone as StatusTone } from "capsomer/react/status";
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
  deliverabilityFigures,
  RECOVERY_FEE_LABEL,
  type OnboardingChecklistState,
  type RoiColumn,
} from "~/lib/dashboard/recovery-dashboard";
import { formatAmounts } from "~/lib/money/totals";
import { recoveryRateBand, recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { DECLINE_CATEGORY_LABELS, formatStepType } from "~/lib/recovery/labels";

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

/** Steps for Capsomer's setup checklist: each one Done or To do, with its one way to do it until it is done. */
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
        <ButtonLink to="/connect" variant="primary" size="sm">
          Connect
        </ButtonLink>
      ),
    },
    {
      id: "sender",
      title: "Set your sender name",
      detail: "Customers will see this name in recovery emails",
      done: senderNameSet,
      action: (
        <ButtonLink to="/settings" size="sm">
          Go to settings
        </ButtonLink>
      ),
    },
    {
      id: "alerts",
      title: "Set your notification email",
      detail: "We'll send you an alert when a payment is recovered.",
      done: alertAddressSet,
      action: (
        <ButtonLink to="/settings" size="sm">
          Go to settings
        </ButtonLink>
      ),
    },
  ];
}

export const ONBOARDING_READY = {
  title: "You're ready",
  detail: "Foxhound will automatically detect and recover failed payments",
};

/** An icon, the label, the figure and an optional line under it, as a small Capsomer panel (Capsomer's stat tile is always a link or a button, and these cards lead nowhere). */

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
        value={formatAmounts(w.recoveredRevenue)}
      />
      <StatCard
        primary
        icon={iconAlert}
        label="Currently at risk"
        value={formatAmounts(w.atRiskRevenue)}
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

/** The ROI widget's two columns and six lines, on the figures Foxhound bills: attributed recoveries that have matured, with the fee from the pricing constant. The panel title says which recoveries these are, and "fees" not "fees paid", because Foxhound cannot know an invoice was paid from this page. */
export function RoiWidget({ roi }: { roi: { thisMonth: RoiColumn; allTime: RoiColumn } }) {
  const empty = roi.thisMonth.recovered.length === 0 && roi.allTime.recovered.length === 0;
  return (
    <Panel
      title="Foxhound-attributed revenue"
      meta={
        empty
          ? undefined
          : `All time counts recoveries held ${RECOVERY_MATURITY_DAYS} days, the ones Foxhound bills`
      }
    >
      {empty ? (
        <p className="fh-small fh-faint">No attributed recoveries yet.</p>
      ) : (
        <div className="fh-recpanel-pair">
          <div>
            <h3 className="fh-recpanel-title fh-tiny fh-medium fh-quiet fh-caps">This month</h3>
            <dl className="cap-stack" data-gap="3">
              <RoiLine label="Recovered" value={formatAmounts(roi.thisMonth.recovered)} />
              <RoiLine
                label={`Foxhound fee (${RECOVERY_FEE_LABEL}, billed after ${RECOVERY_MATURITY_DAYS} days)`}
                value={formatAmounts(roi.thisMonth.fee)}
              />
              <RoiLine label="You keep" value={formatAmounts(roi.thisMonth.kept)} strong />
            </dl>
          </div>
          <div>
            <h3 className="fh-recpanel-title fh-tiny fh-medium fh-quiet fh-caps">All time</h3>
            <dl className="cap-stack" data-gap="3">
              <RoiLine label="Total recovered" value={formatAmounts(roi.allTime.recovered)} />
              <RoiLine label="Total fees" value={formatAmounts(roi.allTime.fee)} />
              <RoiLine label="Net to you" value={formatAmounts(roi.allTime.kept)} strong />
            </dl>
          </div>
        </div>
      )}
    </Panel>
  );
}

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
                {formatAmounts(w.reactivatedRevenue)}
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
    return <p className="fh-recpanel-empty fh-small fh-faint">Nothing in the queue.</p>;
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

/** The deliverability panel on what Foxhound records. No "delivered" figure or alert: Foxhound stores no delivered event. */
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
