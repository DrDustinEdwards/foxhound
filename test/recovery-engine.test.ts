import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildRecoveryStepInserts } from "~/lib/engine/intake";
import {
  isSequenceComplete,
  isStepDue,
  nextDueStep,
  selectDueSteps,
  type SchedulableStep,
} from "~/lib/engine/scheduler";
import {
  decideEmailStep,
  decideRetryStep,
} from "~/lib/engine/step-runner";
import { SEND_MAX_ATTEMPTS } from "~/lib/constants";
import { planRecoverySteps } from "~/lib/recovery/schedule";

const now = new Date("2026-07-10T12:00:00.000Z");

function step(overrides: Partial<SchedulableStep>): SchedulableStep {
  return {
    stepNumber: 1,
    scheduledAt: new Date("2026-07-10T00:00:00.000Z"),
    executedAt: null,
    result: null,
    nextRetryAt: null,
    ...overrides,
  };
}

describe("scheduler due-step selection", () => {

  it("an executed or resolved step is never due", () => {
    expect(isStepDue(step({ executedAt: now }), now)).toBe(false);
    expect(isStepDue(step({ result: "email_sent" }), now)).toBe(false);
  });

  it("a rescheduled step becomes due at next_retry_at, not scheduled_at", () => {
    const rescheduled = step({ nextRetryAt: new Date("2026-07-10T18:00:00.000Z") });
    expect(isStepDue(rescheduled, now)).toBe(false); // retry time is in the future
    expect(isStepDue(rescheduled, new Date("2026-07-10T18:00:00.000Z"))).toBe(true);
  });

  it("selects due steps earliest-first and picks the next one", () => {
    const steps = [
      step({ stepNumber: 2, scheduledAt: new Date("2026-07-10T06:00:00.000Z") }),
      step({ stepNumber: 1, scheduledAt: new Date("2026-07-10T03:00:00.000Z") }),
      step({ stepNumber: 3, scheduledAt: new Date("2026-07-11T00:00:00.000Z") }), // future
    ];
    const due = selectDueSteps(steps, now);
    expect(due.map((s) => s.stepNumber)).toEqual([1, 2]);
    expect(nextDueStep(steps, now)?.stepNumber).toBe(1);
  });

  it("sequence is complete only when every step has executed", () => {
    expect(isSequenceComplete([step({ executedAt: now }), step({ executedAt: now })])).toBe(true);
    expect(isSequenceComplete([step({ executedAt: now }), step({})])).toBe(false);
    expect(isSequenceComplete([])).toBe(false);
  });
});

describe("step-runner: retry deciders", () => {

  it("a paid invoice is a recovered retry (record foxhound_retry)", () => {
    const d = decideRetryStep({ invoiceStatus: "paid" }, now);
    expect(d.retryResult).toBe("retry_succeeded");
    expect(d.recovered).toBe(true);
    expect(d.patch.result).toBe("retry_succeeded");
    expect(d.patch.executedAt).toEqual(now);
  });

  it("an unpaid invoice resolves the step without recording", () => {
    const d = decideRetryStep({ invoiceStatus: "open" }, now);
    expect(d.retryResult).toBe("retry_failed");
    expect(d.recovered).toBe(false);
  });
});

describe("step-runner: email deciders", () => {
  it("a successful send marks the step sent", () => {
    const p = decideEmailStep({ attemptCount: 0 }, { ok: true }, now);
    expect(p.result).toBe("email_sent");
    expect(p.executedAt).toEqual(now);
    expect(p.nextRetryAt).toBeNull();
    expect(p.attemptCount).toBe(1);
  });

  it("a transient failure reschedules with backoff", () => {
    const p = decideEmailStep({ attemptCount: 0 }, { ok: false, error: "timeout" }, now);
    expect(p.result).toBeNull();
    expect(p.nextRetryAt).not.toBeNull();
    expect(p.lastAttemptError).toBe("timeout");
  });

  it("a transient failure at the last attempt goes terminal", () => {
    const p = decideEmailStep(
      { attemptCount: SEND_MAX_ATTEMPTS - 1 },
      { ok: false, error: "still down" },
      now,
    );
    expect(p.result).toBe("email_failed");
    expect(p.nextRetryAt).toBeNull();
  });
});

describe("intake step inserts (compile against schema, no live D1)", () => {
  it("compiles one insert per planned step with the step columns bound", () => {
    const db = drizzle({} as never, { schema });
    const planned = planRecoverySteps({
      failedPaymentId: "fp_1",
      accountId: "acc_1",
      declineCategory: "soft",
      detectedAt: now,
    });
    const inserts = buildRecoveryStepInserts(db, planned);
    expect(inserts.length).toBe(planned.length);
    const sql = inserts[0].toSQL();
    expect(sql.sql).toMatch(/insert into .*recovery_steps/i);
    expect(sql.params).toContain("fp_1");
    expect(sql.params).toContain("acc_1");
  });
});
