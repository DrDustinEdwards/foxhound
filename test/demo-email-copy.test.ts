import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import type { DeclineCategory } from "~/lib/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { demoEmailCopyFor, demoWinBackCopyFor } from "~/lib/demo/email-copy";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import { RECOVERY_SCHEDULES, WIN_BACK_SCHEDULE, isEmailStep } from "~/lib/recovery/schedule";

const now = new Date("2026-07-21T00:00:00.000Z");
const ACCOUNT_ID = "demo_teamflow";

const ctx = {
  customerName: "Dana Whitfield",
  amountCents: 4900,
  currency: "usd",
  planName: "Growth",
  merchantName: "Teamflow",
};

function seed() {
  return buildRecoverySeed(ACCOUNT_ID, buildTeamflowBase(now), now);
}

describe("demo email copy covers the real schedule", () => {
  // If a schedule gains an email step and this file does not, the seed would
  // silently ship a body-less step again, which is the regression that made the
  // preview disclosure invisible in the first place.
  it("resolves copy for every email step in every category schedule", () => {
    const missing: string[] = [];
    for (const [category, steps] of Object.entries(RECOVERY_SCHEDULES)) {
      for (const step of steps) {
        if (!isEmailStep(step.stepType)) continue;
        if (!demoEmailCopyFor(category as DeclineCategory, step.stepType, ctx)) {
          missing.push(`${category}/${step.stepType}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves copy for every win-back step", () => {
    for (const step of WIN_BACK_SCHEDULE) {
      expect(demoWinBackCopyFor(step.stepNumber, ctx)).not.toBeNull();
    }
  });

  it("returns null rather than a generic body for a step type not in the schedule", () => {
    expect(demoEmailCopyFor("soft", "email_day99", ctx)).toBeNull();
    expect(demoWinBackCopyFor(99, ctx)).toBeNull();
  });
});

describe("demo email copy content rules", () => {
  function everyCopy() {
    const out: { key: string; subject: string; bodyHtml: string }[] = [];
    for (const [category, steps] of Object.entries(RECOVERY_SCHEDULES)) {
      for (const step of steps) {
        if (!isEmailStep(step.stepType)) continue;
        const copy = demoEmailCopyFor(category as DeclineCategory, step.stepType, ctx);
        if (copy) out.push({ key: `${category}/${step.stepType}`, ...copy });
      }
    }
    for (const step of WIN_BACK_SCHEDULE) {
      const copy = demoWinBackCopyFor(step.stepNumber, ctx);
      if (copy) out.push({ key: `winback/${step.stepNumber}`, ...copy });
    }
    return out;
  }

  // DESIGN.md: a dunning email reads as the MERCHANT's voice. Naming Foxhound
  // inside the customer-facing body breaks that, and it is exactly the kind of
  // thing a copy edit reintroduces by accident.
  it("never names Foxhound in a body or subject", () => {
    for (const c of everyCopy()) {
      expect(c.subject, c.key).not.toMatch(/foxhound/i);
      expect(c.bodyHtml.replace(/href="[^"]*"/g, ""), c.key).not.toMatch(/foxhound/i);
    }
  });

  it("uses no em or en dashes", () => {
    for (const c of everyCopy()) {
      expect(`${c.subject}${c.bodyHtml}`, c.key).not.toMatch(/[–—]/);
    }
  });

  // The preview renders through sanitizeEmailPreviewHtml before it reaches the
  // browser. Copy that does not survive the allowlist would render mangled.
  it("survives the preview sanitizer unchanged", () => {
    for (const c of everyCopy()) {
      expect(sanitizeEmailPreviewHtml(c.bodyHtml), c.key).toBe(c.bodyHtml);
    }
  });

  it("personalizes with the customer's first name and the real amount", () => {
    const copy = demoEmailCopyFor("expired", "email_day1", ctx);
    expect(copy?.bodyHtml).toContain("Hi Dana");
    expect(copy?.bodyHtml).toContain("$49.00");
  });

  it("greets neutrally rather than with a null name", () => {
    const copy = demoEmailCopyFor("expired", "email_day1", { ...ctx, customerName: null });
    expect(copy?.bodyHtml).toContain("Hello");
    expect(copy?.bodyHtml).not.toContain("null");
  });
});

describe("the seed writes email copy onto its steps", () => {
  it("gives every seeded email step a subject and a body", () => {
    const { recoverySteps } = seed();
    const emailSteps = recoverySteps.filter((s) => isEmailStep(s.stepType));
    expect(emailSteps.length).toBeGreaterThan(0);
    const bodyless = emailSteps.filter((s) => !s.aiSubject || !s.aiBodyHtml);
    expect(bodyless).toEqual([]);
  });

  it("gives every seeded win-back step a subject and a body", () => {
    const { winBackSteps } = seed();
    expect(winBackSteps.length).toBeGreaterThan(0);
    expect(winBackSteps.filter((s) => !s.aiSubject || !s.aiBodyHtml)).toEqual([]);
  });

  it("leaves no retry step carrying email copy", () => {
    const { recoverySteps } = seed();
    const retriesWithCopy = recoverySteps.filter((s) => !isEmailStep(s.stepType) && s.aiBodyHtml);
    expect(retriesWithCopy).toEqual([]);
  });
});

describe("the seed exercises every decline category", () => {
  // /recovery/sequences ships a section per category. Before this, revoked and
  // unknown got zero rows, so two sections read "No data yet" and the
  // fail-closed classifier had no visible evidence.
  //
  // This assertion is swept ACROSS DATES on purpose. The first version checked a
  // single `now` and passed, and the seed then shipped with `revoked` absent on
  // 11 of 30 dates: the weighted roll puts revoked and unknown at 4% each, so
  // zero draws is ordinary, and the live cold seed on 2026-07-25 produced five
  // categories rather than six. A single-date assertion cannot see that.
  it("produces at least one failed payment in every category, on every date in a 40-day sweep", () => {
    const gaps: string[] = [];
    for (let d = 0; d < 40; d++) {
      const at = new Date(Date.UTC(2026, 6, 1) + d * 24 * 60 * 60 * 1000);
      const { failedPayments } = buildRecoverySeed(ACCOUNT_ID, buildTeamflowBase(at), at);
      const seen = new Set(failedPayments.map((f) => f.declineCategory));
      const missing = DECLINE_CATEGORIES.filter((c) => !seen.has(c));
      if (missing.length > 0) gaps.push(`${at.toISOString().slice(0, 10)}: ${missing.join(",")}`);
    }
    expect(gaps).toEqual([]);
  });

  it("adds nothing on a date the walk already covered", () => {
    // 2026-07-21 is a date whose unaided roll already produced all six, so the
    // top-up must be a no-op there rather than inflating the count.
    const at = new Date("2026-07-21T00:00:00.000Z");
    const { failedPayments } = buildRecoverySeed(ACCOUNT_ID, buildTeamflowBase(at), at);
    const counts = new Map<string, number>();
    for (const f of failedPayments) counts.set(f.declineCategory, (counts.get(f.declineCategory) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...DECLINE_CATEGORIES].sort());
    expect(failedPayments).toHaveLength(76);
  });

  it("keeps revoked and unknown rare rather than distorting the mix", () => {
    const { failedPayments } = seed();
    const share = (c: string) =>
      failedPayments.filter((f) => f.declineCategory === c).length / failedPayments.length;
    expect(share("revoked")).toBeLessThan(0.15);
    expect(share("unknown")).toBeLessThan(0.15);
    expect(share("soft")).toBeGreaterThan(0.3);
  });
});
