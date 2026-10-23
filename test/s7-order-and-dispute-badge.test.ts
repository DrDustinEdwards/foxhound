
import { describe, expect, it } from "vitest";

import { RESOLVED_DISPUTE_STATES, isDisputeResolved } from "~/lib/disputes/labels";

// RULING 304: the section reorder (closing 295 Q1) and the open-dispute badge
// (closing 295 Q2), both read from legacy PaymentDetailClient.tsx at blob
// 7f54aa45 rather than from the scope doc's summary.
//
// Legacy's section sequence, from the blob's own comment markers:
//   229 back+header, 273 intelligence banner, 276 ACTION RESULT BANNER,
//   289 ACTION BUTTONS, 329 stripe links, 362 top info cards,
//   370 details+engagement, 423 timeline, 573 internal notes,
//   599 RECOVERY SUCCESS BANNER (last).
//
// After 304's normalization commit the tree is LF, so no CRLF handling here.





describe("304 build 2: the open-dispute badge", () => {

  it("BEHAVIOUR: the constant and the helper agree on what open means", () => {
    // Not source text. If a state joins RESOLVED_DISPUTE_STATES, both the query
    // and the helper move together, and this proves they still agree.
    for (const s of RESOLVED_DISPUTE_STATES) expect(isDisputeResolved(s)).toBe(true);
    for (const s of ["draft", "pending_review", "approved", "submitted"]) {
      expect(isDisputeResolved(s)).toBe(false);
    }
    expect(RESOLVED_DISPUTE_STATES.length).toBeGreaterThan(0);
  });
});
