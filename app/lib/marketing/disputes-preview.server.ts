import { groupSumByCurrency } from "~/lib/money/totals";
import type { DisputeState } from "~/lib/constants";
import { formatDateMonthDay } from "~/lib/date-format";
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import {
  daysUntilDeadline,
  deadlineUrgency,
  disputeListStatus,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { sortDisputesNewestFirst } from "~/lib/disputes/order";
import { computeDisputeStats, winRateCard, type MoneyPart } from "~/lib/disputes/stats";
import { formatAmounts, formatMoney } from "~/lib/money-format";

import type { DisputesPreview, PreviewDisputeRow } from "./disputes-preview";
import { HOUR_MS } from "~/lib/constants";

// The data behind the /product/disputes previews: the demo account's
// seed, never a merchant's rows. Recova draws these from a hand-written
// eight-dispute array (DisputesDashboardPreview.tsx, blob dcde195e), a second
// hand-written six-row array (DisputesTablePreview.tsx, blob ed33fa95) and
// typed stat values (page.tsx's DisputesStatCardsPreview, blob c412d54f), so
// its three figures disagree with each other. Foxhound builds the Teamflow
// disputes its demo runs on (buildDisputesSeed, pure, no database and no
// Stripe) and reads them the way the merchant dashboard
// (app/routes/app/disputes/index.tsx) reads its own rows:
//
// - The order: sortDisputesNewestFirst, the order listDisputes returns.
// - The cards: the dashboard's five, from computeDisputeStats, totaled per
//   currency with groupSumByCurrency and written with formatAmounts, and Win
//   rate's words from winRateCard.
// - The status words: disputeListStatus, with "has evidence" decided from the
//   seed's evidence rows by getDisputesWithEvidence's own test (a non-blank
//   field value).
// - Deadline days and bands: daysUntilDeadline and deadlineUrgency.
//
// Strings are formatted here, on the server, so the page renders the same
// text on the server and in the browser.

/** Recova's dispute table preview lists six disputes. */
const PREVIEW_TABLE_ROWS = 6;

/**
 * "Fees owed" for the demo account, which the dashboard reads from billing
 * records (getDisputeFeesOwed) that a preview with no database does not have.
 * It is what the dashboard shows for the demo, and for the same two reasons:
 * the pending half (getBillableDisputes) never includes a demo account (its
 * billable query excludes the demo_ id prefix), and the invoiced half finds
 * only the demo's one seeded invoice (app/lib/demo/seed.ts, status "paid"),
 * whose dispute fees are settled. So nothing is owed, and the card reads
 * $0.00, as the demo dashboard does (PR #79).
 */
const DEMO_FEES_OWED: MoneyPart[] = [];

/** Build the preview as of `now`. Pure: the same instant gives the same preview. */
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
  const ordered = sortDisputesNewestFirst(seeded);
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
      deadlineDate: formatDateMonthDay(d.evidenceDeadline),
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

// The seed is cheap, but its deadlines count whole days from `now`, so one
// preview serves every request in the same hour, as the Recovery spoke's does.
let cached: { hour: number; preview: DisputesPreview } | null = null;

export function disputesPreviewFor(nowMs: number): DisputesPreview {
  const hour = Math.floor(nowMs / HOUR_MS);
  if (cached?.hour !== hour) cached = { hour, preview: buildDisputesPreview(new Date(hour * HOUR_MS)) };
  return cached.preview;
}
