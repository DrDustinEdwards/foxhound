// Intelligence DOES change one Recovery timing. resolveWinbackStep1Offset in
// app/lib/webhooks/process.ts (legacy parity, recova
// app/api/webhooks/stripe/route.ts:978-998) delays the first win-back email
// from WIN_BACK_SCHEDULE's step 1 to WINBACK_UNFLAGGED_STEP1_HOURS on an
// account with Intelligence, for any customer not flagged winback_priority.
// Nothing writes that flag today, so every cancelled customer on such an
// account waits the longer time. The copy must say so, with the hours taken
// from the constants, and must not say Intelligence never changes a sequence.
import { describe, expect, it } from "vitest";
import { WINBACK_STEP1_HOURS, WINBACK_UNFLAGGED_STEP1_HOURS } from "~/lib/constants";
import { getDocGuide } from "~/lib/marketing/docs-content";
import { INTELLIGENCE_FAQS } from "~/lib/marketing/intelligence-copy";
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { planWinbackSteps } from "~/lib/recovery/winback";

const hours = (n: number) => `${n} ${n === 1 ? "hour" : "hours"}`;
const DEFAULT_STEP1 = WIN_BACK_SCHEDULE.find((s) => s.stepNumber === 1)!.offsetHours;

const faq = INTELLIGENCE_FAQS.find((f) => f.q === "Does Intelligence affect my Recovery sequences?")!.a;

function docText(slug: string): string {
  return JSON.stringify(getDocGuide(slug));
}

describe("the engine fact the copy describes", () => {
  it("the schedule's step 1 is WINBACK_STEP1_HOURS, and the gate moves it to WINBACK_UNFLAGGED_STEP1_HOURS", () => {
    expect(DEFAULT_STEP1).toBe(WINBACK_STEP1_HOURS);
    expect(WINBACK_UNFLAGGED_STEP1_HOURS).toBeGreaterThan(WINBACK_STEP1_HOURS);
    const canceledAt = new Date("2026-10-01T00:00:00Z");
    const [first] = planWinbackSteps({
      winBackSequenceId: "wb_1",
      accountId: "acct_1",
      canceledAt,
      step1OffsetHours: WINBACK_UNFLAGGED_STEP1_HOURS,
    } as Parameters<typeof planWinbackSteps>[0]);
    expect(first.scheduledAt.getTime() - canceledAt.getTime()).toBe(WINBACK_UNFLAGGED_STEP1_HOURS * 3_600_000);
  });

  // The gate itself (process.ts resolveWinbackStep1Offset) is called, not
  // read as source, in test/winback-gate-behaviour.test.ts, and
  // test/winback-priority-no-writer.test.ts keeps "nothing flags a customer" true.
});

describe("the Intelligence FAQ tells the truth about win-back timing", () => {
  it("names the delayed and default step-1 times from the constants", () => {
    expect(faq).toContain(`waits ${hours(WINBACK_UNFLAGGED_STEP1_HOURS)} instead of ${hours(WINBACK_STEP1_HOURS)}`);
    expect(faq).toMatch(/first win-back email/);
    expect(faq).toMatch(/win-back priority/);
  });

  it("says no customer is flagged today, because nothing writes the flag", () => {
    expect(faq).toMatch(/Nothing in Foxhound flags a customer as a win-back priority yet/);
  });

  it("no longer claims Intelligence never changes a sequence, or opens with a bare No", () => {
    expect(faq).not.toMatch(/never changes a sequence/i);
    expect(faq).not.toMatch(/^No\./);
  });
});

describe("the Platform guide's win-back timing (Additional features)", () => {
  it("states the Intelligence delay beside the 1-hour first email, from the same constants", () => {
    const text = docText("platform");
    expect(text).toContain(`waits ${hours(WINBACK_UNFLAGGED_STEP1_HOURS)} instead of ${hours(WINBACK_STEP1_HOURS)}`);
  });
});

describe("the /features win-back line says Intelligence is what picks the longer step 1", () => {
  it("names both step-1 times from the constants and ties the longer one to Intelligence", async () => {
    const { featureSections } = await import("~/lib/marketing/features-content");
    const text = JSON.stringify(featureSections({ cronJobCount: 1, merchantMcpToolCount: 1 }));
    expect(text).toContain(
      `step 1 at ${hours(WINBACK_STEP1_HOURS)}, or ${hours(WINBACK_UNFLAGGED_STEP1_HOURS)} on an account with Intelligence unless the customer is flagged as a win-back priority`,
    );
  });
});
