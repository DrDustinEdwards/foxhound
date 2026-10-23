import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { formatMoneyShort } from "~/lib/money-format";
import DisputesProductPage, { loader } from "~/routes/products/disputes";

// J57 (job_827e854076e9), the Disputes spoke. Recova's spec, read whole at
// HEAD: app/(marketing)/product/disputes/page.tsx (blob c412d54f),
// components/product/ProductSections.tsx (ba3aed7c), ProductFAQ.tsx
// (7c08a5a2), DisputesDashboardPreview.tsx (dcde195e) with the
// DisputesDashboardView it renders (3c1b7a98), and
// components/docs/DisputesTablePreview.tsx (ed33fa95) with DisputeStatusPill
// (8eb22d08) and TriagePill (1485726d).
//
// These read the RENDERED page, fed by the route's own loader, so a value that
// never reaches a reader cannot pass. Every expected number is worked out here
// a second way, straight from the demo seed and the engine constants, never
// read back from the modules under test.

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
    request: new Request("https://foxhoundapp.com/product/disputes"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
}

function render(loaderData: LoaderData): string {
  const Page = DisputesProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/disputes"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and entities for the characters this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}


const PCT = `${DISPUTE_FEE_BPS / 100}%`;
const CAP = formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd");









describe("the copy says only what Foxhound does (J57)", async () => {
  const html = render(await load());
  const body = text(html);

  it("never claims an auto-submit (RULES.md 5.6): every submission waits for an approval", () => {
    expect(body).not.toMatch(/auto-submit (fires|24 hours)/i);
    expect(body).not.toMatch(/before the deadline if enabled/i);
    expect(body).not.toMatch(/submits it to Stripe before the deadline/i);
    expect(body).toContain("then submits it to Stripe once someone on your team approves it.");
    expect(body).toContain("No auto-submit: nothing reaches Stripe until you approve it");
  });

  it("states the cap on the fee wherever the price is stated", () => {
    expect(body).toContain(`of disputes Foxhound wins, capped at ${CAP} per dispute`);
  });

  it("does not call the /connect scope read-only (RULES.md 2.2)", () => {
    expect(body).not.toMatch(/read-only stripe access/i);
    expect(body).toContain(`Read and write Stripe access · ${PCT} only when you win`);
  });
});


