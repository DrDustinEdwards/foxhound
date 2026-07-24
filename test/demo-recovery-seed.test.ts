import { describe, expect, it } from "vitest";

import { ATTRIBUTION_KINDS } from "~/lib/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { classifyDecline } from "~/lib/recovery/decline";

// TASK-foxhound-demo-data-engine.md Phase 2: the day-walk failed-payment
// simulator, win-back, and expiring-card alerts. Every row is built to the
// exact shape the REAL webhook/executor flow would have written, reusing
// schedule.ts/decline.ts/attribution.ts rather than a parallel model.

const now = new Date("2026-07-21T00:00:00.000Z");
const ACCOUNT_ID = "demo_teamflow";

function seed() {
  return buildRecoverySeed(ACCOUNT_ID, buildTeamflowBase(now), now);
}

describe("buildRecoverySeed", () => {
  it("is deterministic: two calls with the same `now` produce identical output", () => {
    const a = seed();
    const b = seed();
    expect(b.failedPayments).toEqual(a.failedPayments);
    expect(b.recoverySteps).toEqual(a.recoverySteps);
    expect(b.recoveredPayments).toEqual(a.recoveredPayments);
    expect(b.winBackSequences).toEqual(a.winBackSequences);
    expect(b.expiringCardAlerts).toEqual(a.expiringCardAlerts);
  });

  it("places Acme Industries' 3 scripted failures, all recovered", () => {
    const { failedPayments } = seed();
    const acme = failedPayments.filter((f) => f.stripeCustomerId === "cus_teamflow_acme_industries");
    expect(acme).toHaveLength(3);
    expect(acme.every((f) => f.status === "recovered")).toBe(true);
    expect(acme.every((f) => f.resolvedAt !== null)).toBe(true);
  });

  it("places Bluewave Studios' active in-progress recovery", () => {
    const { failedPayments } = seed();
    const bluewave = failedPayments.filter((f) => f.stripeCustomerId === "cus_teamflow_bluewave_studios");
    expect(bluewave).toHaveLength(3);
    const active = bluewave.filter((f) => f.status === "active");
    expect(active).toHaveLength(1);
  });

  it("every recovery_step row belongs to a failed payment that was actually built", () => {
    const { failedPayments, recoverySteps } = seed();
    const fpIds = new Set(failedPayments.map((f) => f.id));
    for (const step of recoverySteps) expect(fpIds.has(step.failedPaymentId)).toBe(true);
  });

  it("every recovered_payments row has a valid attribution kind and points at a real failed payment", () => {
    const { failedPayments, recoveredPayments } = seed();
    const fpIds = new Set(failedPayments.map((f) => f.id));
    expect(recoveredPayments.length).toBeGreaterThan(0);
    for (const r of recoveredPayments) {
      expect(fpIds.has(r.failedPaymentId)).toBe(true);
      expect(ATTRIBUTION_KINDS).toContain(r.attributionKind);
      if (r.attributionKind === "stripe_baseline") {
        expect(r.attributionRef).toBeNull();
      } else {
        expect(r.attributionRef).not.toBeNull();
      }
    }
  });

  it("recovered failed payments have a resolvedAt no earlier than detectedAt", () => {
    const { failedPayments } = seed();
    for (const f of failedPayments) {
      if (f.status === "recovered") {
        expect(f.resolvedAt).not.toBeNull();
        expect(f.resolvedAt!.getTime()).toBeGreaterThanOrEqual(f.detectedAt.getTime());
      }
    }
  });

  it("a mix of statuses exists across the day-walk (not everything active or recovered)", () => {
    const { failedPayments } = seed();
    const statuses = new Set(failedPayments.map((f) => f.status));
    expect(statuses.has("recovered")).toBe(true);
    expect(statuses.has("active")).toBe(true);
  });

  it("win-back sequences are bounded and every step belongs to a real sequence", () => {
    const { winBackSequences, winBackSteps } = seed();
    expect(winBackSequences.length).toBeGreaterThan(0);
    expect(winBackSequences.length).toBeLessThanOrEqual(8);
    const seqIds = new Set(winBackSequences.map((s) => s.id));
    for (const step of winBackSteps) expect(seqIds.has(step.winBackSequenceId)).toBe(true);
  });

  // TASK-foxhound-demo-system-completion.md Phase 2 (demo-surface-audit.md):
  // a recently churned candidate must never be resolved by a reactivation
  // coin-flip before its own schedule could plausibly have finished, or the
  // demo can show zero active win-backs on a given day even with a genuinely
  // in-flight candidate in the pool, leaving Recovery's overview card ("Win-
  // back: 0") looking broken next to a fully populated /recovery/winback page.
  it("always has at least one currently-active win-back sequence", () => {
    const { winBackSequences } = seed();
    expect(winBackSequences.some((s) => s.status === "active")).toBe(true);
  });

  // A prior bug sampled the scripted narrative's declineCode independently of
  // its hardcoded declineCategory, so a hero customer like Acme Industries
  // could show "Soft decline" next to a fraud code like lost_card. The code
  // must always classify back to the category it was stored with, for every
  // failed payment - scripted and day-walk alike.
  it("every seeded failed payment's declineCode classifies back to its own declineCategory", () => {
    const { failedPayments } = seed();
    expect(failedPayments.length).toBeGreaterThan(0);
    for (const f of failedPayments) {
      expect(classifyDecline(f.declineCode), `${f.stripeCustomerId} ${f.declineCode}`).toBe(f.declineCategory);
    }
  });

  it("expiring-card alerts are seeded and reference real customers", () => {
    const { expiringCardAlerts } = seed();
    expect(expiringCardAlerts.length).toBeGreaterThan(0);
    for (const alert of expiringCardAlerts) {
      expect(alert.expiresMonth).toBeGreaterThanOrEqual(1);
      expect(alert.expiresMonth).toBeLessThanOrEqual(12);
    }
  });
});
