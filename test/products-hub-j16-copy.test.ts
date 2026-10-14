import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { DISPUTE_FEE_BPS, INTELLIGENCE_PRICE_CENTS, RECOVERY_FEE_BPS } from "~/lib/constants";
import { formatMoneyShort } from "~/lib/money-format";
import ProductsIndexPage, { meta } from "~/routes/products/index";

// J16 (job_3ea21f4c3086), row M5: the /products hub's copy. Recova's
// app/(marketing)/products/page.tsx (blob 1349c46e) and lib/products.ts
// (blob 6be24574), read whole, word for word, except that every number is read
// from Foxhound's pricing constants (RULES.md 2.1) and the Recovery price says
// what Foxhound bills: only Foxhound-attributed recoveries
// (app/lib/billing/billable-predicates.ts, isBillableRecoveryRow), where
// Recova's "of recoveries" would claim a fee on the baseline too (truthfulness,
// RULES.md 1.2). products-hub-j16-derivation.test.ts proves the numbers are read,
// not typed.

function render(): string {
  const router = createMemoryRouter([{ path: "*", element: createElement(ProductsIndexPage) }], {
    initialEntries: ["/products"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Each card, opening tag through close, inside Recova's 720px hub column. */
function cards(html: string): string[] {
  const col = html.indexOf("max-w-[720px]");
  expect(col, "the 720px hub column is on the page").toBeGreaterThan(-1);
  const out = [...html.slice(col).matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  expect(out.length, "the hub renders its cards").toBe(4);
  return out;
}

const pct = (bps: number) => `${bps / 100}%`;

const SPEC = [
  { name: "Audit", description: "Full Stripe diagnostic. See what is leaking in 30 seconds.", price: "Free" },
  {
    name: "Recovery",
    description: "Failed payment recovery for Stripe merchants",
    price: `${pct(RECOVERY_FEE_BPS)} of Foxhound-attributed recoveries`,
  },
  {
    name: "Disputes",
    description: "Chargeback response and recovery. Pay only on success.",
    price: `${pct(DISPUTE_FEE_BPS)} on wins`,
  },
  {
    name: "Intelligence",
    description: "MRR analytics, churn prediction, customer health scoring, AI narrative",
    price: `${formatMoneyShort(INTELLIGENCE_PRICE_CENTS, "usd")}/mo`,
  },
] as const;

describe("/products hub copy (J16, row M5)", () => {
  const html = render();
  const card = (name: string) => {
    const c = cards(html).find((x) => x.includes(`>${name}<`));
    expect(c, `${name} card`).toBeDefined();
    return c ?? "";
  };

  it.each(SPEC)("$name card carries Recova's description word for word", ({ name, description }) => {
    expect(card(name)).toContain(`>${description}<`);
  });

  it.each(SPEC)("$name card shows its price as ONE string, as Recova does", ({ name, price }) => {
    // The whole price is the text of one element: no figure split from a label.
    expect(card(name)).toContain(`>${price}<`);
  });
});

describe("/products meta (J16)", () => {
  const tags = meta({ loaderData: { siteUrl: "https://example.com" } } as unknown as Parameters<typeof meta>[0]);

  it("keeps the site's title pattern", () => {
    expect(tags.find((t) => "title" in t)?.title).toBe("Products - Foxhound");
  });

  it("carries Recova's description word for word", () => {
    expect(tags.find((t) => t.name === "description")?.content).toBe(
      "Audit, Recovery, Disputes, and Intelligence. Four products that recover failed Stripe payments, fight chargebacks, and predict customer churn.",
    );
  });
});
