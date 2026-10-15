import { and, count, eq, gte, isNotNull } from "drizzle-orm";

import { accounts, aiCalls, customerContext, type Db } from "~/db";
import { getMrrAnalytics } from "~/lib/dashboard/stats.server";
import { INTELLIGENCE_REPORT_HOURLY_LIMIT } from "~/lib/constants";

import {
  NARRATIVE_AI_SOURCE,
  narrativeFactsFor,
  writeNarrativeReport,
  type NarrativeCustomer,
} from "./ai-run.server";
import { monthKeyOf, type GenerateReportError } from "./dashboard";
import { generateIntelligenceNarrative } from "./narrative";
import type { HealthFactor } from "./risk";

// The Intelligence dashboard's "Generate report" / "Regenerate report" button
// (row S16, job J67). Recova's button posted a month to
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
//     under a button labelled "Regenerate".
//   * The limit counts the engine's own ai_calls rows for the narrative,
//     because Foxhound has no KV for a counter (CLAUDE.md, single
//     environment) and every model call already writes one.
//   * A missing key and an unfunded key are their own errors (launch blocker
//     2), so the page says why nothing was written instead of failing quietly.

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const HOUR_MS = 60 * 60 * 1000;

export type GenerateReportResult =
  | { ok: true; month: string; narrative: string }
  | { ok: false; error: GenerateReportError };

/** Which of the page's errors a failed narrative call is. */
export function classifyNarrativeError(err: unknown): "ai_not_configured" | "ai_no_credit" | "generation_failed" {
  if (!(err instanceof Error)) return "generation_failed";
  if (err.message.includes("ANTHROPIC_API_KEY is not set")) return "ai_not_configured";
  const status = (err as { status?: unknown }).status;
  // Anthropic answers an unfunded account with a 400 whose message names the
  // credit balance.
  if ((status === 400 || status === 402) && /credit balance/i.test(err.message)) return "ai_no_credit";
  return "generation_failed";
}

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

  const [{ n: recentCalls }] = await db
    .select({ n: count() })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.accountId, accountId),
        eq(aiCalls.source, NARRATIVE_AI_SOURCE),
        gte(aiCalls.createdAt, new Date(nowMs - HOUR_MS)),
      ),
    );
  if (recentCalls >= INTELLIGENCE_REPORT_HOURLY_LIMIT) return { ok: false, error: "rate_limited" };

  const [account, rows, mrr] = await Promise.all([
    db.select({ name: accounts.name, currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
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
    accountName: account[0]?.name ?? "the business",
    currency: account[0]?.currency ?? "usd",
    mrrLatest: mrr.latest,
    scored,
  });

  let result;
  try {
    result = await generateIntelligenceNarrative(env, facts);
  } catch (err) {
    const error = classifyNarrativeError(err);
    // The merchant sees the sentence; the operator sees the cause in the log.
    console.error(`intelligence report generation failed for account ${accountId} (${error}):`, err instanceof Error ? err.message : err);
    return { ok: false, error };
  }

  await writeNarrativeReport(db, { accountId, now, result, scored });
  return { ok: true, month, narrative: result.narrative };
}
