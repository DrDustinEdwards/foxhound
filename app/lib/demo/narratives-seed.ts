import type { intelligenceReports } from "~/db";

// Narratives seed (TASK-foxhound-demo-data-engine.md Phase 3): a pre-written
// narrative per demo business for the Intelligence report, ported from legacy
// lib/demo-seeding/seed-narratives.ts (blob `d9655be0`). Generic enough to stay accurate as the seeded
// numbers drift with `now`; specific enough to demonstrate the surface. Real
// merchants get a fresh nightly AI narrative (app/lib/intelligence/narrative.ts);
// the demo account is firewalled out of that cron, so this is the only
// narrative it ever gets. Pure: no AI call, no DB access.

export type IntelligenceReportInsert = typeof intelligenceReports.$inferInsert;

// Deliberately free of hard counts (dispute wins/losses, customer counts):
// TASK-foxhound-demo-engine-review-fixes.md M-1. A specific number here can
// silently start contradicting the Disputes page as that seed's outcome mix
// changes; a qualitative claim stays true regardless. Also drops any mention
// of a customer from the other business's base (L-1): a name unresolvable
// anywhere in that business's book reads as an internal note that leaked into
// prospect-facing copy.
export const TEAMFLOW_NARRATIVE =
  "Teamflow closed the month with MRR growth driven by Scale-plan expansion offsetting modest Starter " +
  "churn. Involuntary churn from failed payments remained the primary revenue leak, with the recovery " +
  "sequence recapturing a meaningful share of at-risk MRR before each 30-day window closed. Bluewave " +
  "Studios is in an active recovery right now and worth watching, and a handful of Growth-tier customers " +
  "show declining engagement over the past 30 days, representing the largest near-term churn risk by " +
  "dollar value. Disputes stayed manageable this period: Foxhound drafted and submitted evidence on every " +
  "dispute it took on, winning most of them.";

// Bolt Analytics. Truthfulness fixes against legacy's text: legacy closed with
// "No disputes were filed against Bolt accounts during the period" while its
// own seed filed three (seedBoltDisputes), and credited "the extended 30-day
// sequence" against an "old 7-day window" Bolt never had. Both are dropped; the
// at-risk Pro customer who has not opened a recovery email is Driftwave Labs,
// named as Teamflow's narrative names Bluewave.
export const BOLT_NARRATIVE =
  "Bolt Analytics held MRR steady this month, with Pro-plan retention offsetting the expected drag from " +
  "Hobby customers who have not yet converted to Pro. Failed-payment recovery ran at a rate consistent with " +
  "the prior month, recapturing revenue on payments that would otherwise have lapsed. Driftwave Labs, a " +
  "recent Pro upgrade that Intelligence flags as a high churn risk, has not opened a recovery email in 30 " +
  "days and is the largest single MRR exposure. Each dispute this period was on a single Pro charge, so the " +
  "amount at stake stayed small.";

export function buildNarrativeSeed(
  accountId: string,
  now: Date,
  narrative: string = TEAMFLOW_NARRATIVE,
  idPrefix = "d",
): IntelligenceReportInsert {
  const reportMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    id: `${idPrefix}report_0`,
    accountId,
    reportMonth,
    narrative,
    generatedAt: now,
  };
}
