import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildRecoveryStepInserts } from "~/lib/engine/intake";
import { decideEmailStep, decideRetryStep } from "~/lib/engine/step-runner";
import { SEND_MAX_ATTEMPTS } from "~/lib/constants";
import { planRecoverySteps } from "~/lib/recovery/schedule";

const now = new Date("2026-07-10T12:00:00.000Z");

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
