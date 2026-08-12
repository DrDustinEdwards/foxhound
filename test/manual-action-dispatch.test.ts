import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  MANUAL_ACTION_INTENTS,
  MANUAL_ACTION_REQUIRES_ACTIVE,
  dispatchManualAction,
  manualActionIdempotencyKey,
  parseManualActionIntent,
} from "~/lib/recovery/manual-actions.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S7 Phase 2 Session A: the shared manual-action dispatcher. Legacy implements
// these four actions as four route handlers that each re-write auth, account
// scoping, ownership and the status gate, and its four copies HAVE drifted
// (parity/S7-PHASE2-SCOPE.md section 1.5). Foxhound has one dispatcher, so these
// tests pin the gates once.
//
// Every intent resolves to not_wired this session by design: the plumbing lands
// before any behavior, so the route's response is unchanged (ruling 260).

const now = new Date("2026-08-11T00:00:00.000Z");

interface StepSeed {
  id: string;
  stepType?: string;
  executedAt?: Date | null;
  result?: string | null;
  aiSubject?: string | null;
  aiBodyHtml?: string | null;
}

/** Two accounts. `fp_mine` belongs to acc_1, `fp_theirs` to acc_2. */
function seed(opts: { status?: string; steps?: StepSeed[] } = {}) {
  const { sqlite, db } = createInMemoryDb();
  for (const [id, name] of [
    ["acc_1", "Mine"],
    ["acc_2", "Theirs"],
  ] as const) {
    runStatement(sqlite, db.insert(accounts).values({ id, name }));
  }
  for (const [id, accountId] of [
    ["fp_mine", "acc_1"],
    ["fp_theirs", "acc_2"],
  ] as const) {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id,
        accountId,
        stripeEventId: `evt_${id}`,
        stripeInvoiceId: `in_${id}`,
        stripeCustomerId: `cus_${id}`,
        customerEmail: "customer@example.com",
        amountCents: 4200,
        currency: "usd",
        declineCategory: "soft",
        status: opts.status ?? "active",
        detectedAt: now,
      }),
    );
  }
  for (const s of opts.steps ?? []) {
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: s.id,
        accountId: "acc_1",
        failedPaymentId: "fp_mine",
        stepType: s.stepType ?? "email_day1",
        scheduledAt: now,
        executedAt: s.executedAt ?? null,
        result: s.result ?? null,
        aiSubject: s.aiSubject ?? null,
        aiBodyHtml: s.aiBodyHtml ?? null,
        attemptCount: 0,
      }),
    );
  }
  return db;
}

const PENDING: StepSeed = { id: "step_pending" };
const SENT_EMAIL: StepSeed = {
  id: "step_sent",
  executedAt: now,
  result: "email_sent",
  aiSubject: "Subject",
  aiBodyHtml: "<p>Body</p>",
};

describe("manual actions: intent parsing", () => {
  it("accepts exactly legacy's four intents, in legacy's order", () => {
    expect([...MANUAL_ACTION_INTENTS]).toEqual(["trigger", "mark_recovered", "cancel", "resend"]);
    for (const intent of MANUAL_ACTION_INTENTS) {
      expect(parseManualActionIntent(intent)).toBe(intent);
    }
  });

  it("rejects anything else, including note and non-string form values", () => {
    for (const raw of ["note", "override_next_email", "", "TRIGGER", null, undefined, 7, {}]) {
      expect(parseManualActionIntent(raw)).toBeNull();
    }
  });
});

describe("manual actions: ownership is the same 404 as a missing payment", () => {
  it("refuses another account's payment without distinguishing it from a missing one", async () => {
    const db = seed({ steps: [PENDING] });

    const other = await dispatchManualAction(db, "acc_1", "fp_theirs", "cancel");
    const missing = await dispatchManualAction(db, "acc_1", "fp_nope", "cancel");

    expect(other).toEqual({ ok: false, reason: "not_found" });
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });

  it("the owner reaches the action on the same payment", async () => {
    const db = seed({ steps: [PENDING] });
    const mine = await dispatchManualAction(db, "acc_2", "fp_theirs", "cancel");
    expect(mine).toEqual({ ok: false, reason: "not_wired", intent: "cancel" });
  });

  it("an unknown intent is refused BEFORE any payment is loaded", async () => {
    const db = seed();
    // fp_nope does not exist; a not_found here would prove the intent check ran
    // second and turned an unknown action into an ownership probe.
    expect(await dispatchManualAction(db, "acc_1", "fp_nope", "note")).toEqual({
      ok: false,
      reason: "unknown_intent",
    });
  });
});

describe("manual actions: the status gate ports legacy's per-handler shape", () => {
  it("trigger, mark_recovered and cancel refuse a non-active payment", async () => {
    const db = seed({ status: "recovered", steps: [PENDING, SENT_EMAIL] });

    for (const intent of ["trigger", "mark_recovered", "cancel"] as const) {
      expect(await dispatchManualAction(db, "acc_1", "fp_mine", intent)).toEqual({
        ok: false,
        reason: "not_active",
        intent,
      });
    }
  });

  it("resend does NOT check status, exactly as legacy's handler does not", async () => {
    // Legacy's resend route never selects failed_payments.status, so only its
    // client gate stops a resend on a terminal payment (scope section 1.5,
    // defect 2). Ruling 262 decided resend's suppression gap and did NOT decide
    // this one, so legacy's shape is ported and the gap stays REPORTED. This
    // assertion is the tripwire: if the gap is later closed by ruling, it fails
    // and names the decision instead of letting it drift in unnoticed.
    const db = seed({ status: "recovered", steps: [SENT_EMAIL] });

    expect(await dispatchManualAction(db, "acc_1", "fp_mine", "resend")).toEqual({
      ok: false,
      reason: "not_wired",
      intent: "resend",
    });
    expect(MANUAL_ACTION_REQUIRES_ACTIVE.resend).toBe(false);
  });
});

describe("manual actions: per-intent preconditions", () => {
  it("trigger needs a pending step", async () => {
    const withNone = seed({ steps: [SENT_EMAIL] });
    expect(await dispatchManualAction(withNone, "acc_1", "fp_mine", "trigger")).toEqual({
      ok: false,
      reason: "no_pending_step",
    });

    const withOne = seed({ steps: [SENT_EMAIL, PENDING] });
    expect(await dispatchManualAction(withOne, "acc_1", "fp_mine", "trigger")).toEqual({
      ok: false,
      reason: "not_wired",
      intent: "trigger",
    });
  });

  it("an executed step with a result does not count as pending", async () => {
    const db = seed({ steps: [{ id: "s1", executedAt: now, result: "email_sent" }] });
    expect(await dispatchManualAction(db, "acc_1", "fp_mine", "trigger")).toEqual({
      ok: false,
      reason: "no_pending_step",
    });
  });

  it("resend needs an executed email step carrying generated copy", async () => {
    const none = seed({ steps: [PENDING] });
    expect(await dispatchManualAction(none, "acc_1", "fp_mine", "resend")).toEqual({
      ok: false,
      reason: "no_email_to_resend",
    });

    // Executed, but no copy cached: legacy filters on ai_subject AND ai_body_html.
    const noCopy = seed({ steps: [{ id: "s1", executedAt: now, result: "email_sent" }] });
    expect(await dispatchManualAction(noCopy, "acc_1", "fp_mine", "resend")).toEqual({
      ok: false,
      reason: "no_email_to_resend",
    });

    // A retry step with copy is still not an email step.
    const retryOnly = seed({
      steps: [{ ...SENT_EMAIL, id: "s2", stepType: "retry_day3" }],
    });
    expect(await dispatchManualAction(retryOnly, "acc_1", "fp_mine", "resend")).toEqual({
      ok: false,
      reason: "no_email_to_resend",
    });

    const ok = seed({ steps: [SENT_EMAIL] });
    expect(await dispatchManualAction(ok, "acc_1", "fp_mine", "resend")).toEqual({
      ok: false,
      reason: "not_wired",
      intent: "resend",
    });
  });

  it("mark_recovered and cancel carry no step precondition", async () => {
    const db = seed();
    for (const intent of ["mark_recovered", "cancel"] as const) {
      expect(await dispatchManualAction(db, "acc_1", "fp_mine", intent)).toEqual({
        ok: false,
        reason: "not_wired",
        intent,
      });
    }
  });
});

describe("manual actions: money-write idempotency key namespace", () => {
  it("namespaces every manual key so it cannot collide with the webhook spine's", () => {
    const key = manualActionIdempotencyKey("mark_recovered", "fp_1");
    expect(key).toBe("manual:mark_recovered:fp_1");
    // The recovery spine keys on `recovery:` (record-recovery.ts) and on raw
    // Stripe event ids; a manual key must never look like either.
    expect(key.startsWith("recovery:")).toBe(false);
    expect(key.startsWith("evt_")).toBe(false);
  });

  it("collapses repeats by default and varies only when a repeat token is given", () => {
    expect(manualActionIdempotencyKey("cancel", "fp_1")).toBe(
      manualActionIdempotencyKey("cancel", "fp_1"),
    );
    expect(manualActionIdempotencyKey("resend", "fp_1", "req_a")).not.toBe(
      manualActionIdempotencyKey("resend", "fp_1", "req_b"),
    );
  });

  it("keys are distinct per intent and per payment", () => {
    const keys = new Set([
      manualActionIdempotencyKey("trigger", "fp_1"),
      manualActionIdempotencyKey("cancel", "fp_1"),
      manualActionIdempotencyKey("cancel", "fp_2"),
    ]);
    expect(keys.size).toBe(3);
  });
});
