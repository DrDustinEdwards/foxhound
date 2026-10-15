import type { DisputeState } from "~/lib/constants";
import { formatDateMonthDay } from "~/lib/date-format";
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import {
  DISPUTE_STATE_LABELS,
  daysUntilDeadline,
  deadlineUrgency,
  disputeStateTone,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { sortDisputesForList } from "~/lib/disputes/order";
import { computeDisputeStats } from "~/lib/disputes/stats";
import { formatMoney } from "~/lib/money-format";

import type { DisputesPreview, PreviewDisputeRow } from "./disputes-preview";

// The data behind the /products/disputes previews (J57): the demo account's
// seed, never a merchant's rows. Recova draws these from a hand-written
// eight-dispute array (DisputesDashboardPreview.tsx, blob dcde195e), a second
// hand-written six-row array (DisputesTablePreview.tsx, blob ed33fa95) and
// typed stat values (page.tsx's DisputesStatCardsPreview, blob c412d54f), so
// its three figures disagree with each other. Foxhound builds the Teamflow
// disputes its demo runs on (buildDisputesSeed, pure, no database and no
// Stripe) and reads them the way the merchant dashboard reads its own rows:
//
// - The cards: computeDisputeStats, the dashboard's own (open, at stake, fees
//   owed), and the disputes Foxhound submitted (submitted_at set, the same
//   predicate the fee keys off). Recova's fifth card, Saved vs Smart
//   Disputes, has no computation in Foxhound (stats.ts), so the card says so.
// - The rows: sortDisputesForList, the dashboard's order; state words and
//   tones from labels.ts; deadline days and bands from daysUntilDeadline and
//   deadlineUrgency.
//
// Strings are formatted here, on the server, so the page renders the same
// text on the server and in the browser.

const HOUR_MS = 60 * 60 * 1000;
/** Recova's dispute table preview lists six disputes. */
const PREVIEW_TABLE_ROWS = 6;

/** Build the preview as of `now`. Pure: the same instant gives the same preview. */
export function buildDisputesPreview(now: Date): DisputesPreview {
  const nowMs = now.getTime();
  const seeded = buildDisputesSeed(DEMO_ACCOUNT_ID, now, DEMO_MEMBER_EMAIL).disputes.map((d) => ({
    id: d.id as string,
    customerName: d.customerName ?? null,
    customerEmail: d.customerEmail ?? null,
    amountCents: d.amountCents,
    currency: d.currency ?? "usd",
    reason: d.reason ?? null,
    state: d.state as DisputeState,
    createdAt: d.createdAt as Date,
    resolvedAt: d.resolvedAt ?? null,
    evidenceDeadline: d.evidenceDeadline ?? null,
    submittedAt: d.submittedAt ?? null,
    resolvedFeeCents: d.resolvedFeeCents ?? null,
  }));
  const ordered = sortDisputesForList(seeded);

  const stats = computeDisputeStats(ordered);
  // One currency for the cards, as the dashboard takes it: the first row's.
  const currency = ordered[0]?.currency ?? "usd";

  const rows = ordered.map((d): PreviewDisputeRow => {
    const resolved = isDisputeResolved(d.state);
    const foxhoundSubmitted = d.submittedAt !== null;
    const days = resolved ? null : daysUntilDeadline(d.evidenceDeadline, nowMs);
    return {
      id: d.id,
      customer: d.customerName ?? d.customerEmail ?? "Unknown",
      email: d.customerName ? d.customerEmail : null,
      amount: formatMoney(d.amountCents, d.currency),
      reason: humanizeDisputeReason(d.reason),
      stateLabel: DISPUTE_STATE_LABELS[d.state] ?? d.state,
      stateTone: disputeStateTone(d.state),
      foxhoundSubmitted,
      fee: d.state === "resolved_won" && foxhoundSubmitted ? "owed" : resolved ? "none" : null,
      resolved,
      deadlineDays: days,
      deadlineUrgency: deadlineUrgency(days),
      deadlineDate: formatDateMonthDay(d.evidenceDeadline),
    };
  });

  return {
    asOf: now.toISOString(),
    stats: {
      openCount: stats.needsActionCount,
      atStake: formatMoney(stats.atStakeCents, currency),
      submittedByFoxhound: ordered.filter((d) => d.submittedAt !== null).length,
      feesOwed: formatMoney(stats.feesOwedCents, currency),
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
