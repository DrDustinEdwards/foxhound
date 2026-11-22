import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import * as risk from "~/lib/intelligence/risk";
import IntelligenceProductPage, { loader } from "~/routes/products/intelligence";

// These read the RENDERED page, fed by the route's own loader. Every expected
// number is worked out a second way, never read back from the modules under test.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
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
  const Page = IntelligenceProductPage as unknown as (props: {
    loaderData: LoaderData;
  }) => React.ReactElement;
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
    latestFailedCardFunding: "prepaid",
  });
  return adverse.factors.map((f) => f.signal).sort();
}

function signalLabels(): string[] {
  const labels = (risk as unknown as { HEALTH_SIGNAL_LABELS?: Record<string, string> })
    .HEALTH_SIGNAL_LABELS;
  expect(labels, "risk.ts names each signal it scores").toBeTypeOf("object");
  return Object.values(labels as Record<string, string>);
}

function listOf(words: string[]): string {
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

describe("the Intelligence page says only what Foxhound computes", async () => {
  const html = render(await load());
  const body = text(html);

  it("names the score's signals from the engine, every one the engine can emit and no other", () => {
    const labels = signalLabels();
    const keys = Object.keys(
      (risk as unknown as { HEALTH_SIGNAL_LABELS: Record<string, string> }).HEALTH_SIGNAL_LABELS,
    ).sort();
    expect(keys).toEqual(emittedSignals());
    const list = listOf(labels);
    expect(body).toContain(`0-100 health scores per customer, derived from ${list}.`);
    expect(body).toContain(
      `${COUNT_WORD[labels.length]} signals, ${list}, combine into a 0-100 health score`,
    );
    expect(body).toContain(
      `The health score is derived from ${COUNT_WORD[labels.length].toLowerCase()} independent signals: ${list}.`,
    );
  });
});
