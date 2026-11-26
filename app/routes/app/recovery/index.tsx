import { Icon, iconArrowRight } from "capsomer/react/icons";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/empty.css";
import "capsomer/meter.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";
import "capsomer/table.css";
import "capsomer/tabs.css";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { PageHead } from "capsomer/react/page-head";
import { Status } from "capsomer/react/status";
import { SetupChecklist } from "capsomer/react/setup-checklist";
import { accountScope } from "~/lib/auth/context";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import {
  getRecoveryDashboardWindow,
  UPCOMING_STEPS_WINDOW_MS,
} from "~/lib/dashboard/recovery-window.server";
import {
  RECOVERY_RANGES,
  resolveRangeCutoff,
  type RecoveryRange,
} from "~/lib/dashboard/recovery-window";
import {
  hoursFromMs,
  onboardingChecklistState,
  paymentStepSummary,
  roiColumn,
  type PaymentStepSummary,
  type RoiColumn,
} from "~/lib/dashboard/recovery-dashboard";
import { listStepsForFailedPayments } from "~/lib/recovery/step-queries.server";
import {
  getDashboardOnboardingProfile,
  getDeliverabilityCounts,
  listAttributedRecoveredSince,
  listBillableRecoveredForRoi,
} from "~/lib/recovery/dashboard-queries.server";
import { formatStepType } from "~/lib/recovery/labels";
import type { Route } from "./+types/index";
import {
  RecoveryRateChart,
  RevenueChart,
  DeclineBreakdown,
  EmailCategoryChart,
  RecoveryTimingChart,
} from "../../../components/recovery-dashboard-charts";
import {
  WEBHOOK_TONE,
  RangeSelector,
  onboardingSteps,
  ONBOARDING_READY,
  StatCardsPrimary,
  StatCardsSecondary,
  RoiWidget,
  WinBackCard,
  RecoveryQueue,
  DeliverabilityPanel,
} from "../../../components/recovery-dashboard-panels";
import { PaymentsTable } from "../../../components/recovery-dashboard-payments";
import { noindexMeta } from "~/lib/seo/meta";

// /recovery/dashboard: the getting-started checklist or the watching banner, the head, the primary stats, the ROI widget, the two time-series panels, decline analysis, timing beside win-back, the queue, the secondary stats, then the failed-payments table. Every chart is Enarratio's; components/charts.css hides Enarratio's gridlines and the frame's title under a Panel heading.
// No benchmark card: nothing writes a recovery-rate benchmark, so it could never render (the docs say the dashboard shows no outside benchmark). No open-disputes card: it shows only when the Disputes product is inactive, which cannot happen here (app/lib/nav/manifest.ts).
// The deliverability panel: sends from email_sends, bounces and spam complaints from the suppressions the Email Service events consumer writes. Foxhound stores no delivered event, so no delivered rate or alert. The consumer does not yet know which account an event belongs to (it writes account_id null), so until it maps an event back through email_sends the panel shows its empty state, worded to promise nothing.
// The checklist is recomputed on every load (not latched by accounts.onboarding_completed), so clearing the sender name brings it back.

export const meta = noindexMeta("Recovery - Foxhound");

function parseRange(value: string | null): RecoveryRange {
  return (RECOVERY_RANGES as readonly string[]).includes(value ?? "")
    ? (value as RecoveryRange)
    : "30d";
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, accountId } = accountScope(context);
  const nowMs = Date.now();
  const range = parseRange(new URL(request.url).searchParams.get("range"));

  // `data` follows the range selector; `data30d` is always 30 days, for the stat cards and the timing chart, and is the same read when the range is already 30d.
  const [data, data30dRaw, lifetimeStats, profile] = await Promise.all([
    getRecoveryDashboardWindow(db, accountId, range, nowMs),
    range === "30d"
      ? Promise.resolve(null)
      : getRecoveryDashboardWindow(db, accountId, "30d", nowMs),
    getRecoveryStats(db, accountId, nowMs),
    getDashboardOnboardingProfile(db, accountId),
  ]);
  const data30d = data30dRaw ?? data;

  let roi: { thisMonth: RoiColumn; allTime: RoiColumn } | null = null;
  if (data.connection) {
    const now = new Date(nowMs);
    const firstOfMonthUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // This month is every attributed recovery since the 1st, matured or not; all time is what Foxhound bills (matured).
    const [thisMonth, allTime] = await Promise.all([
      listAttributedRecoveredSince(db, accountId, firstOfMonthUtc),
      listBillableRecoveredForRoi(db, accountId, nowMs, null),
    ]);
    roi = { thisMonth: roiColumn(thisMonth), allTime: roiColumn(allTime) };
  }

  const deliverability = await getDeliverabilityCounts(
    db,
    accountId,
    resolveRangeCutoff(range, nowMs).cutoffMs,
  );

  const stepRows = await listStepsForFailedPayments(
    db,
    accountId,
    data.recentPayments.map((p) => p.id),
  );
  const paymentSteps: Record<string, PaymentStepSummary> = {};
  for (const p of data.recentPayments) {
    paymentSteps[p.id] = paymentStepSummary(
      stepRows.filter((s) => s.failedPaymentId === p.id),
      formatStepType,
    );
  }

  const onboarding = onboardingChecklistState(profile, Boolean(data.connection));
  // The banner: connected, onboarding out of the way, and no failed payment ever recorded (renewal noise excluded).
  const watchingForFailures =
    onboarding.connected && !onboarding.needed && lifetimeStats.totalFailedCount === 0;

  return {
    data,
    data30d,
    roi,
    onboarding,
    watchingForFailures,
    range,
    nowMs,
    queueHours: hoursFromMs(UPCOMING_STEPS_WINDOW_MS),
    paymentSteps,
    deliverability,
  };
}

export default function RecoveryDashboard({ loaderData }: Route.ComponentProps) {
  const {
    data,
    data30d,
    roi,
    onboarding,
    watchingForFailures,
    range,
    nowMs,
    queueHours,
    paymentSteps,
    deliverability,
  } = loaderData;
  const hasBanners = onboarding.needed || watchingForFailures;

  // max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10, with its banners above it in the same column. The shell owns the page's one <main>, so this is a plain wrapper.
  return (
    <div className="fh-recovery cap-admin-page" data-width="page">
      {hasBanners ? (
        <div className="fh-recovery-banner">
          {onboarding.needed ? (
            <SetupChecklist steps={onboardingSteps(onboarding)} ready={ONBOARDING_READY} />
          ) : null}
          {watchingForFailures ? <Banner tone="neutral" title="No failed payments yet." /> : null}
        </div>
      ) : null}

      <div className="fh-recovery-head">
        <PageHead
          title="Dashboard"
          actions={
            data.connection ? (
              <div className="fh-recovery-head-end">
                <p className="fh-tiny fh-faint">
                  Connected &middot; {data.connection.name ?? data.connection.stripeUserId}
                </p>
                <RangeSelector range={range} />
                {data.webhookHealth ? (
                  <Status tone={WEBHOOK_TONE[data.webhookHealth.tone]}>
                    {data.webhookHealth.label}
                  </Status>
                ) : null}
                {data.lastRecoveryAgo ? (
                  <p className="fh-tiny fh-faint">
                    Last recovery <span className="fh-success">{data.lastRecoveryAgo}</span>
                  </p>
                ) : null}
              </div>
            ) : null
          }
        />
      </div>

      {/* ROW 1: primary stat cards, always 30 days. */}
      <div className="fh-recovery-block">
        <StatCardsPrimary w={data30d} />
      </div>

      {/* ROW 2: ROI widget. */}
      {roi ? (
        <div className="fh-recovery-block">
          <RoiWidget roi={roi} />
        </div>
      ) : null}

      {/* ROW 3: the time series, on the selected range. */}
      <div className="fh-recovery-pair">
        <RecoveryRateChart w={data} />
        <RevenueChart w={data} nowMs={nowMs} />
      </div>

      {/* ROW 4: decline analysis, 3/2. */}
      <div className="fh-recovery-block">
        <p className="fh-recovery-label fh-tiny fh-medium fh-quiet fh-caps">Decline analysis</p>
        <div className="fh-recovery-declines">
          <div className="fh-recovery-declines-main">
            <DeclineBreakdown w={data} />
          </div>
          <div className="fh-recovery-declines-side">
            <EmailCategoryChart w={data} />
          </div>
        </div>
      </div>

      {/* ROW 5: timing (always 30 days) beside win-back (the range). */}
      <div className="fh-recovery-charts">
        <RecoveryTimingChart w={data30d} />
        <WinBackCard w={data} />
      </div>

      {/* ROW 6: the recovery queue. */}
      <div className="fh-recovery-block">
        <RecoveryQueue w={data} nowMs={nowMs} hours={queueHours} />
      </div>

      {/* ROW 7: secondary stat cards, always 30 days. */}
      <div className="fh-recovery-block">
        <StatCardsSecondary w={data30d} />
      </div>

      {/* ROW 8: email deliverability (range-controlled). */}
      <DeliverabilityPanel counts={deliverability} rangeLabel={data.rangeLabel} />

      {/* ROW 9: failed payments. */}
      <PaymentsTable w={data} steps={paymentSteps} nowMs={nowMs} />
      <div className="fh-recovery-more fh-right">
        <Link
          to="/recovery/payments"
          aria-label="View all failed payments"
          className="fh-small fh-brand"
        >
          View all payments{" "}
          <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-inline-icon" />
        </Link>
      </div>
    </div>
  );
}
