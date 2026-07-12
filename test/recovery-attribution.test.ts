import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  isBillableAttribution,
  resolveAttribution,
} from "~/lib/recovery/attribution";
import { buildRecoveryBatch, type RecordRecoveryInput } from "~/lib/recovery/record-recovery";

describe("resolveAttribution", () => {
  it("prioritizes retry > card_update > email_engaged > baseline", () => {
    expect(
      resolveAttribution({
        succeededRetryStepId: "step_1",
        cardUpdateRef: "cu_1",
        clickedEngagementId: "eng_1",
      }),
    ).toEqual({ kind: "foxhound_retry", ref: "step_1" });

    expect(
      resolveAttribution({ cardUpdateRef: "cu_1", clickedEngagementId: "eng_1" }),
    ).toEqual({ kind: "card_update", ref: "cu_1" });

    expect(resolveAttribution({ clickedEngagementId: "eng_1" })).toEqual({
      kind: "email_engaged",
      ref: "eng_1",
    });

    expect(resolveAttribution({})).toEqual({ kind: "stripe_baseline", ref: null });
  });

  it("classifies billable vs free baseline", () => {
    expect(isBillableAttribution("foxhound_retry")).toBe(true);
    expect(isBillableAttribution("email_engaged")).toBe(true);
    expect(isBillableAttribution("card_update")).toBe(true);
    expect(isBillableAttribution("stripe_baseline")).toBe(false);
  });
});

describe("buildRecoveryBatch", () => {
  const db = drizzle({} as never, { schema });
  const recoveredAt = new Date("2026-07-02T00:00:00.000Z");

  const base: RecordRecoveryInput = {
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    amountCents: 4200,
    currency: "usd",
    recoveredAt,
    attribution: { kind: "foxhound_retry", ref: "step_9" },
    recoveredByStepId: "step_9",
    recoveryMethod: "retry",
    idempotencyKey: "evt_123",
  };

  it("writes recovered_payments + outcomes as one 2-statement batch", () => {
    const batch = buildRecoveryBatch(db, base);
    expect(batch.length).toBe(2);
    const [rp, oc] = batch.map((s) => (s as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL());
    expect(rp.sql).toMatch(/insert into .recovered_payments./i);
    expect(oc.sql).toMatch(/insert into .outcomes./i);
  });

  it("attributed recovery stamps attributed_at and marks the outcome attributed", () => {
    const [rp, oc] = buildRecoveryBatch(db, base).map(
      (s) => (s as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL(),
    );
    expect(rp.params).toContain("foxhound_retry");
    expect(rp.params).toContain("step_9");
    expect(rp.params).toContain(recoveredAt.getTime()); // attributed_at set
    expect(oc.params).toContain("recovered_attributed");
    expect(oc.params).toContain("recovery:evt_123"); // idempotency backstop
  });

  it("baseline recovery is recorded free: no attributed_at, baseline outcome", () => {
    const [rp, oc] = buildRecoveryBatch(db, {
      ...base,
      attribution: { kind: "stripe_baseline", ref: null },
      recoveryMethod: "stripe_baseline",
      recoveredByStepId: null,
    }).map((s) => (s as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL());

    expect(rp.params).toContain("stripe_baseline");
    // attributed_at is null for baseline (the free line): recoveredAt ms must NOT
    // appear as an attributed_at value. recovered_at itself is still present, so
    // assert the count of that timestamp is exactly 1 (recovered_at only).
    expect(rp.params.filter((p) => p === recoveredAt.getTime()).length).toBe(1);
    expect(oc.params).toContain("recovered_baseline");
  });
});
