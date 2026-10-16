import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { visibleActionResult } from "~/lib/recovery/payment-detail";
import { paymentStepLabel } from "~/lib/recovery/payments-list.server";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// job_3176bb519f89, found by the J76 review (PR #134): three parity follow-ups
// on /recovery/payments and /recovery/payments/:id, each toward Recova
// (lib/ui-display.ts 35c4d676 getStepLabel, PaymentDetailClient.tsx 7f54aa45),
// and a loader test for the raw email body. Every assertion was seen failing
// first.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/recovery/payments/detail");

const A = "acct_alpha";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86_400_000;

// ---- 1. Step labels ----

describe("step labels say Recova's day where Foxhound's offset makes it true", () => {
  it("names the soft 48-hour retry_day2 'Day 2 retry', as Recova does", () => {
    expect(RECOVERY_SCHEDULES.soft.find((s) => s.stepType === "retry_day2")?.offsetHours).toBe(48);
    expect(paymentStepLabel("soft", "retry_day2")).toBe("Day 2 retry");
  });

  it("names network's retry_day2 by its hours, because it runs at 24 and 'Day 2' would be false", () => {
    expect(RECOVERY_SCHEDULES.network.find((s) => s.stepType === "retry_day2")?.offsetHours).toBe(24);
    expect(paymentStepLabel("network", "retry_day2")).toBe("24hr retry");
  });

  it("keeps Recova's '4hr retry' and names Day 21 by its day", () => {
    expect(paymentStepLabel("network", "retry_4hr")).toBe("4hr retry");
    expect(paymentStepLabel("soft", "retry_early")).toBe("4hr retry");
    expect(paymentStepLabel("soft", "retry_day21")).toBe("Day 21 retry");
  });

  it("ties every retry in every schedule to its offset: the day form only when it is exactly that day", () => {
    let checked = 0;
    for (const [category, schedule] of Object.entries(RECOVERY_SCHEDULES)) {
      for (const step of schedule) {
        if (!isRetryStep(step.stepType)) continue;
        checked++;
        const day = /^retry_day(\d+)$/.exec(step.stepType);
        const expected =
          day && step.offsetHours === Number(day[1]) * 24 ? `Day ${day[1]} retry` : `${step.offsetHours}hr retry`;
        expect(paymentStepLabel(category, step.stepType), `${category} ${step.stepType}`).toBe(expected);
      }
    }
    // The walk proves it saw the retries it is about (RULES.md 6.2).
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});

// ---- 2. Copy email ----

describe("Copy email shows Recova's copied state with Capsomer's parts", () => {
  it("says Copy email before the press", () => {
    expect(renderToStaticMarkup(createElement(route.CopyEmailLabel, { copied: false }))).toBe("Copy email");
  });

  it("turns to an ok status reading Copied after the press, as Recova's goes green", () => {
    const html = renderToStaticMarkup(createElement(route.CopyEmailLabel, { copied: true }));
    expect(html).toMatch(/^<span class="cap-status" data-tone="ok"><svg class="cap-status-glyph"[\s\S]*<\/svg>Copied<\/span>$/);
  });
});

// ---- 3. Result banner ----

describe("the action result clears as soon as a new action is pressed, as Recova's does", () => {
  const error = { error: "No pending steps" };
  const notice = { notice: "Marked recovered successful" };

  it("still shows an error and a fresh success while nothing is pending", () => {
    expect(visibleActionResult({ actionData: error, clearedFor: null, pendingIntent: null })).toEqual({
      tone: "crit",
      message: "No pending steps",
    });
    expect(visibleActionResult({ actionData: notice, clearedFor: null, pendingIntent: null })).toEqual({
      tone: "ok",
      message: "Marked recovered successful",
    });
    expect(visibleActionResult({ actionData: notice, clearedFor: notice, pendingIntent: null })).toBeNull();
  });

  it("hides the previous error while a new action is pending", () => {
    for (const intent of ["trigger", "mark_recovered", "cancel", "resend"]) {
      expect(visibleActionResult({ actionData: error, clearedFor: null, pendingIntent: intent }), intent).toBeNull();
    }
  });

  it("hides the previous success while a new action is pending", () => {
    expect(visibleActionResult({ actionData: notice, clearedFor: null, pendingIntent: "cancel" })).toBeNull();
  });

  it("leaves the banner alone for a submission that is not one of the four actions", () => {
    expect(visibleActionResult({ actionData: error, clearedFor: null, pendingIntent: "note" })).not.toBeNull();
  });
});

// ---- 4. The loader sends no raw email body ----

describe("the payment detail loader", () => {
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
  let db: Db;

  beforeEach(() => {
    ({ sqlite, db } = createInMemoryDb());
    harness.db = db;
    runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
  });

  it("carries no raw email body, only the sanitized preview", async () => {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id: "fp_1",
        accountId: A,
        stripeEventId: "evt_1",
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        customerEmail: "jordan@example.com",
        amountCents: 4999,
        currency: "usd",
        declineCategory: "soft",
        status: "active",
        detectedAt: new Date(NOW - 3 * DAY),
      }),
    );
    const raw = '<p onclick="steal()">Hi Jordan</p><script>alert("raw-body-marker")</script>';
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: "s1",
        accountId: A,
        failedPaymentId: "fp_1",
        stepType: "email_day1",
        stepNumber: 1,
        scheduledAt: new Date(NOW - 2 * DAY),
        executedAt: new Date(NOW - 2 * DAY),
        result: "email_sent",
        aiSubject: "Your card",
        aiBodyHtml: raw,
        attemptCount: 1,
      }),
    );
    const data = await route.loader({
      context: {
        get(key: unknown) {
          if (key === cloudflareContext) return { env: {}, ctx: { waitUntil() {} }, nonce: "n" };
          if (key === authContext) return { membership: { accountId: A } };
          throw new Error("unexpected context key");
        },
      },
      request: new Request("https://foxhoundapp.test/recovery/payments/fp_1"),
      params: { id: "fp_1" },
    } as never);
    const step = data.steps.find((s) => s.id === "s1");
    // The step is there and its preview was built, so the absence below is
    // about the body, not a missing step (RULES.md 6.4).
    expect(step?.previewHtml).toContain("Hi Jordan");
    expect(step).not.toHaveProperty("aiBodyHtml");
    const json = JSON.stringify(data);
    expect(json).not.toContain("raw-body-marker");
    expect(json).not.toContain("onclick");
    expect(json).not.toContain("<script");
  });
});
