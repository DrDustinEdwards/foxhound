import { drizzle } from "drizzle-orm/d1";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { SEND_MAX_ATTEMPTS } from "~/lib/constants";
import { appendOpenPixel } from "~/lib/email/templates";
import { buildEmailStepPatch, buildEngagementUrls, executeEmailStep, sendResultToAttempt, type EmailStepContext } from "~/lib/engine/execute-step";
import { buildRetryReconciliationInput, buildRetryStepPatch, executeRetryStep, payInvoiceWithClient, retryIdempotencyKey, type RetryStepContext } from "~/lib/engine/retry-step";
import { stepAction } from "~/lib/engine/step-runner";
import { nextDueStep, type SchedulableStep } from "~/lib/engine/scheduler";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { verifyEngagementToken } from "~/lib/engagement/token";
import type { RetryReconciliationInput } from "~/lib/recovery/record-recovery";
import { planRecoverySteps } from "~/lib/recovery/schedule";

const db = drizzle({} as never, { schema });
const now = new Date("2026-07-15T00:00:00.000Z");
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
const env = {
  ENCRYPTION_KEY: "a".repeat(64),
  BETTER_AUTH_URL: "https://foxhound.example",
  PHYSICAL_ADDRESS: "123 Main St, Springfield",
} as unknown as Env;

function retryCtx(overrides: Partial<RetryStepContext> = {}): RetryStepContext {
  return {
    stepId: "step_r",
    failedPaymentId: "fp_1",
    accountId: "acc_1",
    invoiceId: "in_1",
    amountCents: 4200,
    currency: "usd",
    connectionAccessToken: "iv:cipher",
    ...overrides,
  };
}

function emailCtx(overrides: Partial<EmailStepContext> = {}): EmailStepContext {
  return {
    stepId: "step_e",
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    stepType: "email_day1",
    attemptCount: 0,
    declineCategory: "soft",
    customerEmail: "customer@example.com",
    amountCents: 4200,
    currency: "usd",
    merchantName: "Acme",
    senderName: "Acme",
    voiceDescription: null,
    cached: { customBody: null, cachedSubject: "Subject", cachedBodyHtml: "<p>Body</p>" },
    ...overrides,
  };
}

describe("retry executor: operational persist (compile against schema)", () => {
  it("claims the step conditionally: sets result only when executed_at is null", () => {
    const sql = sqlOf(
      buildRetryStepPatch(db, "step_r", {
        executedAt: now,
        result: "retry_succeeded",
        retryResult: "retry_succeeded",
      }),
    );
    expect(sql.sql).toMatch(/update .*recovery_steps/i);
    expect(sql.sql).toMatch(/executed_at/i);
    expect(sql.sql).toMatch(/retry_result/i);
    expect(sql.sql).toMatch(/is null/i); // WHERE executed_at IS NULL = the claim
    expect(sql.params).toContain("retry_succeeded");
  });
});

describe("retry executor: reconciliation input", () => {
  it("identifies the failed payment and the succeeded step for a reverse-race correction", () => {
    const input = buildRetryReconciliationInput(retryCtx(), now);
    expect(input).toEqual({
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      stepId: "step_r",
      recoveredAt: now,
    });
  });
});

describe("retry executor: live charge seam", () => {
  it("passes the retry idempotency key so Stripe refuses a second charge", async () => {
    const calls: { id: string; options: unknown }[] = [];
    const stripe = {
      invoices: {
        pay: async (id: string, _params: unknown, options: { idempotencyKey?: string }) => {
          calls.push({ id, options });
          return { status: "paid" };
        },
      },
    } as unknown as Stripe;
    const attempt = await payInvoiceWithClient(stripe, retryCtx());
    expect(attempt).toEqual({ invoiceStatus: "paid" });
    expect((calls[0].options as { idempotencyKey: string }).idempotencyKey).toBe(
      retryIdempotencyKey("step_r"),
    );
  });

  it("classifies a thrown Stripe error as a threw attempt", async () => {
    const stripe = {
      invoices: {
        pay: async () => {
          throw { type: "StripeCardError" };
        },
      },
    } as unknown as Stripe;
    const attempt = await payInvoiceWithClient(stripe, retryCtx());
    expect(attempt.threw).toBe(true);
  });
});

describe("retry executor: orchestration + exactly-once", () => {
  it("calls the reconciliation seam only when the charge lands", async () => {
    const recorded: RetryReconciliationInput[] = [];
    let persisted = 0;
    const res = await executeRetryStep({} as Env, retryCtx(), {
      payInvoice: async () => ({ invoiceStatus: "paid" }),
      persistPatch: async () => {
        persisted += 1;
      },
      reconcileRecovery: async (_env, input) => {
        recorded.push(input);
        return true;
      },
    });
    expect(res).toEqual({ action: "retry", executed: true, recovered: true, retryResult: "retry_succeeded" });
    expect(persisted).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].stepId).toBe("step_r");
    expect(recorded[0].failedPaymentId).toBe("fp_1");
  });

  it("baseline-free: a failed retry never calls reconciliation", async () => {
    const recorded: RetryReconciliationInput[] = [];
    const res = await executeRetryStep({} as Env, retryCtx(), {
      payInvoice: async () => ({ invoiceStatus: "open" }),
      persistPatch: async () => {},
      reconcileRecovery: async (_env, input) => {
        recorded.push(input);
        return true;
      },
    });
    expect(res.recovered).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("two overlapping successful runs both reconcile against the same failed payment", async () => {
    const recorded: RetryReconciliationInput[] = [];
    const deps = {
      payInvoice: async () => ({ invoiceStatus: "paid" as const }),
      persistPatch: async () => {},
      reconcileRecovery: async (_env: Env, input: RetryReconciliationInput) => {
        recorded.push(input);
        return true;
      },
    };
    await executeRetryStep({} as Env, retryCtx(), deps);
    await executeRetryStep({} as Env, retryCtx(), deps);
    expect(recorded.map((r) => r.failedPaymentId)).toEqual(["fp_1", "fp_1"]);
  });
});

describe("silent-first ordering at the dispatch boundary", () => {
  it("a soft payment's first due step is the silent retry, never an email", () => {
    const detectedAt = new Date("2026-07-01T00:00:00.000Z");
    const plan = planRecoverySteps({
      failedPaymentId: "fp_1",
      accountId: "acc_1",
      declineCategory: "soft",
      detectedAt,
    });
    const steps: (SchedulableStep & { stepType: string })[] = plan.map((p) => ({
      stepType: p.stepType,
      stepNumber: p.stepNumber,
      scheduledAt: p.scheduledAt,
      executedAt: null,
      result: null,
      nextRetryAt: null,
    }));
    // 5h after detection: retry_early (4h) is due, email_day1 (24h) is not.
    const due = nextDueStep(steps, new Date(detectedAt.getTime() + 5 * 3600_000));
    expect(due).not.toBeNull();
    expect(stepAction(due!.stepType)).toBe("retry");
  });
});

describe("email executor: tracking wires a click to attribution", () => {
  it("the CTA is a click-tracked card-update link (click = email_engaged signal)", async () => {
    const urls = await buildEngagementUrls(env, emailCtx(), "https://foxhound.example");
    expect(urls.clickTrackedUpdateUrl).toContain("/e/c/");
    expect(urls.openUrl).toContain("/e/o/");
    // The click token carries this step and redirects to the hosted card-update page.
    const clickToken = urls.clickTrackedUpdateUrl.split("/e/c/")[1];
    const payload = await verifyEngagementToken(env, clickToken);
    expect(payload?.kind).toBe("click");
    expect(payload?.stepId).toBe("step_e");
    expect(payload?.url).toContain("/p/");
    const openToken = urls.openUrl.split("/e/o/")[1];
    expect((await verifyEngagementToken(env, openToken))?.kind).toBe("open");
  });

  it("append pixel is hidden and points at the open URL", () => {
    const html = appendOpenPixel("<p>Hi</p>", "https://x/e/o/tok");
    expect(html).toContain("<p>Hi</p>");
    expect(html).toContain('src="https://x/e/o/tok"');
    expect(html).toContain("display:none");
  });
});

describe("email executor: send-result mapping + persist", () => {
  it("maps sent and suppressed to a terminal success, a failure to a transient retry", () => {
    expect(sendResultToAttempt({ status: "sent" } as EmailJobResult)).toEqual({ ok: true });
    expect(sendResultToAttempt({ status: "suppressed" } as EmailJobResult)).toEqual({ ok: true });
    expect(sendResultToAttempt({ status: "failed", error: "boom" } as EmailJobResult)).toEqual({
      ok: false,
      permanent: false,
      error: "boom",
    });
  });

  it("caches the resolved copy onto ai_subject/ai_body_html for backoff reuse", () => {
    const sql = sqlOf(
      buildEmailStepPatch(
        db,
        "step_e",
        { attemptCount: 1, lastAttemptError: null, nextRetryAt: null, executedAt: now, result: "email_sent" },
        { subject: "S", bodyHtml: "<p>B</p>" },
      ),
    );
    expect(sql.sql).toMatch(/update .*recovery_steps/i);
    expect(sql.sql).toMatch(/ai_subject/i);
    expect(sql.params).toContain("email_sent");
    expect(sql.params).toContain("S");
  });
});

describe("email executor: orchestration + failure isolation", () => {
  it("a cached-content send marks the step sent and persists once", async () => {
    let persistedResult: string | null = "unset";
    // Cached copy carries the update link an earlier attempt minted for this
    // step, as every cached body the executor writes does.
    const { clickTrackedUpdateUrl } = await buildEngagementUrls(env, emailCtx(), "https://foxhound.example");
    const cachedBodyHtml = `<p>Body <a href="${clickTrackedUpdateUrl}">Update</a></p>`;
    const res = await executeEmailStep(env, emailCtx({ cached: { customBody: null, cachedSubject: "Subject", cachedBodyHtml } }), {
      send: async () => ({ status: "sent", providerMessageId: "p1", error: null, retryable: false }),
      persistPatch: async (_env, _id, patch) => {
        persistedResult = patch.result;
      },
    });
    // usedTemplate is false and templateReason null here: this send resolved from
    // cache, so no generation was attempted, no gate ran, and no fallback was needed.
    // `suppressed` is false because the injected send returned status "sent"; the
    // field exists so a trigger can tell "we did not email them" apart from "we
    // emailed them", which sendResultToAttempt collapses (S7 Phase 2 Session C).
    expect(res).toEqual({
      action: "email",
      sent: true,
      result: "email_sent",
      usedTemplate: false,
      templateReason: null,
      suppressed: false,
    });
    expect(persistedResult).toBe("email_sent");
  });

  it("a send failure is isolated as a transient backoff, never thrown", async () => {
    let patchResult: string | null = "unset";
    let nextRetry: Date | null | undefined;
    const res = await executeEmailStep(env, emailCtx(), {
      send: async () => {
        throw new Error("EMAIL binding is not configured");
      },
      persistPatch: async (_env, _id, patch) => {
        patchResult = patch.result;
        nextRetry = patch.nextRetryAt;
      },
    });
    expect(res.sent).toBe(false);
    // attemptCount 0 -> transient failure reschedules (not terminal yet).
    expect(patchResult).toBeNull();
    expect(nextRetry).not.toBeNull();
  });

  it("a transient failure at the last attempt goes terminal (email_failed)", async () => {
    let patchResult: string | null = "unset";
    await executeEmailStep(env, emailCtx({ attemptCount: SEND_MAX_ATTEMPTS - 1 }), {
      send: async () => ({ status: "failed", providerMessageId: null, error: "down", retryable: true }),
      persistPatch: async (_env, _id, patch) => {
        patchResult = patch.result;
      },
    });
    expect(patchResult).toBe("email_failed");
  });
});
