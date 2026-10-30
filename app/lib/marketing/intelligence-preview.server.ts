import { groupSumByCurrency } from "~/lib/money/totals";
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import { buildIntelligenceSeed } from "~/lib/demo/intelligence-seed";
import { buildNarrativeSeed } from "~/lib/demo/narratives-seed";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { planTierPill } from "~/lib/intelligence/customer-directory";
import {
  dayOverDayCents,
  monthKeyOf,
  monthLabel,
  newMrrMonthToDateCents,
  planBreakdownRows,
  signedMoney,
} from "~/lib/intelligence/dashboard";
import { healthScoreBand, type HealthScoreBand } from "~/lib/intelligence/health-band";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";

import type { IntelligencePreview, PreviewBand, PreviewCustomerRow } from "./intelligence-preview";
import { HOUR_MS } from "~/lib/constants";

// The data behind the /product/intelligence previews: the demo account's
// seed, never a merchant's rows. Recova draws these from hand-written numbers
// (IntelligenceDashboardPreview.tsx, blob 11972333; IntelligenceCustomerTable.tsx,
// blob 6ae7c73f; ChurnRiskSummary.tsx, blob ba1fbb51). Foxhound builds the
// Teamflow account its demo runs on (app/lib/demo/, the pure builders, no
// database and no Stripe, in the order seedDemoAccount builds them) and reads
// it the way the merchant Intelligence pages read their own rows:
//
// - Dashboard: the latest MRR snapshot's MRR and active customers, written as
//   the dashboard's StatCards write them; its per-plan MRR through
//   planBreakdownRows, as the dashboard's PlanCard; and the month's report,
//   which for the demo is buildNarrativeSeed's.
// - Customers: listCustomerDirectory's default order, health ascending, with
//   its plan pill (planTierPill) and its MRR cell ("-" with none).
// - Bands: getChurnBands, per healthScoreBand (the engine's 40/70 cutoffs),
//   totaled with groupSumByCurrency.
//
// Strings are formatted here, on the server, so the page renders the same
// text on the server and in the browser.

/** Recova's customer table preview lists five customers. */
const PREVIEW_CUSTOMER_ROWS = 5;
const BAND_ORDER: HealthScoreBand[] = ["at_risk", "watch", "healthy"];

/** Build the preview as of `now`. Pure: the same instant gives the same preview. */
function buildIntelligencePreview(now: Date): IntelligencePreview {
  const customers = buildTeamflowBase(now);
  const recovery = buildRecoverySeed(DEMO_ACCOUNT_ID, customers, now);
  const disputes = buildDisputesSeed(DEMO_ACCOUNT_ID, now, DEMO_MEMBER_EMAIL);
  const seed = buildIntelligenceSeed({
    accountId: DEMO_ACCOUNT_ID,
    now,
    customers,
    failedPayments: recovery.failedPayments,
    recoveredPayments: recovery.recoveredPayments,
    disputes: disputes.disputes,
  });

  // getMrrSnapshotSeries orders by snapshot date; the dashboard reads the last.
  const snapshots = [...seed.mrrSnapshots].sort((a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime());
  const latest = snapshots[snapshots.length - 1];
  const { report } = buildNarrativeSeed({
    accountId: DEMO_ACCOUNT_ID,
    now,
    customers: seed.customerContext,
    latestMrr: latest,
    idPrefix: "d",
  });
  const currency = latest?.currency ?? "usd";
  const daily = snapshots.map((r) => ({ at: r.snapshotDate, totalMrrCents: r.totalMrrCents, newMrrCents: r.newMrrCents ?? 0 }));
  const delta = dayOverDayCents(daily);

  const scored = seed.customerContext.map((c) => ({
    id: c.stripeCustomerId,
    name: c.customerName ?? null,
    tier: c.currentPlanTier ?? null,
    healthScore: c.healthScore ?? null,
    mrrCents: c.mrrContributionCents ?? 0,
    currency: c.currency ?? "usd",
  }));

  // listCustomerDirectory: unscored last, then health ascending. Array sort is
  // stable, so ties keep the seed's order.
  const directory = scored
    .filter((c): c is typeof c & { healthScore: number } => c.healthScore !== null)
    .sort((a, b) => a.healthScore - b.healthScore);
  const rows = directory.slice(0, PREVIEW_CUSTOMER_ROWS).map((c): PreviewCustomerRow => {
    const pill = planTierPill(c.tier);
    return {
      id: c.id,
      name: c.name ?? "(unnamed)",
      planLabel: pill.label,
      planTone: pill.tone ?? null,
      healthScore: c.healthScore,
      band: healthScoreBand(c.healthScore),
      mrr: c.mrrCents > 0 ? formatMoney(c.mrrCents, c.currency) : "-",
    };
  });

  const bands = BAND_ORDER.map((band): PreviewBand => {
    const members = directory.filter((c) => healthScoreBand(c.healthScore) === band);
    // The demo bills in one currency; a second one would be a seed change, and
    // this shows the first, as the Recovery spoke's preview does.
    const [total] = groupSumByCurrency(members.map((c) => ({ currency: c.currency, cents: c.mrrCents })));
    return {
      band,
      customerCount: members.length,
      mrr: formatMoneyShort(total?.cents ?? 0, total?.currency ?? currency),
    };
  });

  return {
    asOf: now.toISOString(),
    dashboard: {
      mrr: formatMoneyShort(latest?.totalMrrCents ?? 0, currency),
      activeCustomers: (latest?.activeCustomersCount ?? 0).toLocaleString("en-US"),
      dayOverDay: delta ? signedMoney(delta, currency) : "--",
      dayOverDaySign: delta ? (delta > 0 ? 1 : -1) : 0,
      newMrrMtd: formatMoneyShort(newMrrMonthToDateCents(daily, now.getTime()), currency),
      currency,
      plans: planBreakdownRows(latest?.perPlanBreakdown ?? null),
      narrativeMonth: monthLabel(monthKeyOf(report.reportMonth)),
      narrative: report.narrative,
    },
    customers: rows,
    bands,
  };
}

// The seed is cheap, but its dates count from `now`, so one preview serves
// every request in the same hour, as the Recovery and Disputes spokes' do.
let cached: { hour: number; preview: IntelligencePreview } | null = null;

export function intelligencePreviewFor(nowMs: number): IntelligencePreview {
  const hour = Math.floor(nowMs / HOUR_MS);
  if (cached?.hour !== hour) cached = { hour, preview: buildIntelligencePreview(new Date(hour * HOUR_MS)) };
  return cached.preview;
}
