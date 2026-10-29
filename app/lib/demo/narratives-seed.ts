import type { customerContext, intelligenceReports, mrrSnapshots } from "~/db";
import { narrativeFactsFor, writeIntelligenceNarrative } from "~/lib/intelligence/narrative";
import type { HealthFactor } from "~/lib/intelligence/risk";

// Narratives seed (TASK-foxhound-demo-data-engine.md Phase 3): the demo
// business's Intelligence report and its at-risk customers' assessments,
// written by the same template real merchants get (narrative.ts) from the
// seeded scores and the latest seeded MRR snapshot. Legacy seeded a
// hand-written AI-style paragraph (lib/demo-seeding/seed-narratives.ts, blob
// `d9655be0`); Foxhound's narrative is a template with no model call, so the
// demo shows exactly what a merchant would see. The demo account is
// firewalled out of the nightly run, so this is the only narrative it gets.
// Pure: no AI call, no DB access.

type IntelligenceReportInsert = typeof intelligenceReports.$inferInsert;
type CustomerContextInsert = typeof customerContext.$inferInsert;
type MrrSnapshotInsert = typeof mrrSnapshots.$inferInsert;

export interface NarrativeSeed {
  report: IntelligenceReportInsert;
  /** The assessment for each at-risk customer the narrative names, by customer_context id. */
  assessments: Map<string, string>;
}

export function buildNarrativeSeed(input: {
  accountId: string;
  now: Date;
  customers: readonly CustomerContextInsert[];
  latestMrr: MrrSnapshotInsert | undefined;
  idPrefix: string;
}): NarrativeSeed {
  const { accountId, now, customers, latestMrr, idPrefix } = input;
  const scored = customers
    .filter((c) => c.healthScore != null)
    .map((c) => ({
      customerContextId: c.id!,
      stripeCustomerId: c.stripeCustomerId,
      customerName: c.customerName ?? null,
      mrrContributionCents: c.mrrContributionCents ?? 0,
      score: c.healthScore!,
      factors: (c.healthFactors as HealthFactor[] | null | undefined) ?? [],
    }));
  const result = writeIntelligenceNarrative(
    narrativeFactsFor({
      currency: "usd",
      mrrLatest: latestMrr
        ? {
            totalMrrCents: latestMrr.totalMrrCents ?? 0,
            newMrrCents: latestMrr.newMrrCents ?? 0,
            expansionMrrCents: latestMrr.expansionMrrCents ?? 0,
            contractionMrrCents: latestMrr.contractionMrrCents ?? 0,
            churnMrrCents: latestMrr.churnMrrCents ?? 0,
            reactivationMrrCents: latestMrr.reactivationMrrCents ?? 0,
          }
        : null,
      scored,
    }),
  );
  const idByCustomer = new Map(scored.map((c) => [c.stripeCustomerId, c.customerContextId]));
  const assessments = new Map<string, string>();
  for (const a of result.customerAssessments) {
    const id = idByCustomer.get(a.stripeCustomerId);
    if (id) assessments.set(id, a.assessment);
  }
  return {
    report: {
      id: `${idPrefix}report_0`,
      accountId,
      reportMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      narrative: result.narrative,
      generatedAt: now,
    },
    assessments,
  };
}
