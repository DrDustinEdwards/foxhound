import { formatDate } from "capsomer/behavior/time";
import { groupSumByCurrency } from "~/lib/money/totals";
import type { DisputeState } from "~/lib/constants";
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import {
  daysUntilDeadline,
  deadlineUrgency,
  disputeListStatus,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { computeDisputeStats, winRateCard } from "~/lib/disputes/stats";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { formatAmounts, type CurrencyAmount } from "~/lib/money/totals";
import { hourlyPreview } from "./hourly-preview";

import type { DisputesPreview, PreviewDisputeRow } from "./disputes-preview";

// The data behind the /product/disputes previews: the demo account's seed, never a merchant's rows. Foxhound builds the Teamflow
// disputes its demo runs on (buildDisputesSeed, pure) and reads them the way the merchant dashboard
// (app/routes/app/disputes/index.tsx) does: newest first; the five cards from computeDisputeStats, totaled
// per currency with groupSumByCurrency and written with formatAmounts (Win rate's words from winRateCard); status words from
// disputeListStatus, with "has evidence" decided from the evidence rows by getDisputesWithEvidence's own test; deadline days and
// bands from daysUntilDeadline and deadlineUrgency. Strings are formatted here, on the server, so server and browser render the same text.

const PREVIEW_TABLE_ROWS = 6;

/** "Fees owed" for the demo account, which the dashboard reads from billing records a preview does not have. Nothing is owed: the
 *  pending half never includes a demo account (the demo_ id prefix is excluded) and the one seeded invoice is paid, so the card
 *  reads $0.00, as the demo dashboard does. */
const DEMO_FEES_OWED: CurrencyAmount[] = [];

function buildDisputesPreview(now: Date): DisputesPreview {
  const nowMs = now.getTime();
  const seed = buildDisputesSeed(DEMO_ACCOUNT_ID, now, DEMO_MEMBER_EMAIL);
  const withEvidence = new Set(
    seed.disputeEvidence.filter((e) => e.fieldValue.trim() !== "").map((e) => e.disputeId),
  );
  const seeded = seed.disputes.map((d) => ({
    id: d.id as string,
    customerName: d.customerName ?? null,
    customerEmail: d.customerEmail ?? null,
    amountCents: d.amountCents,
    currency: d.currency ?? "usd",
    reason: d.reason ?? null,
    state: d.state as DisputeState,
    status: d.status,
    createdAt: d.createdAt as Date,
    evidenceDeadline: d.evidenceDeadline ?? null,
    submittedAt: d.submittedAt ?? null,
    submittedBy: d.submittedBy ?? null,
    resolvedFeeCents: d.resolvedFeeCents ?? null,
    triageRecommendation: d.triageRecommendation ?? null,
    triageConfidence: d.triageConfidence ?? null,
  }));
  const ordered = seeded.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const stats = computeDisputeStats(ordered);

  const rows = ordered.map((d): PreviewDisputeRow => {
    const resolved = isDisputeResolved(d.state);
    const days = resolved ? null : daysUntilDeadline(d.evidenceDeadline, nowMs);
    const status = disputeListStatus({
      state: d.state,
      submittedBy: d.submittedBy,
      hasEvidence: withEvidence.has(d.id),
      stripeStatus: d.status,
    });
    return {
      id: d.id,
      customer: d.customerName ?? d.customerEmail ?? "Unknown",
      email: d.customerName ? d.customerEmail : null,
      amount: formatMoney(d.amountCents, d.currency),
      reason: humanizeDisputeReason(d.reason),
      stateLabel: status.label,
      stateTone: status.tone,
      resolved,
      deadlineDays: days,
      deadlineUrgency: deadlineUrgency(days),
      deadlineDate: formatDate(d.evidenceDeadline, { style: "monthDay" }) ?? "",
      triage:
        d.triageRecommendation === "fight" || d.triageRecommendation === "accept"
          ? { recommendation: d.triageRecommendation, confidence: d.triageConfidence }
          : null,
    };
  });

  const winRate = winRateCard(stats);
  return {
    asOf: now.toISOString(),
    stats: {
      openCount: stats.openCount,
      atStake: formatAmounts(groupSumByCurrency(stats.atStakeParts)),
      submittedByFoxhound: stats.submittedByFoxhoundCount,
      feesOwed: formatAmounts(groupSumByCurrency(DEMO_FEES_OWED)),
      winRate: winRate.value,
      winRateSubtext: winRate.subtext,
    },
    dashboard: rows,
    table: rows.slice(0, PREVIEW_TABLE_ROWS),
  };
}

export const disputesPreviewFor = hourlyPreview(buildDisputesPreview);
