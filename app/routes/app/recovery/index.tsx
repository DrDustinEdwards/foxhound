import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { BarChart, GroupedBars, LineArea } from "~/components/charts";
import { StatCard } from "~/components/stat-card";
import { Sparkline } from "~/components/charts";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import {
  getRecoveryDashboardWindow,
  type RecoveryDashboardWindow,
} from "~/lib/dashboard/recovery-window.server";
import { RECOVERY_RANGES, sumCentsByDayWindow, type RecoveryRange } from "~/lib/dashboard/recovery-window";
import { recoveryRateBand, recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { formatMoney } from "~/lib/money-format";
import { formatRelativeFuture, formatTimestamp } from "~/lib/date-format";
import { DECLINE_CATEGORIES } from "~/lib/constants";
import { recoveryFeeCents } from "~/lib/billing/fees";
import { listBillableRecoveredForRoi } from "~/lib/recovery/queries.server";
import { formatStepType } from "~/lib/recovery/labels";

import type { Route } from "./+types/index";

// The Recovery dashboard (TASK-foxhound-recovery-surface-parity.md Phase 2),
// composed on top of Phase 1's getRecoveryDashboardWindow. Dual-range: `data`
// follows the selector, `data30d` is always fixed at 30d (reused when the
// selector is already 30d), exactly matching legacy's page.tsx. Two legacy
// panels do not appear here at all: BenchmarkCard (no recovery_rate_bps rows
// exist or can exist pre-launch) and DeliverabilityPanel (no account-scoped
// delivery/bounce/spam log exists) - both BLOCKED-NO-DATA per the Phase 0
// matrix, not omitted by oversight.

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

  const [data, data30dRaw, lifetimeStats] = await Promise.all([
    getRecoveryDashboardWindow(db, accountId, range, nowMs),
    range === "30d" ? Promise.resolve(null) : getRecoveryDashboardWindow(db, accountId, "30d", nowMs),
    getRecoveryStats(db, accountId, nowMs),
  ]);
  const data30d = data30dRaw ?? data;

  let roi: { thisMonthCents: number; allTimeCents: number; feeThisMonthCents: number; feeAllTimeCents: number; currency: string } | null = null;
  if (data.connection) {
    const now = new Date(nowMs);
    const firstOfMonthUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const [thisMonth, allTime] = await Promise.all([
      listBillableRecoveredForRoi(db, accountId, nowMs, firstOfMonthUtc),
      listBillableRecoveredForRoi(db, accountId, nowMs, null),
    ]);
    const sum = (rows: { amountCents: number }[]) => rows.reduce((s, r) => s + r.amountCents, 0);
    const thisMonthCents = sum(thisMonth);
    const allTimeCents = sum(allTime);
    roi = {
      thisMonthCents,
      allTimeCents,
      feeThisMonthCents: recoveryFeeCents(thisMonthCents),
      feeAllTimeCents: recoveryFeeCents(allTimeCents),
      currency: thisMonth[0]?.currency ?? allTime[0]?.currency ?? "usd",
    };
  }

  const watchingForFailures = Boolean(data.connection) && lifetimeStats.totalFailedCount === 0;

  return { data, data30d, roi, watchingForFailures, range, nowMs };
}

function RangeSelector({ range }: { range: RecoveryRange }) {
  return (
    <div className="flex gap-1.5">
      {RECOVERY_RANGES.map((r) => (
        <Link
          key={r}
          to={`/recovery?range=${r}`}
          aria-current={range === r ? "page" : undefined}
          className={`rounded-md border px-2.5 py-1 font-mono text-micro ${
            range === r
              ? "border-amber bg-amber text-on-amber"
              : "border-border text-text-tertiary hover:border-border-i"
          }`}
        >
          {r}
        </Link>
      ))}
    </div>
  );
}

// "N in recovery", plus the share of MRR that represents when the account has an
// MRR estimate. mrr_estimate_cents was already carried onto the window and was
// never divided or rendered, so the amount at risk had no sense of scale: $4,000
// means something very different at $20k MRR than at $2M.
function atRiskSubtext(w: RecoveryDashboardWindow, atRisk: { cents: number; currency: string } | null): string {
  const inRecovery = `${w.activePaymentsCount} in recovery`;
  const mrr = w.connection?.mrrEstimateCents ?? 0;
  if (!atRisk || mrr <= 0) return inRecovery;
  const pct = Math.round((atRisk.cents / mrr) * 1000) / 10;
  return `${inRecovery} · ${pct}% of MRR`;
}

function StatCardsPrimary({ w }: { w: RecoveryDashboardWindow }) {
  const revenue = w.recoveredRevenue[0] ?? null;
  const atRisk = w.atRiskRevenue[0] ?? null;
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard
        label="Recovered (30d)"
        value={revenue ? formatMoney(revenue.cents, revenue.currency) : "$0.00"}
      />
      <StatCard
        label="Currently at risk"
        value={atRisk ? formatMoney(atRisk.cents, atRisk.currency) : "$0.00"}
        subtext={atRiskSubtext(w, atRisk)}
      />
      <StatCard
        label="Recovery rate"
        value={w.recoveryRatePct === null ? "-" : `${w.recoveryRatePct}%`}
        valueClassName={w.recoveryRatePct === null ? undefined : recoveryRateClassName(w.recoveryRatePct)}
        subtext={`${recoveryRateBand(w.recoveryRatePct)} · ${w.recoveredCount} of ${w.totalFailedCount}`}
      />
    </section>
  );
}

function StatCardsSecondary({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Active sequences" value={String(w.activePaymentsCount)} />
      <StatCard label="Win-backs active" value={String(w.activeWinbacksCount)} />
      <StatCard
        label="Cards expiring"
        value={String(w.expiringCardsCount)}
        valueClassName={w.expiringCardsCount > 0 ? "text-amber-text" : undefined}
      />
      <StatCard
        label="Avg. days to recover"
        value={w.avgDaysToRecovery === null ? "-" : `${w.avgDaysToRecovery}d`}
        subtext={w.avgDaysToRecovery === null ? "No data" : `across ${w.recoveryDaysCount}`}
      />
      <StatCard
        label="Best decline category"
        value={w.bestCategory ? DECLINE_CATEGORY_LABELS[w.bestCategory.cat] : "-"}
        subtext={w.bestCategory ? `${w.bestCategory.rate}% recovered` : "Need more data"}
      />
      {/* One card, engagement as its subtext: the two rates only mean anything
          against the send count they are drawn from. */}
      <StatCard
        label="Emails sent"
        value={String(w.totalEmailsSent)}
        subtext={`${w.openRatePct}% open · ${w.clickRatePct}% click`}
      />
    </section>
  );
}

function RoiWidget({
  roi,
}: {
  roi: { thisMonthCents: number; allTimeCents: number; feeThisMonthCents: number; feeAllTimeCents: number; currency: string };
}) {
  if (roi.thisMonthCents === 0 && roi.allTimeCents === 0) {
    return (
      <section className="rounded-lg border border-border bg-surface p-5">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Foxhound-attributed revenue
        </p>
        <p className="mt-2 text-label text-text-tertiary">
          Nothing Foxhound has attributed and matured yet. Recoveries where a Foxhound action
          provably preceded payment appear here once they have held for 30 days. Stripe-baseline
          recoveries are never billed.
        </p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Foxhound-attributed revenue
      </p>
      <p className="mt-1 text-label text-text-tertiary">
        20% of Foxhound-attributed recoveries, once matured 30 days. Stripe-baseline recoveries are
        free, always.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="font-mono text-micro uppercase tracking-wide text-text-subtle">This month</p>
          <p className="mt-1 font-mono text-title text-text">
            {formatMoney(roi.thisMonthCents, roi.currency)}
          </p>
          <p className="mt-1 text-label text-text-tertiary">
            Fee: {formatMoney(roi.feeThisMonthCents, roi.currency)}
          </p>
          {/* What the merchant kept. The recovered figure minus our fee is the
              whole promise of the pricing model, and it was left for the reader
              to work out. */}
          <p className="mt-1 text-label text-text-secondary">
            You kept: {formatMoney(roi.thisMonthCents - roi.feeThisMonthCents, roi.currency)}
          </p>
        </div>
        <div>
          <p className="font-mono text-micro uppercase tracking-wide text-text-subtle">All time</p>
          <p className="mt-1 font-mono text-title text-text">
            {formatMoney(roi.allTimeCents, roi.currency)}
          </p>
          <p className="mt-1 text-label text-text-tertiary">
            Fee: {formatMoney(roi.feeAllTimeCents, roi.currency)}
          </p>
          <p className="mt-1 text-label text-text-secondary">
            Net to you: {formatMoney(roi.allTimeCents - roi.feeAllTimeCents, roi.currency)}
          </p>
        </div>
      </div>
    </section>
  );
}

function RecoveryRateTrendChart({ w }: { w: RecoveryDashboardWindow }) {
  const firstNonNull = w.recoveryRateDaily.findIndex((p) => p.rate !== null);
  const hasData = firstNonNull !== -1;
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Recovery rate ({w.rangeLabel})
      </p>
      {hasData ? (
        <div className="mt-3 text-green">
          <LineArea
            points={w.recoveryRateDaily.slice(firstNonNull).map((p) => ({
              label: p.date.slice(5),
              value: p.rate ?? 0,
            }))}
          />
        </div>
      ) : (
        <p className="mt-4 text-label text-text-tertiary">
          Not enough data yet. Recovery rate will appear after your first recovery.
        </p>
      )}
    </div>
  );
}

function RevenueTrendChart({ w, nowMs }: { w: RecoveryDashboardWindow; nowMs: number }) {
  const total = w.recoveredRevenue[0] ?? null;
  if (w.recoveredPayments.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Revenue recovered ({w.rangeLabel})
        </p>
        <p className="mt-4 text-label text-text-tertiary">No recoveries in this range yet.</p>
      </div>
    );
  }
  const points = sumCentsByDayWindow(
    w.recoveredPayments.map((p) => ({ date: p.recoveredAt, cents: p.amountCents })),
    w.rangeDays,
    nowMs,
  );
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Revenue recovered ({w.rangeLabel})
      </p>
      <p className="mt-1 font-mono text-title text-text">
        {total ? formatMoney(total.cents, total.currency) : "$0.00"}
      </p>
      <div className="mt-3 text-green">
        <BarChart
          data={points.map((p) => ({ label: p.date.slice(8), value: p.cents / 100 }))}
        />
      </div>
    </div>
  );
}

function DeclineAnalysis({ w }: { w: RecoveryDashboardWindow }) {
  // Every category, in a fixed order, not just the ones with rows. Iterating the
  // breakdown's own keys meant a category with no failures this range vanished
  // from the list entirely, so the list silently changed shape between ranges
  // and a zero was indistinguishable from a category that does not exist.
  const categories = DECLINE_CATEGORIES;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
      <div className="rounded-lg border border-border bg-surface p-4 md:col-span-3">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Decline breakdown ({w.rangeLabel})
        </p>
        {w.totalFailedCount === 0 ? (
          <p className="mt-4 text-label text-text-tertiary">No declined payments yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {categories.map((cat) => {
              const count = w.categoryBreakdown[cat] ?? 0;
              const pct = Math.round((count / w.totalFailedCount) * 100);
              const stats = w.categoryStats[cat];
              // Only claim a recovery rate once there are at least two failures
              // in the category: "100% recovered" off a single payment is noise
              // dressed as a statistic.
              const catRate =
                stats && stats.total >= 2 ? Math.round((stats.recovered / stats.total) * 100) : null;
              const spark = w.categorySparkline[cat] ?? [];
              return (
                <li key={cat} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-label text-text-secondary">
                    {DECLINE_CATEGORY_LABELS[cat]}
                  </span>
                  <div className="h-1.5 flex-1 rounded-full bg-border">
                    <div className="h-full rounded-full bg-text-tertiary" style={{ width: `${pct}%` }} />
                  </div>
                  {/* The trailing-30-day shape for this category. Computed by
                      recovery-window.server.ts all along and rendered nowhere. */}
                  <span className="shrink-0 text-text-tertiary" aria-hidden="true">
                    <Sparkline values={spark.map((point) => point.count)} width={56} height={16} />
                  </span>
                  <span className="w-28 shrink-0 text-right font-mono text-micro text-text-tertiary">
                    {count} ({pct}%)
                    {catRate === null ? null : ` · ${catRate}% rec`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface p-4 md:col-span-2">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Email engagement by category
        </p>
        {w.emailCategoryPerformance.length === 0 ? (
          <p className="mt-4 text-label text-text-tertiary">No recovery emails sent yet.</p>
        ) : (
          <div className="mt-3 text-text-tertiary">
            <GroupedBars
              labels={w.emailCategoryPerformance.map((p) => DECLINE_CATEGORY_LABELS[p.category])}
              series={[
                {
                  name: "Open rate",
                  colorClassName: "text-green",
                  values: w.emailCategoryPerformance.map((p) => p.openRatePct),
                },
                {
                  name: "Click rate",
                  colorClassName: "text-blue",
                  values: w.emailCategoryPerformance.map((p) => p.clickRatePct),
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function RecoveryTimingChart({ w }: { w: RecoveryDashboardWindow }) {
  const total = w.recoveryTimingBuckets.reduce((s, b) => s + b.count, 0);
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Recovery timing (30d)
      </p>
      {total === 0 ? (
        <p className="mt-4 text-label text-text-tertiary">No recoveries yet.</p>
      ) : (
        <div className="mt-3 text-green">
          <BarChart
            data={w.recoveryTimingBuckets.map((b) => ({ label: b.dayBucket, value: b.count }))}
            topLabel={(_, i) => `${w.recoveryTimingBuckets[i].percentage}%`}
          />
        </div>
      )}
    </div>
  );
}

function WinBackPanel({ w }: { w: RecoveryDashboardWindow }) {
  const revenue = w.reactivatedRevenue[0] ?? null;
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Win-back attribution ({w.rangeLabel})
      </p>
      {w.reactivatedCount === 0 ? (
        <p className="mt-4 text-label text-text-tertiary">
          No reactivations yet. Foxhound reaches out for 7 days after a cancellation.
        </p>
      ) : (
        <>
          <p className="mt-2 text-body text-text">
            <span className="font-mono text-title text-purple">{w.reactivatedCount}</span>{" "}
            customer{w.reactivatedCount === 1 ? "" : "s"} reactivated
          </p>
          {revenue ? (
            <p className="mt-1 text-label text-text-tertiary">
              {formatMoney(revenue.cents, revenue.currency)} monthly revenue recovered
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function RecoveryQueuePanel({ w, nowMs }: { w: RecoveryDashboardWindow; nowMs: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Recovery queue (next 48h)
      </p>
      {w.upcomingSteps.length === 0 ? (
        <p className="mt-4 text-label text-text-tertiary">
          Nothing in the queue. All your recent payments came through clean.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {w.upcomingSteps.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 border-b border-border-sub pb-2 last:border-0">
              <div>
                <p className="text-label text-text">{s.customerName ?? s.customerEmail}</p>
                <p className="text-micro text-text-subtle">{formatStepType(s.stepType)}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-label text-text">{formatMoney(s.amountCents, s.currency)}</p>
                <p className="text-micro text-text-subtle">
                  {formatRelativeFuture(s.scheduledAt, nowMs) ?? formatTimestamp(s.scheduledAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PaymentsPreview({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Recent activity
        </p>
        <Link to="/recovery/payments" className="text-label text-amber-text hover:underline">
          View all payments
        </Link>
      </div>
      {w.recentPayments.length === 0 ? (
        <p className="mt-4 text-label text-text-tertiary">
          No failed payments yet. Foxhound will list every failed payment it detects here.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {w.recentPayments.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 border-b border-border-sub pb-2 last:border-0">
              <Link to={`/recovery/payments/${p.id}`} className="min-w-0 flex-1">
                <p className="truncate text-label text-text hover:text-amber">
                  {p.customerName ?? p.customerEmail}
                  {(w.previousFailureCounts[p.stripeCustomerId] ?? 0) > 0 ? (
                    <span className="ml-2 text-micro text-text-subtle">
                      +{w.previousFailureCounts[p.stripeCustomerId]} prior
                    </span>
                  ) : null}
                </p>
              </Link>
              <p className="font-mono text-label text-text-tertiary">
                {formatMoney(p.amountCents, p.currency)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RecoveryDashboard({ loaderData }: Route.ComponentProps) {
  const { data, data30d, roi, watchingForFailures, range, nowMs } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title font-medium text-text">Recovery</h1>
          <p className="mt-1 text-label text-text-tertiary">
            {data.connection
              ? `Connected · ${data.connection.name ?? data.connection.stripeUserId}`
              : "No Stripe account connected"}
          </p>
        </div>
        {data.connection ? (
          <div className="flex flex-col items-end gap-1.5">
            <RangeSelector range={range} />
            {data.webhookHealth ? (
              <Badge tone={data.webhookHealth.tone}>{data.webhookHealth.label}</Badge>
            ) : null}
            {data.lastRecoveryAgo ? (
              <p className="text-micro text-text-subtle">
                Last recovery <span className="text-green">{data.lastRecoveryAgo}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {!data.connection ? (
        <div className="mt-6 rounded-lg border border-border bg-surface p-6 text-center">
          <p className="text-body font-medium text-text">Connect Stripe to start recovering payments</p>
          <p className="mt-2 text-label text-text-tertiary">
            Foxhound watches for failed payments the moment Stripe is connected.
          </p>
          <Link
            to="/connect"
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-amber px-5 py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
          >
            Connect Stripe
          </Link>
        </div>
      ) : (
        <>
          {watchingForFailures ? (
            <div className="mt-6 rounded-lg border border-border bg-surface px-6 py-3.5">
              <p className="text-label font-medium text-text">We&apos;re watching for failed payments.</p>
              <p className="mt-1 text-label text-text-subtle">
                Stripe is connected. The first failed renewal or one-time charge will appear here
                within minutes of the decline. No action needed until then.
              </p>
            </div>
          ) : null}

          <div className="mt-6">
            <StatCardsPrimary w={data30d} />
          </div>

          {roi ? (
            <div className="mt-5">
              <RoiWidget roi={roi} />
            </div>
          ) : null}

          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <RecoveryRateTrendChart w={data} />
            <RevenueTrendChart w={data} nowMs={nowMs} />
          </div>

          <div className="mt-5">
            <p className="mb-3 font-mono text-micro font-medium uppercase tracking-wide text-text-tertiary">
              Decline analysis
            </p>
            <DeclineAnalysis w={data} />
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <RecoveryTimingChart w={data30d} />
            <WinBackPanel w={data} />
          </div>

          <div className="mt-5">
            <RecoveryQueuePanel w={data} nowMs={nowMs} />
          </div>

          <div className="mt-5">
            <StatCardsSecondary w={data30d} />
          </div>

          <div className="mt-5">
            <PaymentsPreview w={data} />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Link
              to="/recovery/sequences"
              className="rounded-lg border border-border bg-surface p-4 hover:border-border-i"
            >
              <p className="text-body font-medium text-text">Sequences</p>
              <p className="mt-1 text-label text-text-tertiary">Recovery sequences in progress.</p>
            </Link>
            <Link
              to="/recovery/winback"
              className="rounded-lg border border-border bg-surface p-4 hover:border-border-i"
            >
              <p className="text-body font-medium text-text">Win-back</p>
              <p className="mt-1 text-label text-text-tertiary">Active win-back outreach.</p>
            </Link>
            <Link
              to="/recovery/expiring-cards"
              className="rounded-lg border border-border bg-surface p-4 hover:border-border-i"
            >
              <p className="text-body font-medium text-text">Expiring cards</p>
              <p className="mt-1 text-label text-text-tertiary">Cards expiring soon, before they fail.</p>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
