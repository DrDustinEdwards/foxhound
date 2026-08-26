import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  ATTRIBUTION_KINDS,
  BILLABLE_ATTRIBUTION_KINDS,
  MANUAL_ATTRIBUTION_KIND,
} from "~/lib/constants";
import {
  type AttributionStepRow,
  findAttributionSignals,
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

  it("every attribution kind is CONSCIOUSLY classified billable or free", () => {
    // app/db/billable.ts's SQL predicate and isBillableAttribution here both
    // consolidated onto this one allow-list (2026-07-19); this guards against
    // the two ever drifting apart again if a future attribution kind is added
    // to the CHECK constraint without also updating the allow-list.
    //
    // RESHAPED BY RULING 262 DECISION ONE, S7 Phase 2 Session E. This used to
    // assert billable === ATTRIBUTION_KINDS minus stripe_baseline, which held
    // only while exactly four kinds existed and "not baseline" happened to mean
    // "billable". `manual` is the fifth kind and it is FREE, so that equivalence
    // is now false. The guard's real intent, stated in its own comment above, is
    // that a new kind cannot ship without being classified, and that is what the
    // assertion now encodes: the two sets PARTITION ATTRIBUTION_KINDS exactly, so
    // a sixth kind added to neither list still fails here.
    const FREE_ATTRIBUTION_KINDS = ["stripe_baseline", MANUAL_ATTRIBUTION_KIND];
    expect([...BILLABLE_ATTRIBUTION_KINDS, ...FREE_ATTRIBUTION_KINDS].sort()).toEqual(
      [...ATTRIBUTION_KINDS].sort(),
    );
    // Disjoint, so a kind cannot be quietly counted as both.
    for (const kind of FREE_ATTRIBUTION_KINDS) {
      expect([...BILLABLE_ATTRIBUTION_KINDS]).not.toContain(kind);
    }
  });

  it("a MERCHANT-asserted recovery is never billable (262 decision one)", () => {
    expect(isBillableAttribution(MANUAL_ATTRIBUTION_KIND)).toBe(false);
  });
});

// M1 (Phase 4 review, closed 2026-07-18 slice 5g): webhooks/process.ts's
// resolveRecoveryAttribution reads recovery_steps and calls
// findAttributionSignals before resolveAttribution. These prove the wiring
// a card_update signal actually reaches resolveAttribution as cardUpdateRef,
// and that it does not override a signal earlier in precedence.
// The recovery instant these signals are resolved against. Inside the 14-day
// engagement window of the one click fixture below (377(2)), so the window
// never silently decides an assertion that is about precedence.
const RECOVERED_AT = new Date("2026-07-05T00:00:00.000Z");

describe("findAttributionSignals (webhooks/process.ts's read of recovery_steps)", () => {
  const step = (over: Partial<AttributionStepRow>): AttributionStepRow => ({
    id: "step_x",
    stepType: "email_day1",
    result: null,
    clickedAt: null,
    ...over,
  });

  it("a completed card_update step produces cardUpdateRef -> attribution_kind card_update", () => {
    const steps = [
      step({ id: "step_1", stepType: "email_day1", result: "email_sent" }),
      step({ id: "step_2", stepType: "card_update", result: "card_updated" }),
    ];
    const signals = findAttributionSignals(steps, RECOVERED_AT);
    expect(signals.cardUpdateRef).toBe("step_2");
    expect(resolveAttribution(signals)).toEqual({ kind: "card_update", ref: "step_2" });
  });

  it("an incomplete card_update step (no result yet) is not a signal", () => {
    const steps = [step({ id: "step_1", stepType: "card_update", result: null })];
    expect(findAttributionSignals(steps, RECOVERED_AT).cardUpdateRef).toBeNull();
    expect(resolveAttribution(findAttributionSignals(steps, RECOVERED_AT))).toEqual({
      kind: "stripe_baseline",
      ref: null,
    });
  });

  it("regression: a card_update signal does NOT override an earlier succeeded retry", () => {
    const steps = [
      step({ id: "step_1", stepType: "retry_early", result: "retry_succeeded" }),
      step({ id: "step_2", stepType: "card_update", result: "card_updated" }),
    ];
    const signals = findAttributionSignals(steps, RECOVERED_AT);
    expect(signals.succeededRetryStepId).toBe("step_1");
    expect(signals.cardUpdateRef).toBe("step_2");
    // Both signals are present in the row set; precedence must still pick retry.
    expect(resolveAttribution(signals)).toEqual({ kind: "foxhound_retry", ref: "step_1" });
  });

  it("regression: a card_update signal does not get shadowed by, nor shadow, an unrelated click", () => {
    const steps = [
      step({ id: "step_1", stepType: "email_day1", clickedAt: new Date("2026-07-01T00:00:00.000Z") }),
      step({ id: "step_2", stepType: "card_update", result: "card_updated" }),
    ];
    const signals = findAttributionSignals(steps, RECOVERED_AT);
    expect(signals.clickedEngagementId).toBe("step_1");
    expect(signals.cardUpdateRef).toBe("step_2");
    // card_update outranks email_engaged in precedence (attribution.ts).
    expect(resolveAttribution(signals)).toEqual({ kind: "card_update", ref: "step_2" });
  });

  it("no signals at all falls through to stripe_baseline, never a false card_update", () => {
    const steps = [step({ id: "step_1", stepType: "email_day1", result: "email_sent" })];
    expect(resolveAttribution(findAttributionSignals(steps, RECOVERED_AT))).toEqual({
      kind: "stripe_baseline",
      ref: null,
    });
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
