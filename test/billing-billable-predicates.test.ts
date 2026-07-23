import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { billingLineItems } from "~/db";
import { isBillableDisputeRow, isBillableRecoveryRow } from "~/lib/billing/billable-predicates";
import { RECOVERY_MATURITY_MS } from "~/lib/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import { seedDemoAccount } from "~/lib/demo/seed";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-demo-engine-review-fixes.md M-2: the row-level billable rules
// used to be hand-rolled twice (app/db/billable.ts's SQL and a drifted inline
// filter in app/lib/demo/seed.ts). Both now consume the same pure predicates
// in app/lib/billing/billable-predicates.ts. These tests cover the predicates
// directly (including the fail-closed property the allow-list exists for) and
// cross-check that the seeded ledger is exactly what the predicates select.

const now = new Date("2026-07-21T00:00:00.000Z");
const ACCOUNT_ID = "demo_teamflow";
const MEMBER_EMAIL = "demo@foxhoundapp.com";
const MATURED_AT = new Date(now.getTime() - RECOVERY_MATURITY_MS - 24 * 60 * 60 * 1000); // 31 days ago
const UNMATURED_AT = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

describe("isBillableRecoveryRow", () => {
  it("is billable for a matured, attributed recovery with no exclusions", () => {
    expect(
      isBillableRecoveryRow({ attributionKind: "foxhound_retry", recoveredAt: MATURED_AT }, now.getTime()),
    ).toBe(true);
  });

  it("is never billable for the free baseline kind, even when matured", () => {
    expect(
      isBillableRecoveryRow({ attributionKind: "stripe_baseline", recoveredAt: MATURED_AT }, now.getTime()),
    ).toBe(false);
  });

  it("fails closed on an unrecognized attribution kind (the allow-list property)", () => {
    expect(
      isBillableRecoveryRow({ attributionKind: "some_future_kind", recoveredAt: MATURED_AT }, now.getTime()),
    ).toBe(false);
  });

  it("fails closed when attributionKind was never set", () => {
    expect(isBillableRecoveryRow({ attributionKind: undefined, recoveredAt: MATURED_AT }, now.getTime())).toBe(
      false,
    );
  });

  it("is not billable before the 30-day maturity window closes", () => {
    expect(
      isBillableRecoveryRow({ attributionKind: "foxhound_retry", recoveredAt: UNMATURED_AT }, now.getTime()),
    ).toBe(false);
  });

  it("is not billable once refunded, disputed, or soft-deleted", () => {
    const base = { attributionKind: "foxhound_retry" as const, recoveredAt: MATURED_AT };
    expect(isBillableRecoveryRow({ ...base, refundedAt: MATURED_AT }, now.getTime())).toBe(false);
    expect(isBillableRecoveryRow({ ...base, disputedAt: MATURED_AT }, now.getTime())).toBe(false);
    expect(isBillableRecoveryRow({ ...base, deletedAt: MATURED_AT }, now.getTime())).toBe(false);
  });
});

describe("isBillableDisputeRow", () => {
  it("is billable when won, submitted, and approved", () => {
    expect(
      isBillableDisputeRow({ state: "resolved_won", submittedAt: MATURED_AT, resolvedAt: MATURED_AT }, true, now.getTime()),
    ).toBe(true);
  });

  it("is not billable without an approval row, even if won and submittedAt is set (the merchant-won case)", () => {
    expect(
      isBillableDisputeRow({ state: "resolved_won", submittedAt: MATURED_AT, resolvedAt: MATURED_AT }, false, now.getTime()),
    ).toBe(false);
  });

  it("is not billable when lost", () => {
    expect(
      isBillableDisputeRow({ state: "resolved_lost", submittedAt: MATURED_AT, resolvedAt: MATURED_AT }, true, now.getTime()),
    ).toBe(false);
  });

  it("is not billable while still pending review", () => {
    expect(isBillableDisputeRow({ state: "pending_review", submittedAt: null, resolvedAt: null }, false, now.getTime())).toBe(
      false,
    );
  });
});

describe("the seeded billing ledger equals what the predicates select", () => {
  it("matches the seeder's own billable recoveries and disputes exactly", async () => {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, now);

    // Recompute independently from the same seed builders the orchestrator uses.
    const customers = buildTeamflowBase(now);
    const recovery = buildRecoverySeed(ACCOUNT_ID, customers, now);
    const disputesSeed = buildDisputesSeed(ACCOUNT_ID, now, MEMBER_EMAIL);
    const approvedDisputeIds = new Set(disputesSeed.disputeApprovals.map((a) => a.disputeId));

    const expectedRecoveryIds = new Set(
      recovery.recoveredPayments.filter((r) => isBillableRecoveryRow(r, now.getTime())).map((r) => r.id),
    );
    const expectedDisputeIds = new Set(
      disputesSeed.disputes
        .filter((d) => isBillableDisputeRow(d, approvedDisputeIds.has(d.id as string), now.getTime()))
        .map((d) => d.id),
    );

    const lineItems = await db.select().from(billingLineItems).where(eq(billingLineItems.accountId, ACCOUNT_ID));
    const recoveryLineItems = lineItems.filter((li) => li.type === "recovery_fee");
    const disputeLineItems = lineItems.filter((li) => li.type === "dispute_fee");

    expect(recoveryLineItems.map((li) => li.recoveredPaymentId).sort()).toEqual([...expectedRecoveryIds].sort());
    expect(disputeLineItems.map((li) => li.disputeId).sort()).toEqual([...expectedDisputeIds].sort());
  });

  it("carries exactly the two Foxhound-submitted wins (Harborline, Amy Chen), never the merchant-won Sara Lin", async () => {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, now);
    const lineItems = await db
      .select()
      .from(billingLineItems)
      .where(eq(billingLineItems.accountId, ACCOUNT_ID));
    const disputeLineItems = lineItems.filter((li) => li.type === "dispute_fee");
    expect(disputeLineItems.map((li) => li.disputeId).sort()).toEqual(["ddisp_1", "ddisp_7"]);
  });
});
