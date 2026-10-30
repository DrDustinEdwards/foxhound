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
import "./dashboard.css";
import { ArrowRight } from "lucide-react";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { PageHead } from "capsomer/react/page-head";
import { Status } from "capsomer/react/status";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
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
import { listStepsForFailedPayments } from "~/lib/recovery/queries.server";
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
  OnboardingChecklist,
  StatCardsPrimary,
  StatCardsSecondary,
  RoiWidget,
  WinBackCard,
  RecoveryQueue,
  DeliverabilityPanel,
  PaymentsTable,
} from "../../../components/recovery-dashboard-panels";

// /recovery/dashboard (row S5, job J74). Recova is the spec: its page,
// app/(app)/recovery/dashboard/page.tsx at blob 208b0066, and every component
// it renders, each read whole at the blob J74 names (StatCards b1923468,
// ROIWidget 549b89ef, DeclineBreakdown 79b7de3f, DeclineSparkline a7ce51f5,
// RecoveryQueue c84fdca1, WinBackCard 10cf28fb, BenchmarkCard 0efb234c,
// DeliverabilityPanel 87a88d88, OnboardingChecklist f4284965, PaymentsTable
// 3dc398a2, RecoveryRateChart 52e207d6, RecoveryTimingChart f635f08d,
// EmailCategoryChart b4ed4bef, RevenueChart 2932dac5, DynamicCharts 8a5510e6),
// with lib/dashboard-data.ts at e1dfbcaa and components/recovery/PaymentRow.tsx
// at 0d2e1f52. In Recova's order: the getting-started checklist or the
// watching banner, the head, the primary stats, the ROI widget, the two
// time-series panels, decline analysis, timing beside win-back, the queue, the
// secondary stats, then the failed-payments table.
//
// Built from Capsomer 0.9.0's parts (Q10) with every chart drawn by Enarratio
// (Q1), amber throughout. No Foxhound CSS sits over a Capsomer component;
// dashboard.css only hides Enarratio's gridlines, which Recova's charts never
// drew. Recova's per-category colors, its green and red figures inside
// panels, and its 12px radius wait for Capsomer's per-site layer (capsomer
// job_ec5ec0754626), listed in the J74 pull request.
//
// Two Recova panels are not here, each for a reason in the source:
// BenchmarkCard renders only from a benchmark_data row with metric_name
// recovery_rate_bps in the industry or all_merchants cohort; Foxhound's
// benchmark_data holds only the seeded leakage estimator rows, and nothing
// writes a recovery-rate row, so the card could never render (the docs say the
// dashboard shows no outside benchmark); and the open-disputes card shows only
// when the Disputes product is inactive, which cannot happen here, because
// Disputes has no product gate in Foxhound (app/lib/nav/manifest.ts).
//
// The deliverability panel is Recova's on what Foxhound records: sends from
// email_sends, bounces and spam complaints from the suppressions the Email
// Service events consumer writes. Foxhound stores no delivered event, so
// Recova's delivered rate and the alert built on it are not shown. The
// consumer does not yet know which account an event belongs to (it writes
// account_id null), so until it maps an event back through email_sends the
// panel shows its empty state, worded to promise nothing.
//
// Recova's page also set accounts.onboarding_completed once all three
// checklist steps were done, so the checklist stayed gone afterwards; Foxhound
// recomputes it on every load, so clearing the sender name brings it back.

export function meta() {
  return [{ title: "Recovery - Foxhound" }];
}

function parseRange(value: string | null): RecoveryRange {
  return (RECOVERY_RANGES as readonly string[]).includes(value ?? "") ? (value as RecoveryRange) : "30d";
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const nowMs = Date.now();
  const range = parseRange(new URL(request.url).searchParams.get("range"));

  // `data` follows the range selector; `data30d` is always 30 days, for the
  // stat cards and the timing chart, and is the same read when the range is
  // already 30d, as in Recova's page.
  const [data, data30dRaw, lifetimeStats, profile] = await Promise.all([
    getRecoveryDashboardWindow(db, accountId, range, nowMs),
    range === "30d" ? Promise.resolve(null) : getRecoveryDashboardWindow(db, accountId, "30d", nowMs),
    getRecoveryStats(db, accountId, nowMs),
    getDashboardOnboardingProfile(db, accountId),
  ]);
  const data30d = data30dRaw ?? data;

  let roi: { thisMonth: RoiColumn; allTime: RoiColumn } | null = null;
  if (data.connection) {
    const now = new Date(nowMs);
    const firstOfMonthUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // This month is every attributed recovery since the 1st, matured or not,
    // as Recova's column was; all time is what Foxhound bills (matured).
    const [thisMonth, allTime] = await Promise.all([
      listAttributedRecoveredSince(db, accountId, firstOfMonthUtc),
      listBillableRecoveredForRoi(db, accountId, nowMs, null),
    ]);
    roi = { thisMonth: roiColumn(thisMonth), allTime: roiColumn(allTime) };
  }

  const deliverability = await getDeliverabilityCounts(db, accountId, resolveRangeCutoff(range, nowMs).cutoffMs);

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
  // Recova's banner: connected, onboarding out of the way, and no failed
  // payment ever recorded (renewal noise excluded).
  const watchingForFailures = onboarding.connected && !onboarding.needed && lifetimeStats.totalFailedCount === 0;

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

// ---- Page ----

export default function RecoveryDashboard({ loaderData }: Route.ComponentProps) {
  const { data, data30d, roi, onboarding, watchingForFailures, range, nowMs, queueHours, paymentSteps, deliverability } =
    loaderData;
  const hasBanners = onboarding.needed || watchingForFailures;

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10, with
  // its banners above it in the same column. The shell owns the page's one
  // <main> (ruling 146), so this is a plain wrapper.
  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 pb-8 md:px-8 md:pb-10">
      {hasBanners ? (
        <div className="mt-6">
          {onboarding.needed ? (
            <OnboardingChecklist {...onboarding} />
          ) : null}
          {watchingForFailures ? (
            <Banner tone="neutral" title="We're watching for failed payments.">
              Stripe is connected. The first failed renewal or one-time charge will appear here within minutes of
              the decline. No action needed until then.
            </Banner>
          ) : null}
        </div>
      ) : null}

      <div className="mb-7 pt-8 md:pt-10">
        <PageHead
          title="Dashboard"
          lead={
            data.connection
              ? `Connected · ${data.connection.name ?? data.connection.stripeUserId}`
              : "No Stripe account connected"
          }
          actions={
            data.connection ? (
              <div className="flex flex-col items-end gap-1.5">
                <RangeSelector range={range} />
                {data.webhookHealth ? (
                  <Status tone={WEBHOOK_TONE[data.webhookHealth.tone]}>{data.webhookHealth.label}</Status>
                ) : null}
                {data.lastRecoveryAgo ? (
                  <p className="m-0 text-micro text-text-subtle">
                    Last recovery <span className="text-success-text">{data.lastRecoveryAgo}</span>
                  </p>
                ) : null}
              </div>
            ) : null
          }
        />
      </div>

      {/* ROW 1: primary stat cards, always 30 days. */}
      <div className="mb-5">
        <StatCardsPrimary w={data30d} />
      </div>

      {/* ROW 2: ROI widget. */}
      {roi ? (
        <div className="mb-5">
          <RoiWidget roi={roi} />
        </div>
      ) : null}

      {/* ROW 3: the time series, on the selected range. */}
      <div className="mb-5 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        <RecoveryRateChart w={data} />
        <RevenueChart w={data} nowMs={nowMs} />
      </div>

      {/* ROW 4: decline analysis, 3/2. */}
      <div className="mb-5">
        <p className="m-0 mb-3 text-micro font-medium uppercase tracking-wide text-text-tertiary">Decline analysis</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <div className="min-w-0 md:col-span-3">
            <DeclineBreakdown w={data} />
          </div>
          <div className="min-w-0 md:col-span-2">
            <EmailCategoryChart w={data} />
          </div>
        </div>
      </div>

      {/* ROW 5: timing (always 30 days) beside win-back (the range). */}
      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <RecoveryTimingChart w={data30d} />
        <WinBackCard w={data} />
      </div>

      {/* ROW 6: the recovery queue. */}
      <div className="mb-5">
        <RecoveryQueue w={data} nowMs={nowMs} hours={queueHours} />
      </div>

      {/* ROW 7: secondary stat cards, always 30 days. */}
      <div className="mb-5">
        <StatCardsSecondary w={data30d} />
      </div>

      {/* ROW 8: email deliverability (range-controlled). */}
      <DeliverabilityPanel counts={deliverability} rangeLabel={data.rangeLabel} />

      {/* ROW 9: failed payments. */}
      <PaymentsTable w={data} steps={paymentSteps} nowMs={nowMs} />
      <div className="mt-3 text-right">
        <Link to="/recovery/payments" aria-label="View all failed payments" className="text-label text-brand-text">
          View all payments <ArrowRight className="inline-block" size={13} strokeWidth={1.5} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
