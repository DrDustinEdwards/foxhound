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
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { planWinbackSteps } from "~/lib/recovery/winback";

const DEFAULT_STEP1 = WIN_BACK_SCHEDULE.find((s) => s.stepNumber === 1)!.offsetHours;



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
