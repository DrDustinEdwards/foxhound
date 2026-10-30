import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { planTierPill } from "~/lib/intelligence/customer-directory";
import IntelligenceCustomersPage from "~/routes/app/intelligence/customers";

// J30, row S17, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /intelligence/customers is Recova's page
// (app/(app)/intelligence/customers/page.tsx at blob 0413f035, with
// lib/intelligence-display.ts at blob 379635a7) built from Capsomer 0.9.0's
// components, amber throughout. Recova stays the spec for every section, label,
// column and their order, and for the page's 1280px column. The filter bar is
// Foxhound's, approved ("The customers page has a filter bar. "confirm",
// 2026-08-28", APPROVED-DIFFERENCES). The recommended-action chip waits for
// J78's producer.
//
// Every assertion here was seen failing against the page before the rebuild
// (red output kept in the J30 notes).

const Page = IntelligenceCustomersPage as unknown as (props: {
  loaderData: Record<string, unknown>;
}) => ReactElement;


const NOW = Date.UTC(2026, 9, 15, 12);

interface Row {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  currentPlanTier: string | null;
  mrrContributionCents: number;
  currency: string;
  healthScore: number | null;
  lastSeenAt: Date | null;
  hasActiveRecovery: boolean;
  hasDisputeHistory: boolean;
}

function row(over: Partial<Row> & { stripeCustomerId: string }): Row {
  return {
    customerName: "Sample Bakery",
    customerEmail: "owner@example.com",
    currentPlanTier: "growth",
    mrrContributionCents: 12_345,
    currency: "usd",
    healthScore: 55,
    lastSeenAt: new Date(NOW),
    hasActiveRecovery: false,
    hasDisputeHistory: false,
    ...over,
  };
}

interface Filters {
  search: string;
  tier: string;
  healthBand: string;
  sort: "health_asc" | "mrr_desc";
}

const NO_FILTERS: Filters = { search: "", tier: "", healthBand: "", sort: "health_asc" };

function render(
  opts: {
    customers?: Row[];
    totalCount?: number;
    totalMrrCents?: number;
    page?: number;
    totalPages?: number;
    filters?: Filters;
    accountName?: string | null;
  } = {},
): string {
  const customers = opts.customers ?? [row({ stripeCustomerId: "cus_sample_1" })];
  const loaderData = {
    entitled: true,
    result: {
      customers,
      totalCount: opts.totalCount ?? customers.length,
      totalMrrCents: opts.totalMrrCents ?? 123_450,
      page: opts.page ?? 1,
      totalPages: opts.totalPages ?? 1,
    },
    tiers: ["growth", "scale"],
    filters: opts.filters ?? NO_FILTERS,
    accountName: opts.accountName === undefined ? "Acme" : opts.accountName,
    nowMs: NOW,
  };
  const Stub = createRoutesStub([{ path: "/", Component: () => createElement(Page, { loaderData }) }]);
  return renderToStaticMarkup(createElement(Stub));
}



describe("J30 customers: the table", () => {

  it("names an unnamed customer as Recova does, never by email", () => {
    const html = render({ customers: [row({ stripeCustomerId: "cus_sample_2", customerName: null })] });
    expect(html).toContain("(unnamed)");
    expect(html).not.toContain("owner@example.com");
    expect(html).toContain('href="/intelligence/customers/cus_sample_2"');
  });
});

describe("J30 customers: plan pills", () => {

  it("gives a dash for no tier, and never shows a raw database value", () => {
    expect(planTierPill(null).label).toBe("-");
    expect(planTierPill("enterprise").label).toBe("Enterprise");
  });
});

describe("J30 customers: pagination", () => {
  function pager(html: string): string {
    return html.match(/<nav class="cap-pagination"[\s\S]*?<\/nav>/)?.[0] ?? "";
  }

  it("shows only the ends that lead somewhere, as Recova does", () => {
    const first = pager(render({ page: 1, totalPages: 3, totalCount: 120 }));
    expect(first).not.toContain("Previous");
    expect(first).toContain("Next");
    const last = pager(render({ page: 3, totalPages: 3, totalCount: 120 }));
    expect(last).toContain("Previous");
    expect(last).not.toContain("Next");
  });

  it("keeps the filters when paging", () => {
    const nav = pager(
      render({ page: 1, totalPages: 2, totalCount: 60, filters: { ...NO_FILTERS, tier: "growth", sort: "mrr_desc" } }),
    );
    expect(nav).toContain('href="/intelligence/customers?tier=growth&amp;sort=mrr_desc&amp;page=2"');
  });
});

describe("J30 review: plan tiers are free text", () => {
  it("matches a tier whatever its case or surrounding space", () => {
    expect(planTierPill("Growth")).toEqual({ label: "Growth", tone: "info" });
    expect(planTierPill("SCALE")).toEqual({ label: "Scale" });
    expect(planTierPill(" pro ")).toEqual({ label: "Pro" });
    expect(planTierPill("Starter").label).toBe("Starter");
  });
});

