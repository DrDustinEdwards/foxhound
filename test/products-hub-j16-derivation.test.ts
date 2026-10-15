import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// J16 (row M5): the hub's prices are READ from Foxhound's pricing constants,
// never typed (RULES.md 2.1). A string that merely equals today's value would
// pass a plain copy test; this moves the constants and expects the page to move
// with them.
vi.mock("~/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/constants")>()),
  RECOVERY_FEE_BPS: 1500,
  DISPUTE_FEE_BPS: 2500,
  DISPUTE_FEE_CAP_CENTS: 75_000,
  INTELLIGENCE_PRICE_CENTS: 24_900,
}));

const { default: ProductsIndexPage } = await import("~/routes/products/index");

function render(): string {
  const router = createMemoryRouter([{ path: "*", element: createElement(ProductsIndexPage) }], {
    initialEntries: ["/products"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("/products hub prices follow the constants (J16)", () => {
  const html = render();

  it("Recovery's fee comes from RECOVERY_FEE_BPS", () => {
    expect(html).toContain(">15% of Foxhound-attributed recoveries<");
  });

  it("Disputes' fee and cap come from DISPUTE_FEE_BPS and DISPUTE_FEE_CAP_CENTS", () => {
    expect(html).toContain(">25% on wins, capped at $750<");
  });

  it("Intelligence's price comes from INTELLIGENCE_PRICE_CENTS", () => {
    expect(html).toContain(">$249/mo for predictive risk scoring<");
  });

  it("shows none of today's typed figures once the constants move", () => {
    expect(html).not.toContain("20%");
    expect(html).not.toContain("$199");
    expect(html).not.toContain("$500");
  });
});
