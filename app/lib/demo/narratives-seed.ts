import type { intelligenceReports } from "~/db";

// Narratives seed (TASK-foxhound-demo-data-engine.md Phase 3): a pre-written
// narrative for the demo Intelligence report, ported from legacy lib/demo-
// seeding/seed-narratives.ts. Generic enough to stay accurate as the seeded
// numbers drift with `now`; specific enough to demonstrate the surface. Real
// merchants get a fresh nightly AI narrative (app/lib/intelligence/narrative.ts);
// the demo account is firewalled out of that cron, so this is the only
// narrative it ever gets. Pure: no AI call, no DB access.

export type IntelligenceReportInsert = typeof intelligenceReports.$inferInsert;

// Deliberately free of hard counts (dispute wins/losses, customer counts):
// TASK-foxhound-demo-engine-review-fixes.md M-1. A specific number here can
// silently start contradicting the Disputes page as that seed's outcome mix
// changes; a qualitative claim stays true regardless. Also drops any mention
// of a Bolt-base customer (L-1): Teamflow-only per the demo engine's locked
// constraints, so a name unresolvable anywhere in this book reads as an
// internal note that leaked into prospect-facing copy.
const NARRATIVE =
  "Teamflow closed the month with MRR growth driven by Scale-plan expansion offsetting modest Starter " +
  "churn. Involuntary churn from failed payments remained the primary revenue leak, with the recovery " +
  "sequence recapturing a meaningful share of at-risk MRR before each 30-day window closed. Bluewave " +
  "Studios is in an active recovery right now and worth watching, and a handful of Growth-tier customers " +
  "show declining engagement over the past 30 days, representing the largest near-term churn risk by " +
  "dollar value. Disputes stayed manageable this period: Foxhound drafted and submitted evidence on every " +
  "dispute it took on, winning most of them.";

export function buildNarrativeSeed(accountId: string, now: Date): IntelligenceReportInsert {
  const reportMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    id: "dreport_0",
    accountId,
    reportMonth,
    narrative: NARRATIVE,
    generatedAt: now,
  };
}
