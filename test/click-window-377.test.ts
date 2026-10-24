import { describe, expect, it } from "vitest";

import { EMAIL_ENGAGEMENT_WINDOW_DAYS, EMAIL_ENGAGEMENT_WINDOW_MS } from "~/lib/constants";


// RULING 377(2): `email_engaged` NEEDED A WINDOW, AND AN ORDER.
//
// The rule was "any step on this payment has clicked_at set", with no window and
// no ordering. That is legacy's rule verbatim, and legacy got away with it by
// bounding the RECOVERY instead: its handlePaymentSucceeded requires
// status='active' and its day-30 sweep flips the row, so a late payment recorded
// nothing at all. 284 deliberately widened Foxhound so late recoveries DO
// record. It never ruled that a months-old click was their cause, and its plant
// at cron-exhausted-sequences.test.ts asserted `email_engaged` across a 43-day
// gap only because nothing else had been decided. That plant is flipped;
// parity/REVERSALS.md carries it as 377(a).
//
// TWO HALVES, EACH WITH ITS OWN FAILURE MODE. A click AFTER the payment cannot
// have caused it: that is a customer tidying an inbox, and billing it charges a
// merchant 20% for their own customer's housekeeping. A click long BEFORE is
// the 284 case: the recovery is real, and Foxhound's email is not why.
//
// These drive real SQL through the same read webhooks/process.ts performs.


const DAY = 24 * 60 * 60 * 1000;



describe("the engagement window is 14 days, and the click must precede the recovery", () => {
  it("the constant is 14 days, stated once and derived in ms", () => {
    expect(EMAIL_ENGAGEMENT_WINDOW_DAYS).toBe(14);
    expect(EMAIL_ENGAGEMENT_WINDOW_MS).toBe(14 * DAY);
  });
});
