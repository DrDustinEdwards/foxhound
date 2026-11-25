import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// /pricing's numbers are read from the engine constants, never typed: moving a constant moves the page.
vi.mock("~/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/constants")>()),
  RECOVERY_FEE_BPS: 1500,
  DISPUTE_FEE_BPS: 2500,
  DISPUTE_FEE_CAP_CENTS: 75_000,
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
        element: createElement(PricingPage as never, {
          loaderData: { siteUrl: "https://example.com" },
        }),
      },
    ],
    { initialEntries: ["/pricing"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("/pricing follows the engine constants", () => {
  const html = render();

  it("the maturity window comes from RECOVERY_MATURITY_DAYS, in the bullet, the FAQ and the meta description", () => {
    expect(html).toContain(">No fee until the recovery has matured 45 days<");
    expect(html).toContain("recoveries you&#x27;ve held for 45 or more days");
    const tags = meta({ loaderData: { siteUrl: "https://example.com" } } as never);
    const description = tags.find((t) => (t as { name?: string }).name === "description") as
      | { content?: string }
      | undefined;
    expect(description?.content).toContain("matured for 45 days");
  });
});
