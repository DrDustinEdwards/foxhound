import { describe, expect, it } from "vitest";

import {
  NOT_ENOUGH_DATA_NARRATIVE,
  generateIntelligenceNarrative,
  hasNarrativeFacts,
  type NarrativeFacts,
} from "~/lib/intelligence/narrative";

const EMPTY_FACTS: NarrativeFacts = {
  accountName: "Acme",
  currency: "usd",
  totalMrrCents: 0,
  newMrrCents: 0,
  expansionMrrCents: 0,
  contractionMrrCents: 0,
  churnMrrCents: 0,
  reactivationMrrCents: 0,
  mrrAtRiskCents: 0,
  atRiskCustomerCount: 0,
  topAtRiskCustomers: [],
};

describe("hasNarrativeFacts", () => {

  it("is true when there is an at-risk customer even with zero MRR recorded", () => {
    expect(
      hasNarrativeFacts({
        ...EMPTY_FACTS,
        topAtRiskCustomers: [
          {
            stripeCustomerId: "cus_1",
            customerName: "Jane",
            healthScore: 20,
            mrrContributionCents: 0,
            currency: "usd",
            factorDetails: [],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("generateIntelligenceNarrative (no fabrication)", () => {
  it("never calls the model and returns the honest not-enough-data message for empty facts", async () => {
    // No ANTHROPIC_API_KEY on this fake env either: if the function attempted
    // a live call despite empty facts, it would throw constructing the client
    // or fail the network call, not resolve cleanly.
    const result = await generateIntelligenceNarrative({} as Env, EMPTY_FACTS);
    expect(result).toEqual({ narrative: NOT_ENOUGH_DATA_NARRATIVE, customerAssessments: [], usage: null });
  });

  it("throws when there are real facts to narrate but no ANTHROPIC_API_KEY", async () => {
    const facts: NarrativeFacts = { ...EMPTY_FACTS, totalMrrCents: 100_000 };
    await expect(generateIntelligenceNarrative({} as Env, facts)).rejects.toThrow(
      "ANTHROPIC_API_KEY is not set",
    );
  });
});
