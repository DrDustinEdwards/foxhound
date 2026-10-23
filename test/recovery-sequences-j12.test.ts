import { describe, expect, it } from "vitest";

import * as constants from "~/lib/constants";
import { DECLINE_CATEGORIES } from "~/lib/constants";
import { findAttributionSignals } from "~/lib/recovery/attribution";
import { isRetryStep, RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import { STEP_PERFORMANCE_NOTE } from "~/lib/recovery/sequence-chart";
import {
  SEQUENCE_CATEGORY_DESCRIPTIONS,
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

describe("J12: Recova's rate colours", () => {
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

// ---- Every sentence on the page is true against the engine ----

describe("J12: the category descriptions are true against RECOVERY_SCHEDULES", () => {
  const leadsWithRetry = (c: keyof typeof RECOVERY_SCHEDULES) => isRetryStep(RECOVERY_SCHEDULES[c][0]!.stepType);
  const hasRetry = (c: keyof typeof RECOVERY_SCHEDULES) => RECOVERY_SCHEDULES[c].some((s) => isRetryStep(s.stepType));

  it("states the soft retry's hours from the soft schedule", () => {
    const retry = RECOVERY_SCHEDULES.soft.find((s) => s.stepType === "retry_day2")!;
    expect(leadsWithRetry("soft")).toBe(true);
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.soft).toBe(
      `Insufficient funds and generic declines. Foxhound retries silently first, then sends an email and retries the payment again ${retry.offsetHours} hours after the failure.`,
    );
  });

  it("says emails only, or no retries, only where the schedule has no retry", () => {
    for (const c of DECLINE_CATEGORIES) {
      const text = SEQUENCE_CATEGORY_DESCRIPTIONS[c];
      if (/emails only|not attempted|never succeeds/.test(text)) expect(hasRetry(c), c).toBe(false);
      if (/retries first|retries silently first/.test(text)) expect(leadsWithRetry(c), c).toBe(true);
    }
    expect(RECOVERY_SCHEDULES.unknown).toEqual(RECOVERY_SCHEDULES.expired);
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.unknown).toContain("same schedule as an expired card");
    expect(RECOVERY_SCHEDULES.revoked).toHaveLength(1);
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.revoked).toContain("one email");
  });
});







// Recova's caveat ("Recovery includes customers who updated payment after
// reading the email, even without clicking the tracked link") was true of
// Recova, which counted any recovered result on an email step. Foxhound
// credits an email step only through findAttributionSignals' click: a
// non-suspect click inside the engagement window, before the payment
// (webhooks/process.ts resolveRecoveryAttribution). The chart's note says so.
describe("J12: the step performance note states Foxhound's attribution rule", () => {
  const recoveredAt = new Date("2026-10-20T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const email = (over: Partial<Parameters<typeof findAttributionSignals>[0][number]>) => ({
    id: "step_email",
    stepType: "email_day3",
    result: "email_sent",
    clickedAt: null as Date | null,
    clickSuspectReason: null as string | null,
    ...over,
  });

  it("an opened but unclicked email is never credited, so the note never says it is", () => {
    expect(findAttributionSignals([email({})], recoveredAt).clickedEngagementId).toBeNull();
    expect(STEP_PERFORMANCE_NOTE).not.toMatch(/without clicking|after reading/);
    expect(STEP_PERFORMANCE_NOTE).toMatch(/clicked the email's link/);
  });

  it("states the engagement window the engine applies, read from the constant", () => {
    const inside = new Date(recoveredAt.getTime() - constants.EMAIL_ENGAGEMENT_WINDOW_DAYS * DAY + 60_000);
    const outside = new Date(recoveredAt.getTime() - (constants.EMAIL_ENGAGEMENT_WINDOW_DAYS + 1) * DAY);
    expect(findAttributionSignals([email({ clickedAt: inside })], recoveredAt).clickedEngagementId).toBe("step_email");
    expect(findAttributionSignals([email({ clickedAt: outside })], recoveredAt).clickedEngagementId).toBeNull();
    expect(STEP_PERFORMANCE_NOTE).toContain(`within ${constants.EMAIL_ENGAGEMENT_WINDOW_DAYS} days before paying`);
  });

  it("says a flagged click does not count, as the engine refuses it", () => {
    const clickedAt = new Date(recoveredAt.getTime() - DAY);
    expect(findAttributionSignals([email({ clickedAt, clickSuspectReason: "too_fast" })], recoveredAt).clickedEngagementId).toBeNull();
    expect(STEP_PERFORMANCE_NOTE).toMatch(/flagged as automated/);
  });
});
