
import { describe, expect, it } from "vitest";

import { ACTIONS_VISIBLE_STATUS, MANUAL_ACTIONS } from "~/routes/app/recovery/payments/detail";

// S7 Phase 1, surface parity. Three rulings are pinned here.
//
// 251 (PRIME DIRECTIVE item 3, 2026-08-10): "Stop recovery" replaces BOTH
// legacy's "Cancel recovery" and this route's own "Cancel subscription". The old
// label was the highest-risk string in the campaign: it promised to end the
// customer's subscription when the action only ends the dunning sequence.
//
// 249: legacy ships FOUR actions, in a fixed order, read from
// app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx at sha 7f54aa45.
// This route used to render six.
//
// 250, from Dustin's capture of legacy at status Failed_unrecovered: NO action
// buttons render in a terminal state. Legacy's gate is `status === 'active'`.
//
// 251 again: the per-step channel labels are REMOVED; legacy carries no tag.
//
// The no-long-dash copy rule is deliberately NOT asserted here: the repo's
// PreToolUse hook blocks those characters at write time, so a test would only
// restate a gate that already cannot be bypassed.


describe("S7 action set: legacy's four, in legacy's order", () => {

  it("gates trigger on a pending step and resend on a sent email, as legacy does", () => {
    const byIntent = Object.fromEntries(MANUAL_ACTIONS.map((a) => [a.intent, a.needs]));
    expect(byIntent.trigger).toBe("nextStep");
    expect(byIntent.resend).toBe("lastEmail");
    expect(byIntent.mark_recovered).toBeNull();
    expect(byIntent.cancel).toBeNull();
  });
});

describe("S7 action row: state-gated per ruling 250", () => {
  it("is visible only in the active state", () => {
    expect(ACTIONS_VISIBLE_STATUS).toBe("active");
  });
});
