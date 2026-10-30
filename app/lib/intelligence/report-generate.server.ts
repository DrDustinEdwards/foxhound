import { and, eq, isNotNull } from "drizzle-orm";

import { accounts, customerContext, type Db } from "~/db";
import { getMrrAnalytics } from "~/lib/dashboard/stats.server";
import { HOUR_MS, INTELLIGENCE_REPORT_HOURLY_LIMIT } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";

import { writeNarrativeReport } from "./ai-run.server";
import { monthKeyOf, type GenerateReportError } from "./dashboard";
import { narrativeFactsFor, writeIntelligenceNarrative, type NarrativeCustomer } from "./narrative";
import type { HealthFactor } from "./risk";

// The Intelligence dashboard's "Generate report" / "Regenerate report" button.
// Recova's button posted a month to
// app/api/intelligence/generate-report/route.ts (blob 45732914), which wrote
// its own prompt from its own facts. This hooks the button into Foxhound's
// engine instead: the same facts and the same writer the nightly run uses
// (ai-run.server.ts), with the scores customer_context already holds rather
// than a fresh scoring pass, because scoring is the nightly run's job.
//
// Kept from Recova: a "YYYY-MM" month, five generations per account per hour,
// and the error codes the page turns into Recova's sentences. Different, and
// why:
//   * Only the current month. The engine's facts are today's (the latest
//     snapshot, today's scores); a report for a past month written from them
//     would describe this month under that month's name.
//   * Regenerate regenerates. Recova returned an existing report unchanged
//     under a button labeled "Regenerate".
//   * The limit is the RATE_LIMITER Durable Object (app/lib/http/rate-limit.ts),
//     keyed per account. It fails open like the limiter's other callers: the
//     report is a template (narrative.ts) and costs nothing to write.

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const RATE_LIMIT_BUCKET = "intelligence-report";

export type GenerateReportResult =
  | { ok: true; month: string; narrative: string }
  | { ok: false; error: GenerateReportError };

export async function generateMonthlyReport(
  env: Env,
  db: Db,
  accountId: string,
  month: string,
  nowMs: number,
): Promise<GenerateReportResult> {
  if (!MONTH_PATTERN.test(month)) return { ok: false, error: "invalid_month" };
  const now = new Date(nowMs);
  if (month !== monthKeyOf(now)) return { ok: false, error: "not_current_month" };

  if (!(await isWithinRateLimit(env, RATE_LIMIT_BUCKET, accountId, INTELLIGENCE_REPORT_HOURLY_LIMIT, HOUR_MS))) {
    return { ok: false, error: "rate_limited" };
  }

  const [account, rows, mrr] = await Promise.all([
    db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
    db
      .select({
        id: customerContext.id,
        stripeCustomerId: customerContext.stripeCustomerId,
        customerName: customerContext.customerName,
        mrrContributionCents: customerContext.mrrContributionCents,
        healthScore: customerContext.healthScore,
        healthFactors: customerContext.healthFactors,
      })
      .from(customerContext)
      .where(and(eq(customerContext.accountId, accountId), isNotNull(customerContext.healthScore))),
    getMrrAnalytics(db, accountId),
  ]);

  const scored: NarrativeCustomer[] = rows.map((r) => ({
    customerContextId: r.id,
    stripeCustomerId: r.stripeCustomerId,
    customerName: r.customerName,
    mrrContributionCents: r.mrrContributionCents ?? 0,
    score: r.healthScore ?? 0,
    factors: (r.healthFactors as HealthFactor[] | null) ?? [],
  }));
  const facts = narrativeFactsFor({
    currency: account[0]?.currency ?? "usd",
    mrrLatest: mrr.latest,
    scored,
  });

  const result = writeIntelligenceNarrative(facts);
  await writeNarrativeReport(db, { accountId, now, result, scored });
  return { ok: true, month, narrative: result.narrative };
}
