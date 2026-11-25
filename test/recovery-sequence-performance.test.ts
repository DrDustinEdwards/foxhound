import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import {
  buildCategorySections,
  buildStepCard,
  summarizeStepPerformance,
  type StepPerformanceInput,
} from "~/lib/recovery/sequence-performance";

describe("summarizeStepPerformance", () => {
  function step(overrides: Partial<StepPerformanceInput> = {}): StepPerformanceInput {
    return {
      stepType: "email_day1",
      result: "email_sent",
      openedAt: null,
      clickedAt: null,
      creditedRecovery: false,
      ...overrides,
    };
  }

  it("excludes retry steps from the email performance chart and averages", () => {
    const summary = summarizeStepPerformance([
      step({ stepType: "retry_early", openedAt: new Date() }),
      step({ stepType: "email_day1" }),
    ]);
    expect(summary.totalSent).toBe(1);
    expect(summary.chart.map((c) => c.stepType)).toEqual(["email_day1"]);
  });

  it("orders the chart by real schedule offset, not alphabetically", () => {
    // email_day14 sorts before email_day3 alphabetically but must not here.
    const summary = summarizeStepPerformance([
      step({ stepType: "email_day14" }),
      step({ stepType: "email_day3" }),
      step({ stepType: "email_day1" }),
    ]);
    expect(summary.chart.map((c) => c.stepType)).toEqual([
      "email_day1",
      "email_day3",
      "email_day14",
    ]);
  });

  it("computes open/click/recovery rate per step type", () => {
    const summary = summarizeStepPerformance([
      step({
        stepType: "email_day3",
        openedAt: new Date(),
        clickedAt: new Date(),
        creditedRecovery: true,
      }),
      step({ stepType: "email_day3", openedAt: new Date() }),
      step({ stepType: "email_day3" }),
      step({ stepType: "email_day3" }),
    ]);
    const point = summary.chart[0];
    expect(point.sent).toBe(4);
    expect(point.openRatePct).toBe(50);
    expect(point.clickRatePct).toBe(25);
    expect(point.recoveryRatePct).toBe(25);
  });

  it("picks the best-performing step by click rate, minimum 3 sends", () => {
    const summary = summarizeStepPerformance([
      // email_day1: 2 sends, 100% click - below the 3-send floor, excluded.
      step({ stepType: "email_day1", clickedAt: new Date() }),
      step({ stepType: "email_day1", clickedAt: new Date() }),
      // email_day3: 3 sends, 1 click (33%) - meets the floor, wins by default.
      step({ stepType: "email_day3", clickedAt: new Date() }),
      step({ stepType: "email_day3" }),
      step({ stepType: "email_day3" }),
    ]);
    expect(summary.bestStep).not.toBeNull();
    expect(summary.bestStep!.clickRatePct).toBe(33);
  });
});

describe("buildStepCard", () => {
  it("builds a silent-retry card with no email fields, a recovered-of-attempted ratio", () => {
    const card = buildStepCard(
      "retry_early",
      [
        {
          executedAt: new Date(),
          result: "retry_succeeded",
          openedAt: null,
          clickedAt: null,
          aiSubject: null,
          aiBodyHtml: null,
        },
        {
          executedAt: new Date(),
          result: "retry_failed",
          openedAt: null,
          clickedAt: null,
          aiSubject: null,
          aiBodyHtml: null,
        },
        // A guarded expired-card retry that made no charge is not an attempt.
        {
          executedAt: new Date(),
          result: "retry_skipped_card_unchanged",
          openedAt: null,
          clickedAt: null,
          aiSubject: null,
          aiBodyHtml: null,
        },
      ],
      4,
    );
    expect(card.kind).toBe("retry");
    if (card.kind !== "retry") throw new Error("expected retry card");
    expect(card.attempted).toBe(2);
    expect(card.recovered).toBe(1);
    expect(card.successRatePct).toBe(50);
    expect(card.timingLabel).not.toBeNull();
  });

  it("builds an email card with sent/opened/clicked and the latest subject", () => {
    const older = {
      executedAt: new Date("2026-01-01"),
      result: "email_sent",
      openedAt: null,
      clickedAt: null,
      aiSubject: "Old subject",
      aiBodyHtml: "<p>old</p>",
    };
    const newer = {
      executedAt: new Date("2026-02-01"),
      result: "email_sent",
      openedAt: new Date(),
      clickedAt: null,
      aiSubject: "New subject",
      aiBodyHtml: "<p>new</p>",
    };
    const card = buildStepCard("email_day1", [older, newer], 1);
    if (card.kind !== "email") throw new Error("expected email card");
    expect(card.sent).toBe(2);
    expect(card.openRatePct).toBe(50);
    expect(card.clickRatePct).toBe(0);
    expect(card.latestSubject).toBe("New subject");
    expect(card.latestBodyHtml).toBe("<p>new</p>");
  });
});

describe("buildCategorySections", () => {
  it("scopes each step card's rows to its own category, never leaking another category's steps", () => {
    const steps = [
      {
        declineCategory: "soft" as const,
        stepType: "email_day1",
        executedAt: new Date(),
        result: "email_sent",
        openedAt: null,
        clickedAt: null,
        aiSubject: null,
        aiBodyHtml: null,
      },
      {
        declineCategory: "fraud" as const,
        stepType: "email_day1",
        executedAt: new Date(),
        result: "email_sent",
        openedAt: null,
        clickedAt: null,
        aiSubject: null,
        aiBodyHtml: null,
      },
    ];
    const sections = buildCategorySections(DECLINE_CATEGORIES, steps);
    const soft = sections.find((s) => s.category === "soft")!;
    const softDay1 = soft.stepCards.find((c) => c.stepType === "email_day1")!;
    if (softDay1.kind !== "email") throw new Error("expected email card");
    expect(softDay1.sent).toBe(1);

    const fraud = sections.find((s) => s.category === "fraud")!;
    const fraudDay1 = fraud.stepCards.find((c) => c.stepType === "email_day1")!;
    if (fraudDay1.kind !== "email") throw new Error("expected email card");
    expect(fraudDay1.sent).toBe(1);
  });
});
