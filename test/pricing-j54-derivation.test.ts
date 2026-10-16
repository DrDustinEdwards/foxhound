import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// J54 (row M4): /pricing's numbers are READ from Foxhound's engine constants,
// never typed (RULES.md 2.1). A string that merely equals today's value passes
// a copy test; this moves every constant the page states to a value nothing on
// the page holds today, and expects the rendered page and its meta to move with
// them. The sequence length moves through the schedule's own last step
// (STEP_TIMING_EMAIL_DAY30_HOURS feeds RECOVERY_SCHEDULES), and the category
// count through the marketing module that derives it from the same schedule.
vi.mock("~/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/constants")>()),
  RECOVERY_FEE_BPS: 1500,
  DISPUTE_FEE_BPS: 2500,
  DISPUTE_FEE_CAP_CENTS: 75_000,
  INTELLIGENCE_PRICE_CENTS: 24_900,
  RECOVERY_MATURITY_DAYS: 45,
  EMAIL_ENGAGEMENT_WINDOW_DAYS: 10,
  STEP_TIMING_EMAIL_DAY30_HOURS: 840,
}));
vi.mock("~/lib/marketing/decline-categories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/marketing/decline-categories")>()),
  DECLINE_CATEGORY_COUNT: 7,
  DECLINE_CATEGORY_COUNT_WORD: "Seven",
  DECLINE_CATEGORY_COUNT_WORD_LOWER: "seven",
  DISTINCT_SEQUENCE_COUNT: 4,
}));

const { default: PricingPage, meta } = await import("~/routes/pricing");

function render(): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(PricingPage as never, { loaderData: { siteUrl: "https://example.com" } }),
      },
    ],
    { initialEntries: ["/pricing"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("/pricing follows the engine constants (J54)", () => {
  const html = render();

  it("Recovery's fee comes from RECOVERY_FEE_BPS", () => {
    expect(html).toMatch(/>15%</);
  });

  it("Disputes' fee and cap come from DISPUTE_FEE_BPS and DISPUTE_FEE_CAP_CENTS, in the label and the bullet", () => {
    expect(html).toMatch(/>25%</);
    expect(html).toContain(">of won disputes, capped at $750<");
    expect(html).toContain(">25% only when Foxhound wins, capped at $750<");
  });

  it("Intelligence's price comes from INTELLIGENCE_PRICE_CENTS, in the price and the bullet", () => {
    expect(html).toMatch(/>\$249</);
    expect(html).toContain(">Predictive risk scoring: the paid $249/mo layer<");
  });

  it("the sequence length comes from the recovery schedule, and the category count from the engine", () => {
    expect(html).toContain("AI-drafted email sequences and silent retries across 35 days. Seven decline categories, four different sequences.");
    expect(html).toContain(">35-day sequences across 7 decline categories<");
  });

  it("the maturity window comes from RECOVERY_MATURITY_DAYS, in the bullet, the FAQ and the meta description", () => {
    expect(html).toContain(">No fee until the recovery has matured 45 days<");
    expect(html).toContain("recoveries you&#x27;ve held for 45 or more days");
    const tags = meta({ loaderData: { siteUrl: "https://example.com" } } as never);
    expect(tags.find((t) => (t as { name?: string }).name === "description")?.content).toContain(
      "matured for 45 days",
    );
  });

  it("the click window comes from EMAIL_ENGAGEMENT_WINDOW_DAYS", () => {
    expect(html).toContain("within 10 days before the payment");
  });

  it("shows none of today's figures once the constants move", () => {
    expect(html.length).toBeGreaterThan(5000);
    expect(html).not.toContain("20%");
    expect(html).not.toContain("$199");
    expect(html).not.toContain("$500");
    expect(html).not.toMatch(/\b30(?:-| )days?\b/);
    expect(html).not.toContain("14 days");
    expect(html).not.toMatch(/\b[46] decline categories/);
  });
});
