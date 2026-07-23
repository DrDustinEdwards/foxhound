import { describe, expect, it } from "vitest";

import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import { buildIntelligenceSeed } from "~/lib/demo/intelligence-seed";
import { buildNarrativeSeed } from "~/lib/demo/narratives-seed";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";

// TASK-foxhound-demo-data-engine.md Phase 3: customer_context, health history,
// mrr_snapshots (real movement math, monthly cadence matching the real
// intelligence-sync cron), demo alerts, and the pre-written narrative.

const now = new Date("2026-07-21T00:00:00.000Z");
const ACCOUNT_ID = "demo_teamflow";
const MEMBER_EMAIL = "demo@foxhoundapp.com";

function seedAll() {
  const customers = buildTeamflowBase(now);
  const recovery = buildRecoverySeed(ACCOUNT_ID, customers, now);
  const disputes = buildDisputesSeed(ACCOUNT_ID, now, MEMBER_EMAIL);
  const intelligence = buildIntelligenceSeed({
    accountId: ACCOUNT_ID,
    now,
    customers,
    failedPayments: recovery.failedPayments,
    recoveredPayments: recovery.recoveredPayments,
    disputes: disputes.disputes,
  });
  return { customers, recovery, disputes, intelligence };
}

describe("buildIntelligenceSeed", () => {
  it("is deterministic", () => {
    const a = seedAll().intelligence;
    const b = seedAll().intelligence;
    expect(b).toEqual(a);
  });

  it("scores every one of the 200 base customers plus the 7 net-new dispute customers", () => {
    const { intelligence } = seedAll();
    // 200 base + 7 dispute customers (8 disputes total, 1 of which - Harborline
    // - is already one of the 200, not net-new).
    expect(intelligence.customerContext).toHaveLength(207);
    expect(intelligence.customerContext.every((c) => c.healthScore !== null)).toBe(true);
  });

  it("Harborline Group's context carries its dispute signals, not a duplicate row", () => {
    const { intelligence } = seedAll();
    const rows = intelligence.customerContext.filter((c) => c.stripeCustomerId === "cus_teamflow_harborline_group");
    expect(rows).toHaveLength(1);
    const signals = rows[0].disputeSignals as { wonCount: number };
    expect(signals.wonCount).toBe(1);
  });

  it("Acme's recovered-save and Bluewave's active-recovery narratives score in the documented bands", () => {
    const { intelligence } = seedAll();
    const acme = intelligence.customerContext.find((c) => c.stripeCustomerId === "cus_teamflow_acme_industries");
    const bluewave = intelligence.customerContext.find((c) => c.stripeCustomerId === "cus_teamflow_bluewave_studios");
    expect(acme!.healthScore).toBe(58);
    expect(bluewave!.healthScore).toBe(28);
  });

  it("every health_score_history row points at a real customer_context row", () => {
    const { intelligence } = seedAll();
    const ctxIds = new Set(intelligence.customerContext.map((c) => c.id));
    for (const h of intelligence.healthScoreHistory) expect(ctxIds.has(h.customerContextId)).toBe(true);
  });

  it("mrr_snapshots has exactly 12 monthly points, oldest to newest, and the latest total is positive", () => {
    const { intelligence } = seedAll();
    expect(intelligence.mrrSnapshots).toHaveLength(12);
    const sorted = [...intelligence.mrrSnapshots].sort(
      (a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime(),
    );
    expect(sorted).toEqual(intelligence.mrrSnapshots);
    expect(sorted[sorted.length - 1].totalMrrCents).toBeGreaterThan(0);
  });

  it("mrr grows across the 12-month arc as customers join (not a flat line)", () => {
    const { intelligence } = seedAll();
    const first = intelligence.mrrSnapshots[0].totalMrrCents;
    const last = intelligence.mrrSnapshots[intelligence.mrrSnapshots.length - 1].totalMrrCents;
    expect(last).toBeGreaterThan(first);
  });

  it("seeds the 3 demo alert rules plus 1 fired history row", () => {
    const { intelligence } = seedAll();
    expect(intelligence.alerts).toHaveLength(3);
    expect(intelligence.alertHistory).toHaveLength(1);
  });
});

describe("buildNarrativeSeed", () => {
  it("is deterministic and produces one report for the current month", () => {
    const a = buildNarrativeSeed(ACCOUNT_ID, now);
    const b = buildNarrativeSeed(ACCOUNT_ID, now);
    expect(b).toEqual(a);
    expect(a.narrative.length).toBeGreaterThan(0);
    expect(a.accountId).toBe(ACCOUNT_ID);
  });

  it("never names Claude, Anthropic, or Recova", () => {
    const { narrative } = buildNarrativeSeed(ACCOUNT_ID, now);
    expect(narrative).not.toMatch(/claude|anthropic|recova/i);
  });

  // TASK-foxhound-demo-engine-review-fixes.md L-1: Driftwave Labs is a
  // Bolt-base customer, never seeded (Teamflow only), so the name resolves to
  // nothing anywhere in this demo and must not appear in prospect-facing copy.
  it("never names Driftwave (a Bolt-base customer that is never seeded)", () => {
    const { narrative } = buildNarrativeSeed(ACCOUNT_ID, now);
    expect(narrative).not.toMatch(/driftwave/i);
  });

  // M-1: a hard dispute-outcome count here can silently contradict the
  // Disputes page as the seeded outcome mix changes; the sentence must stay
  // qualitative.
  it("never hardcodes a dispute win/loss count", () => {
    const { narrative } = buildNarrativeSeed(ACCOUNT_ID, now);
    expect(narrative).not.toMatch(/\b(one|two|three|four|five|\d+)\s+disputes?\b/i);
  });
});
