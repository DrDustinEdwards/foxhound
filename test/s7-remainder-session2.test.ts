
import { describe, expect, it } from "vitest";

import { parseManualIntent } from "~/lib/recovery/manual-actions.server";

// RULING 296, the S7 remainder's Session 2: plan_name, the stale-artifact sweep,
// the stale test name, and the email sub-line repair. Legacy is
// app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx at BLOB 7f54aa45.
//
// CRLF-normalized and comment-stripped for the same reasons 295's file records:
// the working tree stores these files with carriage returns, so a multi-line
// matcher written for bare newlines misses; and these files' own prose NAMES the
// identifiers they deliberately no longer use, so a bare substring search for a
// removed symbol matches the explanation rather than the code.


describe("296 item 2: the stale-artifact sweep", () => {

  it("and that case is REACHABLE, so the default was never the only path", () => {
    // Behavioural, not source-text. This is why the default could not simply be
    // deleted: a hand-crafted POST carrying a bogus intent still lands here.
    expect(parseManualIntent("garbage")).toBeNull();
    expect(parseManualIntent(null)).toBeNull();
    expect(parseManualIntent(42)).toBeNull();
    // REGRESSION GUARD: the five real intents still parse, or the honest
    // refusal above would start swallowing legitimate submissions.
    for (const ok of ["trigger", "mark_recovered", "cancel", "resend", "note"]) {
      expect(parseManualIntent(ok)).toBe(ok);
    }
  });
});
