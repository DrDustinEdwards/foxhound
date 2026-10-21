import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";

import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import IntelligenceProductPage, { loader } from "~/routes/products/intelligence";

import { computeHealthScore } from "~/lib/intelligence/risk";
import { buildPredictionFields } from "~/lib/intelligence/predictions";

// RULING 281c, executed 2026-08-14: "verify-then-claim gains its concrete plan,
// the Intelligence routes are REAL with the line-92 RouteStub comment as the
// stale artifact, risk, predictions and signals exercised on REAL data and the
// marketing copy corrected to match the evidence IN EITHER DIRECTION".
//
// 280 THREE governs the standard: "no Intelligence claim ships without the
// measurement or source that backs it named at the claim."
//
// Each assertion below pins a CLAIM to the EVIDENCE that decided it. Where the
// evidence refuted the claim, the assertion pins that the claim is gone AND
// that the fact which refuted it still holds, so re-adding the copy without
// building the feature fails here.

// J58 moved the page's words into a copy module and its previews into their
// own files, so "the page" is all of them: a claim in any one is on the page.
const PAGE = [
  "app/routes/products/intelligence.tsx",
  "app/lib/marketing/intelligence-copy.ts",
  "app/components/intelligence-previews.tsx",
]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("281c: claims the evidence REFUTED are gone, and stay gone", () => {
  it("the Recovery-timing and Disputes-triage feed-back claim is removed", () => {
    // MEASURED: nothing wires a risk signal into either. Recovery step timing is
    // the static RECOVERY_SCHEDULES table keyed on decline category; the only
    // intelligence imports outside app/lib/intelligence are the two cron
    // registrations; triage fields exist ONLY in the demo seed.
    expect(PAGE).not.toContain("adjust Recovery sequence timing");
    expect(PAGE).not.toContain("feed Recovery timing and Disputes triage");
    expect(PAGE).not.toContain("Disputes triage");
  });

  it("the FACT that refuted it still holds: no intelligence SCORING in the recovery path", () => {
    for (const f of ["app/lib/recovery/schedule.ts", "app/lib/engine/execute-step.ts", "app/lib/engine/retry-step.ts"]) {
      expect(readFileSync(f, "utf8")).not.toContain("lib/intelligence");
    }
    // process.ts is ADJUDICATED here, not exempted (292). It gained exactly one
    // intelligence import, the win-back ENTITLEMENT read, which is a yes/no on a
    // paid subscription and NOT a risk signal. The claim this assertion protects
    // named RECOVERY SEQUENCE timing and DISPUTES TRIAGE; win-back timing is
    // neither, which is the same distinction 292 used to keep the item-3 entry
    // alive rather than retire it. So the matcher narrows to the subject: the
    // file may read the entitlement, and may NOT read a score or a prediction.
    const processSource = readFileSync("app/lib/webhooks/lookups.ts", "utf8");
    const intelligenceImports = [
      ...processSource.matchAll(/from "~\/lib\/intelligence\/[^"]+"/g),
    ].map((m) => m[0]);
    expect(intelligenceImports).toEqual(['from "~/lib/intelligence/views.server"']);
    for (const scored of ["computeHealthScore", "healthScore", "buildPredictionFields"]) {
      expect(processSource).not.toContain(scored);
    }
    // And step timing is a static table, not a scored decision.
    const schedule = readFileSync("app/lib/recovery/schedule.ts", "utf8");
    expect(schedule).toContain("RECOVERY_SCHEDULES");
    expect(schedule).not.toContain("healthScore");
  });

  it("the instant-availability claim is removed", () => {
    // MEASURED: the MRR/movements/churn/cohort producer is the intelligence-sync
    // cron on CRON_SCHEDULE_MONTHLY, and there is no on-connect trigger, so
    // "the moment you connect" was false.
    expect(PAGE).not.toContain("the moment you connect");
  });

  it("the FACT that refuted it still holds: sync is a scheduled cron, not on-connect", () => {
    const registry = readFileSync("app/lib/cron/registry.ts", "utf8");
    expect(registry).toContain('{ name: "intelligence-sync", schedule: CRON_SCHEDULE_MONTHLY');
    // No route triggers the sync; if one is ever added this assertion is the
    // place to revisit the copy.
    for (const f of ["app/routes/auth/connect.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toContain("runIntelligenceSync");
    }
  });

  it("the bare prediction claim is removed", () => {
    // MEASURED: predictions are LOGGED and never GRADED, so no accuracy exists.
    expect(PAGE).not.toContain("predicts what is about to happen");
  });

  it("the FACT that refuted it still holds: nothing grades a prediction", () => {
    // realizedOutcome has no production writer. The only non-null-assigning
    // mention outside the read paths is the demo seed writing null.
    const predictions = readFileSync("app/lib/intelligence/predictions.ts", "utf8");
    expect(predictions).toContain("realizedOutcome / gradedAt are left unset");
    // The customer page renders the ungraded state honestly.
    expect(readFileSync("app/routes/app/intelligence/customer.tsx", "utf8")).toContain(
      'realizedOutcome ?? "pending"',
    );
  });
});

describe("281c: the stale artifact the ruling named", () => {
  it("the RouteStub comment is corrected, and the routes really are not stubs", () => {
    // J58 rewrote the page to Recova's spec, and the corrected comment went
    // with the old page; the stale sentence must still never come back.
    expect(PAGE).not.toContain("are still RouteStub placeholders");
    for (const f of [
      "app/routes/app/intelligence/index.tsx",
      "app/routes/app/intelligence/customers.tsx",
      "app/routes/app/intelligence/customer.tsx",
      "app/routes/app/intelligence/churn.tsx",
      "app/routes/app/intelligence/alerts.tsx",
      "app/routes/app/intelligence/reports.tsx",
    ]) {
      expect(readFileSync(f, "utf8")).not.toContain("RouteStub");
    }
  });
});

describe("281c: claims the evidence SUPPORTS, with the source named", () => {
  it("the MRR movements the page names are exactly what the engine computes", () => {
    // MrrMovements carries new/expansion/contraction/churn/reactivation plus the
    // two churn rates, and buildCohortBreakdown produces the cohort rows.
    const mrr = readFileSync("app/lib/intelligence/mrr.ts", "utf8");
    for (const field of [
      "newMrrCents",
      "expansionMrrCents",
      "contractionMrrCents",
      "churnMrrCents",
      "reactivationMrrCents",
      "voluntaryChurnRateBps",
      "involuntaryChurnRateBps",
    ]) {
      expect(mrr).toContain(field);
    }
    expect(mrr).toContain("buildCohortBreakdown");
    // J58: Recova's page has no free-tier block, so the movements are named in
    // Recova's own How it works step, at Foxhound's monthly cadence.
    expect(PAGE).toContain("New, expansion, reactivation, contraction, and churn MRR tracked month by month");
  });

  it("the free tier is stated on the rendered page, and the engine really leaves it ungated", async () => {
    // PRICING.md (Intelligence): basic MRR analytics are FREE for every
    // Recovery merchant; the $199 is the risk layer. The evidence: the merchant
    // dashboard draws them under "Free" with no entitlement check. J58 removed
    // the old free-tier BLOCK to match Recova's sections; the free statement
    // stays, read here on the RENDERED page, not in source.
    const dashboard = readFileSync("app/routes/app/dashboard.tsx", "utf8");
    expect(dashboard).not.toContain("isIntelligenceEntitled");
    // The console draws the movements and the cohorts with Enarratio (J64);
    // the movement fields are read in console.ts, which the route draws from.
    for (const f of ["drawLatestMovement", "drawCohorts", "perCohortBreakdown"]) expect(dashboard).toContain(f);
    const consoleLib = readFileSync("app/lib/dashboard/console.ts", "utf8");
    for (const f of ["newMrrCents", "churnMrrCents"]) expect(consoleLib).toContain(f);
    const charts = readFileSync("app/lib/dashboard/console-charts.ts", "utf8");
    expect(charts).not.toContain("isIntelligenceEntitled");
    expect(charts).toContain("export function drawCohorts");
    const body = await renderedText();
    expect(body).toContain("MRR, movements, churn, and cohort analytics are free for every Recovery merchant.");
    expect(body).toContain("adds predictive risk scoring");
  });

  it("the named scoring signals are the ones risk.ts actually scores", () => {
    // The copy now lists the signals by name, so the copy and the engine cannot
    // drift without this failing.
    const risk = readFileSync("app/lib/intelligence/risk.ts", "utf8");
    for (const signal of [
      "payment_latency",
      "billing_volatility",
      "refunds_disputes",
      "recovery_engagement",
      "tenure",
    ]) {
      expect(risk).toContain(signal);
    }
    // J58: the copy lists them from risk.ts's own HEALTH_SIGNAL_LABELS, keyed
    // by the same signal names, rather than typing them. This is a source
    // check on purpose; the RENDERED list, and that the labels are exactly
    // the signals computeHealthScore emits, are checked in
    // test/product-intelligence-j58.test.ts. Keep both.
    expect(risk).toContain("export const HEALTH_SIGNAL_LABELS");
    expect(PAGE).toContain("Object.values(HEALTH_SIGNAL_LABELS)");
  });

  it("the daily refresh claim matches the cron that computes the score", () => {
    const registry = readFileSync("app/lib/cron/registry.ts", "utf8");
    expect(registry).toContain('{ name: "intelligence-ai", schedule: CRON_SCHEDULE_DAILY');
    const aiRun = readFileSync("app/lib/intelligence/ai-run.server.ts", "utf8");
    expect(aiRun).toContain("computeHealthScore");
    expect(PAGE).toContain("updated nightly");
  });

  it("the not-a-black-box claim matches a surface that really lists factors", () => {
    expect(readFileSync("app/routes/app/intelligence/customer.tsx", "utf8")).toContain(
      "detail.healthFactors",
    );
    expect(PAGE).toContain("The score is not a black box");
  });

  it("the page states no accuracy figure, as PRICING requires", () => {
    // PRICING.md: "Accuracy claims in marketing only after backtests support
    // them." J58 returned the page to Recova's three questions, so the fourth
    // (an accuracy FAQ Recova never had) is gone; no accuracy figure appears.
    expect(PAGE).not.toMatch(/accura/i);
    expect(PAGE).not.toMatch(/\d+% of (churn|cancellations)/i);
  });
});

describe("281c: risk and predictions EXERCISED, not just read", () => {
  it("a customer with real adverse signals scores below the at-risk band", () => {
    const now = Date.UTC(2026, 7, 14);
    const result = computeHealthScore({
      nowMs: now,
      subscriptionAgeDays: 30,
      planChangeCount: 3,
      seatChangeCount: 1,
      intervalSwitchCount: 1,
      paymentLatencyDriftDays: 4,
      refundCount: 1,
      disputeCount: 1,
      recoverySignals: { failedPaymentCount: 2 } as never,
      engagementSignals: null,
    });
    // Baseline 70, minus latency, volatility, refunds/disputes and no engagement.
    expect(result.score).toBeLessThan(40);
    const signals = result.factors.map((f) => f.signal).sort();
    expect(signals).toEqual([
      "billing_volatility",
      "payment_latency",
      "recovery_engagement",
      "refunds_disputes",
    ]);
    // Every factor carries the plain-language detail the copy promises.
    for (const f of result.factors) expect(f.detail.length).toBeGreaterThan(0);
  });

  it("a clean long-tenured customer scores healthy with no adverse factors", () => {
    const result = computeHealthScore({
      nowMs: Date.UTC(2026, 7, 14),
      subscriptionAgeDays: 720,
      planChangeCount: 0,
      seatChangeCount: 0,
      intervalSwitchCount: 0,
      paymentLatencyDriftDays: 0,
      refundCount: 0,
      disputeCount: 0,
      recoverySignals: null,
      engagementSignals: null,
    });
    expect(result.score).toBeGreaterThan(70);
    expect(result.factors.map((f) => f.signal)).toEqual(["tenure"]);
  });

  it("a prediction is logged with a horizon and NO realized outcome", () => {
    // This is the shape the honest-accuracy FAQ describes: logged, ungraded.
    const fields = buildPredictionFields({
      accountId: "acc_1",
      stripeCustomerId: "cus_1",
      score: 31,
      factors: [{ signal: "payment_latency", deltaPoints: -12, detail: "later" }],
      horizonDays: 30,
      predictedAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    expect(fields.horizonDays).toBe(30);
    expect(fields.bandEvidenceHash).toMatch(/^[0-9a-f]{8}$/);
    // The row shape carries no grading fields at all: nothing to fill them.
    expect(Object.keys(fields)).not.toContain("realizedOutcome");
    expect(Object.keys(fields)).not.toContain("gradedAt");
  });
});

/** The /product/intelligence page as a visitor gets it, from the route's own
 *  loader, as text. */
async function renderedText(): Promise<string> {
  const context = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      throw new Error("unexpected context key");
    },
  };
  const loaderData = await loader({
    context,
    request: new Request("https://foxhoundapp.com/product/intelligence"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
  const Page = IntelligenceProductPage as unknown as (props: { loaderData: typeof loaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/intelligence"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }))
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}
