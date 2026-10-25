import { describe, expect, it } from "vitest";

import * as constants from "~/lib/constants";
import {
  sequenceRateTone,
} from "~/lib/recovery/sequence-categories";
import {
  buildStepCard,
  sequenceStepLabel,
} from "~/lib/recovery/sequence-performance";

describe("J12: Recova's step names, from Foxhound's schedules", () => {

  it("names a retry by its own category's offset, so a 24 hour retry never reads 48hr", () => {
    expect(sequenceStepLabel("retry_4hr", constants.STEP_TIMING_RETRY_4HR_HOURS)).toBe("4hr retry");
    expect(sequenceStepLabel("retry_early", constants.STEP_TIMING_RETRY_EARLY_HOURS)).toBe("4hr retry");
    expect(sequenceStepLabel("retry_day2", constants.STEP_TIMING_RETRY_DAY2_HOURS)).toBe("48hr retry");
    expect(sequenceStepLabel("retry_day2", constants.STEP_TIMING_NETWORK_RETRY_DAY2_HOURS)).toBe("24hr retry");
    expect(sequenceStepLabel("retry_day21", constants.STEP_TIMING_RETRY_DAY21_HOURS)).toBe("Day 21 retry");
  });
});

describe("J12: Recova's rate colors", () => {
  it("bands open rate above 50 green, 20 to 50 caution, under 20 red", () => {
    expect(sequenceRateTone(51, "open")).toBe("green");
    expect(sequenceRateTone(50, "open")).toBe("caution");
    expect(sequenceRateTone(20, "open")).toBe("caution");
    expect(sequenceRateTone(19, "open")).toBe("red");
  });

  it("bands click rate above 20 green, 5 to 20 caution, under 5 red", () => {
    expect(sequenceRateTone(21, "click")).toBe("green");
    expect(sequenceRateTone(20, "click")).toBe("caution");
    expect(sequenceRateTone(5, "click")).toBe("caution");
    expect(sequenceRateTone(4, "click")).toBe("red");
  });
});

describe("J12: the latest subject is Recova's pick", () => {
  it("shows the newest send that has a subject, with that send's body", () => {
    const card = buildStepCard(
      "email_day1",
      [
        { executedAt: new Date("2026-10-03"), result: "email_sent", openedAt: null, clickedAt: null, aiSubject: null, aiBodyHtml: null },
        { executedAt: new Date("2026-10-02"), result: "email_sent", openedAt: null, clickedAt: null, aiSubject: "Older subject", aiBodyHtml: "<p>Older body</p>" },
      ],
      1,
    );
    if (card.kind !== "email") throw new Error("expected an email card");
    expect(card.latestSubject).toBe("Older subject");
    expect(card.latestBodyHtml).toBe("<p>Older body</p>");
  });
});
