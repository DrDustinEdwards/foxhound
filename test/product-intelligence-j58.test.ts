import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import * as risk from "~/lib/intelligence/risk";
import IntelligenceProductPage, { loader } from "~/routes/products/intelligence";

// J58 (job_b091fc0d979e), the Intelligence spoke, row M9. Recova's spec, read
// whole at HEAD: app/(marketing)/product/intelligence/page.tsx (blob
// 4f258429), components/product/ProductSections.tsx (ba3aed7c),
// ProductFAQ.tsx (7c08a5a2), IntelligenceDashboardPreview.tsx (11972333) with
// the MRRStatCards (2920fa3b) and PlanBreakdown (65b5674f) it mounts,
// components/docs/IntelligenceCustomerTable.tsx (6ae7c73f) with
// HealthScoreBadge (f25f29d8), components/docs/ChurnRiskSummary.tsx (ba1fbb51)
// and components/intelligence/IntegrityLayerBanner.tsx (1614dfaf).
//
// These read the RENDERED page, fed by the route's own loader. Every expected
// number is worked out here a second way, straight from the demo seed and the
// engine constants, never read back from the modules under test.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    throw new Error("unexpected context key");
  },
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

async function load(): Promise<LoaderData> {
  return loader({
    context: fakeContext,
    request: new Request("https://foxhoundapp.com/product/intelligence"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
}

function render(loaderData: LoaderData): string {
  const Page = IntelligenceProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/intelligence"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and entities for the characters this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}




const COUNT_WORD = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/** Every signal the engine can emit, found by driving computeHealthScore with
 *  inputs that move every factor, not read from a list. */
function emittedSignals(): string[] {
  const nowMs = Date.UTC(2026, 9, 15);
  const adverse = risk.computeHealthScore({
    nowMs,
    subscriptionAgeDays: 720,
    planChangeCount: 2,
    seatChangeCount: 1,
    intervalSwitchCount: 1,
    paymentLatencyDriftDays: 5,
    refundCount: 1,
    disputeCount: 1,
    recoverySignals: { failedPaymentCount: 2 } as never,
    engagementSignals: null,
  });
  return adverse.factors.map((f) => f.signal).sort();
}

function signalLabels(): string[] {
  const labels = (risk as unknown as { HEALTH_SIGNAL_LABELS?: Record<string, string> }).HEALTH_SIGNAL_LABELS;
  expect(labels, "risk.ts names each signal it scores").toBeTypeOf("object");
  return Object.values(labels as Record<string, string>);
}

function listOf(words: string[]): string {
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}







// The free tier (PRICING.md, Intelligence: basic MRR analytics are FREE for
// every Recovery merchant; the $199 is the risk layer). The merchant dashboard
// draws MRR, movements, churn and cohorts under a "Free" label with no
// Intelligence entitlement check, so the $199 must not be sold as covering them.

describe("the copy says only what Foxhound computes (J58)", async () => {
  const html = render(await load());
  const body = text(html);
  const copy = text(html);

  it("names the score's signals from the engine, every one the engine can emit and no other", () => {
    const labels = signalLabels();
    const keys = Object.keys((risk as unknown as { HEALTH_SIGNAL_LABELS: Record<string, string> }).HEALTH_SIGNAL_LABELS).sort();
    expect(keys).toEqual(emittedSignals());
    const list = listOf(labels);
    expect(body).toContain(`0-100 health scores per customer, derived from ${list}.`);
    expect(body).toContain(`${COUNT_WORD[labels.length]} signals, ${list}, combine into a 0-100 health score`);
    expect(body).toContain(`The health score is derived from ${COUNT_WORD[labels.length].toLowerCase()} independent signals: ${list}.`);
  });

  it("claims no recommended actions, because nothing in Foxhound writes one", () => {
    expect(copy).not.toMatch(/Seven recommend/i);
    expect(copy).not.toMatch(/recommendation types/i);
    expect(copy).not.toMatch(/actionable recommendations/i);
    expect(copy).toContain("A recommended action per customer is not built yet.");
  });
});

