import { describe, expect, it } from "vitest";

import {
  NOT_ENOUGH_DATA_NARRATIVE,
  hasNarrativeFacts,
  writeIntelligenceNarrative,
  type NarrativeFacts,
} from "~/lib/intelligence/narrative";

const EMPTY_FACTS: NarrativeFacts = {
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

describe("writeIntelligenceNarrative", () => {
  it("says there is not enough data, with no assessments, when there are no facts", () => {
    expect(writeIntelligenceNarrative(EMPTY_FACTS)).toEqual({
      narrative: NOT_ENOUGH_DATA_NARRATIVE,
      customerAssessments: [],
    });
  });

  it("says when nothing moved and nobody is at risk, rather than listing zeros", () => {
    expect(writeIntelligenceNarrative({ ...EMPTY_FACTS, totalMrrCents: 100_000 }).narrative).toBe(
      "Total MRR is $1,000.00. No MRR moved this period. No customer is at risk right now.",
    );
  });

  it("names a net loss and joins factor details into one sentence", () => {
    const result = writeIntelligenceNarrative({
      ...EMPTY_FACTS,
      totalMrrCents: 100_000,
      churnMrrCents: 5_000,
      mrrAtRiskCents: 2_000,
      atRiskCustomerCount: 1,
      topAtRiskCustomers: [
        {
          stripeCustomerId: "cus_1",
          customerName: null,
          healthScore: 18,
          mrrContributionCents: 2_000,
          currency: "usd",
          factorDetails: ["Health trended from 78 to 18 (failed payment).", "subscribed 40 days"],
        },
      ],
    });
    expect(result.narrative).toBe(
      "Total MRR is $1,000.00. This period: $50.00 churned, a net loss of $50.00. " +
        "$20.00 of MRR is at risk across 1 customer. The lowest health score is cus_1 at 18/100.",
    );
    expect(result.customerAssessments).toEqual([
      {
        stripeCustomerId: "cus_1",
        assessment:
          "Health score 18/100 on $20.00 of MRR. Health trended from 78 to 18 (failed payment); subscribed 40 days.",
      },
    ]);
  });
});
