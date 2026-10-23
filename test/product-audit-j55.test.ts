import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  STRIPE_AUDIT_SCOPE,
} from "~/lib/constants";
import AuditProductPage, { loader } from "~/routes/products/audit";

// J55 (job_35fce978e1df), the Audit spoke, row M6. Recova's spec, read whole at
// HEAD: app/(marketing)/product/audit/page.tsx (blob 210ce79d),
// components/product/ProductSections.tsx (ba3aed7c),
// components/product/ProductFAQ.tsx (7c08a5a2) and
// components/docs/AuditScopeCard.tsx (dc1d18dd).
//
// These read the RENDERED page, fed by the route's own loader. Every fact the
// copy states is worked out here a second way, from the engine's constants and
// the summary prompt, never read back from the copy module under test.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    throw new Error("unexpected context key");
  },
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

function load(): LoaderData {
  return loader({
    context: fakeContext,
    request: new Request("https://foxhoundapp.com/product/audit"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]) as LoaderData;
}

function render(loaderData: LoaderData): string {
  const Page = AuditProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/audit"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and the entities this page uses decoded. */
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



const html = render(load());
const body = text(html);

// Facts, worked out here from the engine.


describe("the copy states the audit Foxhound runs (J55, RULES.md 2.1 and 2.2)", () => {
  it("states the read-only scope the audit actually requests", () => {
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
    expect(body).toContain("Read-only OAuth connection.");
    expect(body).toContain("Read-only OAuth scope.");
    expect(body).toContain("Always free · No account required · Read-only Stripe access");
  });

  it("never says the audit's connection carries write scope", () => {
    expect(body).not.toMatch(/read and write|read_write|write scope/i);
  });

  it("shows no recovery estimate, baseline or platform rate, because the results show none", () => {
    expect(body).not.toMatch(/\d+(\.\d+)?%/);
    expect(body).not.toMatch(/estimated recovery value|estimates what/i);
    expect(body).toMatch(/How accurate is the recovery estimate\? The audit does not show one\./);
  });
});
