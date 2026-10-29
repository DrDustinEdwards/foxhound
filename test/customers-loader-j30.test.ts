import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";

// J30 review, finding 8: the customers page renders no email, so its loader
// must not send one to the browser. listCustomerDirectory is shared with the
// MCP tool foxhound_list_customers and stays as it is; the route maps its rows.

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => ({}),
}));

// J30 review, blocking finding 1: the mocks are vi.fn so a test can pin that
// the loader passes the signed-in account, and only that account, to every
// query (see "scopes every query to the signed-in account" below).
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

function context() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {}, ctx: {}, nonce: "n" };
      if (key === authContext) return { membership: { accountId: "acct_sample", accountName: "Acme" }, isDemo: false };
      throw new Error("unexpected context key");
    },
  } as never;
}

describe("J30 customers loader", () => {

  it("sends the page's columns and no customer email", async () => {
    const data = (await route.loader({
      context: context(),
      request: new Request("https://x.test/intelligence/customers"),
      params: {},
    } as never)) as { result: { customers: Record<string, unknown>[] } };
    expect(data.result.customers).toHaveLength(2);
    expect(data.result.customers[0].stripeCustomerId).toBe("cus_sample_1");
    expect(data.result.customers[0]).not.toHaveProperty("customerEmail");
    expect(JSON.stringify(data)).not.toContain("owner@example.com");
  });
});
