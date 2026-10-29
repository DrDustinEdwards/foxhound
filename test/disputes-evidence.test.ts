import { describe, expect, it } from "vitest";

import {
  buildEvidenceFacts,
  draftDisputeEvidence,
  formatCommunicationLog,
  hasGroundingFacts,
  type EvidenceFacts,
} from "~/lib/disputes/evidence";

const METER = { source: "test", accountId: null };

const EMPTY_FACTS: EvidenceFacts = { productName: null, serviceDate: null, communications: [] };

describe("buildEvidenceFacts (grounded only in real records)", () => {

  it("pulls plan name and service date from the resolved failed_payment row", () => {
    const facts = buildEvidenceFacts(
      {
        planName: "Pro Monthly",
        subscriptionStart: new Date("2026-01-15T00:00:00.000Z"),
        detectedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      [],
    );
    expect(facts.productName).toBe("Pro Monthly");
    expect(facts.serviceDate).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it("only counts recovery_steps that actually executed, never a scheduled-but-unsent step", () => {
    const facts = buildEvidenceFacts(null, [
      { stepType: "email_day1", executedAt: null, openedAt: null, clickedAt: null },
      {
        stepType: "email_day3",
        executedAt: new Date("2026-07-03T00:00:00.000Z"),
        openedAt: new Date("2026-07-03T12:00:00.000Z"),
        clickedAt: null,
      },
    ]);
    expect(facts.communications).toHaveLength(1);
    expect(facts.communications[0].stepType).toBe("email_day3");
  });
});

describe("hasGroundingFacts", () => {
  it("is false for entirely empty facts", () => {
    expect(hasGroundingFacts(EMPTY_FACTS)).toBe(false);
  });

  it("is true when any single fact is present", () => {
    expect(hasGroundingFacts({ ...EMPTY_FACTS, productName: "Widget" })).toBe(true);
    expect(hasGroundingFacts({ ...EMPTY_FACTS, serviceDate: new Date() })).toBe(true);
    expect(
      hasGroundingFacts({
        ...EMPTY_FACTS,
        communications: [{ stepType: "email_day1", sentAt: new Date(), openedAt: null, clickedAt: null }],
      }),
    ).toBe(true);
  });
});

describe("formatCommunicationLog", () => {
  it("is null for no communications", () => {
    expect(formatCommunicationLog([])).toBeNull();
  });

  it("renders sent/opened/clicked dates deterministically from the real rows", () => {
    const log = formatCommunicationLog([
      {
        stepType: "email_day1",
        sentAt: new Date("2026-07-01T00:00:00.000Z"),
        openedAt: new Date("2026-07-01T09:00:00.000Z"),
        clickedAt: new Date("2026-07-02T00:00:00.000Z"),
      },
    ]);
    expect(log).toBe("email_day1 sent 2026-07-01, opened 2026-07-01, clicked 2026-07-02");
  });
});

describe("draftDisputeEvidence (no fabrication)", () => {

  it("returns the deterministic fields straight from the facts when ANTHROPIC_API_KEY is unset, without throwing", async () => {
    const facts: EvidenceFacts = {
      productName: "Pro Monthly",
      serviceDate: new Date("2026-01-15T00:00:00.000Z"),
      communications: [
        {
          stepType: "email_day1",
          sentAt: new Date("2026-07-01T00:00:00.000Z"),
          openedAt: null,
          clickedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
    };
    const fields = await draftDisputeEvidence({} as Env, facts, METER);
    expect(fields).toEqual([
      { fieldName: "product_description", fieldValue: "Pro Monthly" },
      { fieldName: "service_date", fieldValue: "2026-01-15" },
      {
        fieldName: "customer_communication",
        fieldValue: "email_day1 sent 2026-07-01, clicked 2026-07-02",
      },
    ]);
    // No AI-composed field: uncategorized_text is never invented without a key.
    expect(fields.some((f) => f.fieldName === "uncategorized_text")).toBe(false);
  });
});

// S32 (J06): /settings/disputes' product description has a reader. Recova's
// buildEvidenceFields (lib/disputes-evidence.ts) set product_description from
// the merchant's dispute_product_description on every response.
describe("the merchant's product description (S32)", () => {

  it("grounds a dispute that matches no recovery, as Recova used it on every response", async () => {
    const facts = buildEvidenceFacts(null, [], "Handmade candles, shipped in the US");
    expect(hasGroundingFacts(facts)).toBe(true);
    expect(await draftDisputeEvidence({} as Env, facts, METER)).toEqual([
      { fieldName: "product_description", fieldValue: "Handmade candles, shipped in the US" },
    ]);
  });
});
