import { formatCount } from "@drdustinedwards/site-helpers/text";
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
  monthLabel,
  newMrrMonthToDateCents,
  planBreakdownRows,
  signedMoney,
} from "~/lib/intelligence/dashboard";
import { monthKey } from "@dustinedwards/site-runtime/time";
import { healthScoreBand, type HealthScoreBand } from "~/lib/intelligence/health-band";
import { formatMoney, formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { hourlyPreview } from "./hourly-preview";

import type { IntelligencePreview, PreviewBand, PreviewCustomerRow } from "./intelligence-preview";

// The data behind the /product/intelligence previews: the demo account's seed, never a merchant's rows. Foxhound builds the Teamflow
// account its demo runs on (app/lib/demo/, pure builders) and reads it the way the merchant Intelligence pages do: Dashboard from
// the latest MRR snapshot (as the StatCards write it), planBreakdownRows and the month's report (buildNarrativeSeed's);
// Customers from listCustomerDirectory's default order (health ascending) with planTierPill and an MRR cell ("-" with none);
// Bands from getChurnBands per healthScoreBand (the 40/70 cutoffs), totaled with groupSumByCurrency. Strings are formatted here,
// on the server, so server and browser render the same text.

const PREVIEW_CUSTOMER_ROWS = 5;
const BAND_ORDER: HealthScoreBand[] = ["at_risk", "watch", "healthy"];

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

  const snapshots = [...seed.mrrSnapshots].sort(
    (a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime(),
  );
  const latest = snapshots[snapshots.length - 1];
  const { report } = buildNarrativeSeed({
    accountId: DEMO_ACCOUNT_ID,
    now,
    customers: seed.customerContext,
    latestMrr: latest,
    idPrefix: "d",
  });
  const currency = latest?.currency ?? "usd";
  const daily = snapshots.map((r) => ({
    at: r.snapshotDate,
    totalMrrCents: r.totalMrrCents,
    newMrrCents: r.newMrrCents ?? 0,
  }));
  const delta = dayOverDayCents(daily);

  const scored = seed.customerContext.map((c) => ({
    id: c.stripeCustomerId,
    name: c.customerName ?? null,
    tier: c.currentPlanTier ?? null,
    healthScore: c.healthScore ?? null,
    mrrCents: c.mrrContributionCents ?? 0,
    currency: c.currency ?? "usd",
  }));

  // listCustomerDirectory: unscored last, then health ascending. Array sort is stable, so ties keep the seed's order.
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
    // The demo bills in one currency; a second would be a seed change.
    const [total] = groupSumByCurrency(
      members.map((c) => ({ currency: c.currency, cents: c.mrrCents })),
    );
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
      activeCustomers: formatCount(latest?.activeCustomersCount ?? 0),
      dayOverDay: delta ? signedMoney(delta, currency) : "--",
      dayOverDaySign: delta ? (delta > 0 ? 1 : -1) : 0,
      newMrrMtd: formatMoneyShort(newMrrMonthToDateCents(daily, now.getTime()), currency),
      currency,
      plans: planBreakdownRows(latest?.perPlanBreakdown ?? null),
      narrativeMonth: monthLabel(monthKey(report.reportMonth)),
      narrative: report.narrative,
    },
    customers: rows,
    bands,
  };
}

export const intelligencePreviewFor = hourlyPreview(buildIntelligencePreview);
