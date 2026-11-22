import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { authContext } from "~/lib/auth/context";
import IntelligenceCustomersPage from "~/routes/app/intelligence/customers";

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => ({}),
}));

// listCustomerDirectory is shared with the MCP tool foxhound_list_customers and
// returns emails; the route must not pass them on to the browser.
const mocks = vi.hoisted(() => ({
  listCustomerTiers: vi.fn(),
  listCustomerDirectory: vi.fn(),
}));

vi.mock("~/lib/intelligence/directory.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/intelligence/directory.server")>()),
  listCustomerTiers: mocks.listCustomerTiers.mockImplementation(async () => ["growth"]),
  listCustomerDirectory: mocks.listCustomerDirectory.mockImplementation(async () => ({
    customers: [
      {
        stripeCustomerId: "cus_sample_1",
        customerName: "Sample Bakery",
        customerEmail: "owner@example.com",
        currentPlanTier: "growth",
        mrrContributionCents: 4_900,
        currency: "usd",
        healthScore: 55,
        lastSeenAt: new Date(0),
        recoverySignals: {},
        disputeSignals: {},
      },
      {
        stripeCustomerId: "cus_sample_2",
        customerName: "Example Logistics",
        customerEmail: "ops@example.com",
        currentPlanTier: null,
        mrrContributionCents: 0,
        currency: "usd",
        healthScore: 20,
        lastSeenAt: null,
        recoverySignals: { activeRecoveryId: "fp_sample_secret" },
        disputeSignals: { wonCount: 2, lostCount: 1 },
      },
    ],
    totalCount: 2,
    totalMrrCents: 4_900,
    page: 1,
    totalPages: 1,
  })),
}));

const route = await import("~/routes/app/intelligence/customers");

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
  const Stub = createRoutesStub([
    { path: "/", Component: () => createElement(Page, { loaderData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub));
}

describe("customers page", () => {
  it("names an unnamed customer as '(unnamed)', never by email", () => {
    const html = render({
      customers: [row({ stripeCustomerId: "cus_sample_2", customerName: null })],
    });
    expect(html).toContain("(unnamed)");
    expect(html).not.toContain("owner@example.com");
    expect(html).toContain('href="/intelligence/customers/cus_sample_2"');
  });

  it("keeps the filters when paging", () => {
    const html = render({
      page: 1,
      totalPages: 2,
      totalCount: 60,
      filters: { ...NO_FILTERS, tier: "growth", sort: "mrr_desc" },
    });
    const nav = html.match(/<nav class="cap-pagination"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain(
      'href="/intelligence/customers?tier=growth&amp;sort=mrr_desc&amp;page=2"',
    );
  });
});

function context() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {}, ctx: {} };
      if (key === authContext)
        return { membership: { accountId: "acct_sample", accountName: "Acme" }, isDemo: false };
      throw new Error("unexpected context key");
    },
  } as never;
}

describe("customers loader", () => {
  it("sends the page's columns, scoped to the signed-in account, and no customer email", async () => {
    const data = (await route.loader({
      context: context(),
      request: new Request("https://x.test/intelligence/customers"),
      params: {},
    } as never)) as { result: { customers: Record<string, unknown>[] } };
    expect(mocks.listCustomerDirectory.mock.calls[0][1]).toBe("acct_sample");
    expect(mocks.listCustomerTiers.mock.calls[0][1]).toBe("acct_sample");
    expect(data.result.customers).toHaveLength(2);
    expect(data.result.customers[0].stripeCustomerId).toBe("cus_sample_1");
    expect(data.result.customers[0]).not.toHaveProperty("customerEmail");
    expect(JSON.stringify(data)).not.toContain("owner@example.com");
  });
});
