import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { and, eq } from "drizzle-orm";
import type { MoneyWriteBuilder } from "~/db/money-write";
import { type Db, failedPayments, recoverySteps } from "~/db";
import { toEmailContext, toRetryContext } from "~/lib/cron/due-steps";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { stepAction } from "~/lib/engine/step-runner";
import { FAILED_PAYMENT_STATUS_ACTIVE, FAILED_PAYMENT_STATUS_CANCELLED } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";
import { isUniqueConstraintError } from "~/lib/money/serializer";
import { getFailedPaymentDetail } from "./queries.server";
import { lastResendableEmailStep, nextPendingStep } from "./step-state";
import {
  buildSaveNoteBatch,
  resendRepeatToken,
  buildResendStepBatch,
  buildMarkRecoveredBatch,
  buildStopRecoveryBatch,
} from "./manual-action-batches.server";
import { type TriggerDeps, type ResendDeps } from "./manual-action-deps.server";

/**
 * `note` is deliberately NOT here: it is a separate control below the timeline, not a row button,
 * and test/payment-detail-actions.test.ts pins its absence from the row.
 */
export const MANUAL_ACTION_INTENTS = ["trigger", "mark_recovered", "cancel", "resend"] as const;

export type ManualActionIntent = (typeof MANUAL_ACTION_INTENTS)[number];

/** The notes-save intent. */
export const NOTE_INTENT = "note";

/** Everything the dispatcher accepts: the action row plus the notes save. */
export const MANUAL_INTENTS = [...MANUAL_ACTION_INTENTS, NOTE_INTENT] as const;

export type ManualIntent = (typeof MANUAL_INTENTS)[number];

/** Narrow an untrusted form value to any intent the dispatcher accepts. */
export function parseManualIntent(raw: unknown): ManualIntent | null {
  return typeof raw === "string" && (MANUAL_INTENTS as readonly string[]).includes(raw)
    ? (raw as ManualIntent)
    : null;
}

/** What happened, or why nothing did. One POST target means Foxhound has to reject it in code. */
export type ManualActionOutcome =
  | { ok: true; intent: "note" }
  | { ok: true; intent: "cancel" }
  | { ok: true; intent: "mark_recovered" }
  /** The step ran. `action` is which executor ran it; `result` is the STORED
   *  step result, and `subject` the stored ai_subject for an email send. */
  | {
      ok: true;
      intent: "trigger";
      action: "retry" | "email";
      result: string;
      subject: string | null;
    }
  | { ok: false; reason: "unknown_intent" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_active"; intent: ManualIntent }
  | { ok: false; reason: "no_pending_step" }
  | { ok: false; reason: "no_email_to_resend" }
  | { ok: false; reason: "unknown_step_type"; stepType: string }
  | { ok: false; reason: "processing_paused" }
  | { ok: true; intent: "resend"; subject: string }
  | { ok: false; reason: "customer_unsubscribed" }
  | { ok: false; reason: "live_sends_disabled" }
  | { ok: false; reason: "resend_failed"; detail: string | null }
  /** The mail went out and only the timeline row failed. Distinct on purpose:
   *  reporting a plain failure would contradict the customer's inbox. */
  | { ok: false; reason: "resend_logged_failed" }
  | { ok: false; reason: "send_retrying" }
  | { ok: false; reason: "step_failed"; result: string | null }
  | { ok: false; reason: "already_resolved"; intent: "cancel" | "mark_recovered" }
  | { ok: false; reason: "write_failed"; intent: ManualIntent };

/**
 * Whether an intent requires status 'active' server-side. The tripwire test on this value stays.
 */
export const MANUAL_ACTION_REQUIRES_ACTIVE: Record<ManualIntent, boolean> = {
  trigger: true,
  mark_recovered: true,
  cancel: true,
  // FLIPPED FROM false BY RULING 264, and this is the one place in this campaign where a pinned
  // test changes: it changes by RULING, never by drift.
  resend: true,
  note: false,
};

/** Commit a manual action's atomic batch, serialized on the account. */
export type ManualActionCommit = (
  accountId: string,
  idempotencyKey: string,
  build: MoneyWriteBuilder,
) => Promise<{ applied: boolean }>;

/** The real commit path: the per-account money-write Durable Object. Bound to
 *  `env` by the route and injected, so the dispatcher stays testable against a
 *  real SQLite without a Workers runtime. */
export function moneyWriteCommit(env: Env): ManualActionCommit {
  return (accountId, idempotencyKey, build) =>
    executeMoneyWrite(env, { accountId, idempotencyKey, build });
}

/**
 * The idempotency key for a manual action's money write. Pass a `repeatToken` where collapsing
 * would silently swallow a genuinely new request.
 */
export function manualActionIdempotencyKey(
  intent: ManualIntent,
  failedPaymentId: string,
  repeatToken?: string,
): string {
  const base = `manual:${intent}:${failedPaymentId}`;
  return repeatToken === undefined ? base : `${base}:${repeatToken}`;
}

export interface ManualActionRequest {
  db: Db;
  /** The CALLER'S resolved account, from the session. Never from the form. */
  accountId: string;
  failedPaymentId: string;
  /** Raw `intent` form value, untrusted. */
  intent: unknown;
  /** Raw `note` form value, read only for the note intent. */
  note?: unknown;
  commit: ManualActionCommit;
  trigger: TriggerDeps;
  resend: ResendDeps;
  now?: Date;
}

/** Resolve, gate and (where wired) perform one manual action against the caller's own account. */
export async function dispatchManualAction(req: ManualActionRequest): Promise<ManualActionOutcome> {
  const intent = parseManualIntent(req.intent);
  if (!intent) return { ok: false, reason: "unknown_intent" };

  const detail = await getFailedPaymentDetail(req.db, req.accountId, req.failedPaymentId);
  if (!detail) return { ok: false, reason: "not_found" };

  if (
    MANUAL_ACTION_REQUIRES_ACTIVE[intent] &&
    detail.failedPayment.status !== FAILED_PAYMENT_STATUS_ACTIVE
  ) {
    return { ok: false, reason: "not_active", intent };
  }

  if (intent === "trigger") {
    // The SHARED selector, the same predicate the button renders from, so the
    // step the server fires is the step the merchant was offered.
    const pending = nextPendingStep(detail.steps);
    if (pending === null) return { ok: false, reason: "no_pending_step" };
    return triggerNextStep(req, pending.id, pending.stepType);
  }

  if (intent === "resend") {
    const last = lastResendableEmailStep(detail.steps);
    if (last === null) return { ok: false, reason: "no_email_to_resend" };
    return resendLastEmail(req, last, detail.failedPayment.customerEmail);
  }

  if (intent === NOTE_INTENT) return saveNote(req);
  if (intent === "cancel") return stopRecovery(req);
  if (intent === "mark_recovered") {
    return markRecovered(req, detail.failedPayment.amountCents, detail.failedPayment.currency);
  }

  // Every member of ManualIntent is handled above, so `intent` is `never` here. The type system
  // enforces the same intent strictly better.
  const exhaustive: never = intent;
  return exhaustive;
}

/**
 * Record a merchant-asserted recovery through the spine's own recorder. The idempotency key is
 * once-ever per payment, `manual:mark_recovered:<id>`, confirmed against the spine's own convention
 * from money-writer.ts and record-recovery.ts rather than chosen freely: the DO's seen-set is keyed
 * on this string, and a payment recovers once, so a double submit collapses. Only the second
 * protects against the webhook, which is why it and not the DO key is the guarantee that matters.
 */
async function markRecovered(
  req: ManualActionRequest,
  amountCents: number,
  currency: string,
): Promise<ManualActionOutcome> {
  const now = req.now ?? new Date();
  let applied: boolean;
  try {
    const result = await req.commit(
      req.accountId,
      manualActionIdempotencyKey("mark_recovered", req.failedPaymentId),
      (db) =>
        buildMarkRecoveredBatch(db, {
          accountId: req.accountId,
          failedPaymentId: req.failedPaymentId,
          amountCents,
          currency,
          now,
        }),
    );
    applied = result.applied;
  } catch (err) {
    // The outcomes unique index rejecting a replay surfaces here as a thrown constraint error only
    // if it escapes the committer (the committer itself maps it to applied=false); anything else
    // is a real failure, and nothing was recorded.
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: "already_resolved", intent: "mark_recovered" };
    }
    console.error("manual action mark_recovered: commit failed", err);
    return { ok: false, reason: "write_failed", intent: "mark_recovered" };
  }

  if (!applied) {
    // The DO reported an idempotent no-op: either this exact request already landed, or the webhook
    // recorded the recovery first and the shared outcomes key rolled this batch back.
    return { ok: false, reason: "already_resolved", intent: "mark_recovered" };
  }
  return { ok: true, intent: "mark_recovered" };
}

/** Resend the last dunning email, through the SAME send path the engine uses. */
async function resendLastEmail(
  req: ManualActionRequest,
  step: { id: string; stepType: string; aiSubject: string | null; aiBodyHtml: string | null },
  customerEmail: string,
): Promise<ManualActionOutcome> {
  const now = req.now ?? new Date();
  const subject = step.aiSubject ?? "";
  const bodyHtml = step.aiBodyHtml ?? "";

  let result: EmailJobResult;
  try {
    result = await req.resend.send({
      accountId: req.accountId,
      recoveryStepId: step.id,
      to: customerEmail,
      subject,
      bodyHtml,
      now,
    });
  } catch (err) {
    console.error("manual action resend: send failed", err);
    return { ok: false, reason: "resend_failed", detail: null };
  }

  // A suppressed recipient is an HONEST REFUSAL to the merchant, never a silent
  // success. Nothing is inserted: no mail left, so there is
  // no send to record on the timeline.
  if (result.status === "suppressed") {
    return { ok: false, reason: "customer_unsubscribed" };
  }
  if (result.status === "blocked") {
    return { ok: false, reason: "live_sends_disabled" };
  }
  if (result.status !== "sent") {
    return { ok: false, reason: "resend_failed", detail: result.error };
  }

  // The timeline row, through the per-account money-write DO.
  // Rides the DO even though the row is not fee-bearing: the DO serializes an account's writes.
  try {
    await req.commit(
      req.accountId,
      manualActionIdempotencyKey(
        "resend",
        req.failedPaymentId,
        resendRepeatToken(result.providerMessageId, step.id, now),
      ),
      (db) =>
        buildResendStepBatch(db, {
          accountId: req.accountId,
          failedPaymentId: req.failedPaymentId,
          subject,
          bodyHtml,
          providerMessageId: result.providerMessageId,
          now,
        }),
    );
  } catch (err) {
    console.error("manual action resend: timeline row failed after the send", err);
    // The mail is already gone; only the timeline row failed. Say so rather than
    // reporting a failure the customer's inbox contradicts.
    return { ok: false, reason: "resend_logged_failed" };
  }

  return { ok: true, intent: "resend", subject };
}

/**
 * Run the next pending step now, through the SAME executors the 5-minute cron dispatches to.
 * Foxhound reuses for the same reason, and additionally inherits the money-path rules the executors
 * already honor. MONEY INVARIANTS, unchanged by this path and deliberately so: the executors'
 * recovery_steps writes stay OPERATIONAL on their existing plain-batch path, and
 * `reconcileRetryRecovery` remains the only money-DO hop, exactly as when the cron calls it.
 */
async function triggerNextStep(
  req: ManualActionRequest,
  stepId: string,
  stepType: string,
): Promise<ManualActionOutcome> {
  const action = stepAction(stepType);
  if (action === null) return { ok: false, reason: "unknown_step_type", stepType };

  const row = await req.trigger.loadStep(req.accountId, stepId);
  // The row's own gates already passed in the dispatcher (ownership, active payment), so the
  // remaining reason it can be missing is the ACCOUNT being ineligible: the emergency brake is
  // engaged, processing is paused, or the account is canceled.
  if (!row) return { ok: false, reason: "processing_paused" };
  // Customer emails off: refuse, rather than spend the step on a skip.
  if (action === "email" && !row.liveSendsEnabled)
    return { ok: false, reason: "live_sends_disabled" };

  let suppressed = false;
  try {
    if (action === "retry") {
      const ctx = toRetryContext(row);
      // No connected token: the charge is not attempted at all.
      if (!ctx) return { ok: false, reason: "step_failed", result: "retry_no_connection" };
      await req.trigger.runRetry(ctx);
    } else {
      const result = await req.trigger.runEmail(toEmailContext(row));
      suppressed = result.suppressed;
    }
  } catch (err) {
    console.error("manual action trigger: executor failed", err);
    return { ok: false, reason: "step_failed", result: null };
  }

  // Foxhound's return the result directly, so this read is not needed to learn what was DECIDED.
  // Reporting the stored row is the only honest answer under that race.
  const [after] = await req.db
    .select({
      result: recoverySteps.result,
      aiSubject: recoverySteps.aiSubject,
    })
    .from(recoverySteps)
    .where(and(eq(recoverySteps.id, stepId), eq(recoverySteps.accountId, req.accountId)))
    .limit(1);

  const stored = after?.result ?? null;

  // Suppression is checked FIRST and from the executor's return, not from the stored result,
  // because Foxhound has no distinct stored value for it: a suppressed recipient is a terminal
  // success whose step lands on `email_sent` (processEmailJob's contract, and sendResultToAttempt
  // collapses the two).
  if (suppressed) return { ok: false, reason: "customer_unsubscribed" };

  if (stored === null) {
    // The send-attempt state machine left the step unexecuted and retryable, so the next tick picks
    // it up after the backoff.
    return { ok: false, reason: "send_retrying" };
  }
  if (stored === "retry_no_connection") {
    return { ok: false, reason: "step_failed", result: stored };
  }
  if (stored.startsWith("email_sent") || stored.startsWith("retry_")) {
    return {
      ok: true,
      intent: "trigger",
      action,
      result: stored,
      subject: after?.aiSubject ?? null,
    };
  }
  return { ok: false, reason: "step_failed", result: stored };
}

async function saveNote(req: ManualActionRequest): Promise<ManualActionOutcome> {
  const note = typeof req.note === "string" ? req.note : "";
  // Keyed on the note's content: the same text resubmitted is a no-op, an edit is a new key.
  const key = manualActionIdempotencyKey(
    NOTE_INTENT,
    req.failedPaymentId,
    (await sha256Hex(note)).slice(0, 16),
  );
  try {
    await req.commit(req.accountId, key, (db) =>
      buildSaveNoteBatch(db, {
        accountId: req.accountId,
        failedPaymentId: req.failedPaymentId,
        note,
      }),
    );
  } catch (err) {
    console.error("manual action note: commit failed", err);
    // The error itself is not surfaced: it would carry query shape to the browser and tells a
    // merchant nothing they can act on.
    return { ok: false, reason: "write_failed", intent: NOTE_INTENT };
  }
  return { ok: true, intent: NOTE_INTENT };
}

async function stopRecovery(req: ManualActionRequest): Promise<ManualActionOutcome> {
  const now = req.now ?? new Date();
  try {
    await req.commit(
      req.accountId,
      manualActionIdempotencyKey("cancel", req.failedPaymentId),
      (db) =>
        buildStopRecoveryBatch(db, {
          accountId: req.accountId,
          failedPaymentId: req.failedPaymentId,
          now,
        }),
    );
  } catch (err) {
    console.error("manual action cancel: commit failed", err);
    return { ok: false, reason: "write_failed", intent: "cancel" };
  }

  // The commit result reports whether the KEY was newly applied, not whether the claim took a row,
  // so the honest answer to "did this actually stop anything" comes from reading the status back.
  const [after] = await req.db
    .select({ status: failedPayments.status })
    .from(failedPayments)
    .where(
      and(eq(failedPayments.id, req.failedPaymentId), eq(failedPayments.accountId, req.accountId)),
    )
    .limit(1);

  if (after?.status !== FAILED_PAYMENT_STATUS_CANCELLED) {
    return { ok: false, reason: "already_resolved", intent: "cancel" };
  }
  return { ok: true, intent: "cancel" };
}
