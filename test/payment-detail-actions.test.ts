import { readFileSync } from "node:fs";

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

const SOURCE = readFileSync("app/routes/app/recovery/payments/detail.tsx", "utf8");

describe("S7 action labels: the ratified rename", () => {
  it("carries Stop recovery", () => {
    expect(MANUAL_ACTIONS.map((a) => a.label)).toContain("Stop recovery");
  });

  it("renders neither Cancel subscription nor Cancel recovery as a label", () => {
    const labels = MANUAL_ACTIONS.map((a) => a.label);
    expect(labels).not.toContain("Cancel subscription");
    expect(labels).not.toContain("Cancel recovery");
  });

  it("keeps the cancel INTENT, because only the label was ratified", () => {
    expect(MANUAL_ACTIONS.map((a) => a.intent)).toContain("cancel");
  });
});

describe("S7 action set: legacy's four, in legacy's order", () => {
  it("is exactly four actions", () => {
    expect(MANUAL_ACTIONS).toHaveLength(4);
  });

  it("matches legacy's order", () => {
    expect(MANUAL_ACTIONS.map((a) => a.label)).toEqual([
      "Trigger next step now",
      "Mark as recovered",
      "Stop recovery",
      "Resend last email",
    ]);
  });

  it("drops the two intents legacy has no counterpart for", () => {
    const intents = MANUAL_ACTIONS.map((a) => a.intent);
    expect(intents).not.toContain("note");
    expect(intents).not.toContain("override_next_email");
    expect(intents).not.toContain("retry_now");
  });

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

  it("the component gates the row on that status rather than always rendering it", () => {
    // The capture's whole point: a terminal payment shows no action row at all.
    expect(SOURCE).toContain("actionsVisible ? (");
    expect(SOURCE).toContain("failedPayment.status === ACTIONS_VISIBLE_STATUS");
  });
});

describe("S7 channel labels: removed per ruling 251", () => {
  it("renders no per-step channel tag", () => {
    // Legacy carries no such tag, so removal is the zero-ratification path.
    expect(SOURCE).not.toMatch(/"Customer email"/);
    expect(SOURCE).not.toMatch(/"Customer action"/);
    expect(SOURCE).not.toMatch(/const channel =/);
  });
});
