import { and, eq } from "drizzle-orm";
import type { MoneyWriteBuilder } from "~/db/money-write";
import { type Db, failedPayments, recoverySteps } from "~/db";
import { toEmailContext, toRetryContext } from "~/lib/cron/due-steps";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { stepAction } from "~/lib/engine/step-runner";
import { FAILED_PAYMENT_STATUS_ACTIVE, FAILED_PAYMENT_STATUS_CANCELLED } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getFailedPaymentDetail } from "./queries.server";
import { lastResendableEmailStep, nextPendingStep } from "./step-state";
import {
  noteContentToken,
  buildSaveNoteBatch,
  resendRepeatToken,
  buildResendStepBatch,
  buildMarkRecoveredBatch,
  buildStopRecoveryBatch,
} from "./manual-action-batches.server";
import { type TriggerDeps, type ResendDeps } from "./manual-action-deps.server";

// The shared entry point for S7's manual payment-detail actions: legacy's four
// action-row intents (Trigger next step now, Mark as recovered, Stop recovery,
// Resend last email) plus the internal-notes save. Legacy ships these as five
// separate Next.js route handlers that each re-implement auth, account scoping,
// ownership and the status gate (app/api/payments/[id]/*, read in full in
// parity/S7-PHASE2-SCOPE.md section 1). Foxhound has one POST target and one
// dispatcher, so those checks are written once and cannot drift, which is
// exactly where legacy's copies DID drift: its resend handler resolves the
// account through a different helper than its siblings and skips the status gate
// entirely (scope section 1.5, defects 2 and 4).
//
// ALL FIVE ARE WIRED, across Sessions B through E and closed out at 272. No
// intent resolves to a refusal for want of an implementation; every refusal this
// module returns is a real precondition answering for a real reason.
//
// MONEY-PATH CONTRACT, ruling 262 decision four: EVERY Phase 2 mutation routes
// through the per-account money-write Durable Object, without exception and
// regardless of whether the individual write touches a fee-bearing table. The DO
// is what serializes writes per account; a bypass reintroduces exactly the races
// it exists to kill. Every mutating intent commits through `ManualActionCommit`, and
// an intent that reaches for db.batch() directly is a defect, not a shortcut.

/** Legacy's four ACTION-ROW actions, in legacy's order. `note` is deliberately
 *  NOT here: it is a separate control below the timeline, not a row button, and
 *  test/payment-detail-actions.test.ts pins its absence from the row. */
export const MANUAL_ACTION_INTENTS = ["trigger", "mark_recovered", "cancel", "resend"] as const;

export type ManualActionIntent = (typeof MANUAL_ACTION_INTENTS)[number];

/** The notes-save intent. A separate POST target in legacy, with no status gate,
 *  no precondition and no action-row presence. */
export const NOTE_INTENT = "note";

/** Everything the dispatcher accepts: the action row plus the notes save. */
export const MANUAL_INTENTS = [...MANUAL_ACTION_INTENTS, NOTE_INTENT] as const;

export type ManualIntent = (typeof MANUAL_INTENTS)[number];

/** Narrow an untrusted form value to an ACTION-ROW intent. Returns null for
 *  anything else, `note` included, because the row does not carry it. */
export function parseManualActionIntent(raw: unknown): ManualActionIntent | null {
  return typeof raw === "string" && (MANUAL_ACTION_INTENTS as readonly string[]).includes(raw)
    ? (raw as ManualActionIntent)
    : null;
}

/** Narrow an untrusted form value to any intent the dispatcher accepts. */
export function parseManualIntent(raw: unknown): ManualIntent | null {
  return typeof raw === "string" && (MANUAL_INTENTS as readonly string[]).includes(raw)
    ? (raw as ManualIntent)
    : null;
}

/**
 * What happened, or why nothing did. Mapped to a response by the caller; nothing
 * here formats user copy, so the route owns the strings and this module owns the
 * decision.
 *
 * The refusal reasons mirror legacy's own status codes, recorded per action in
 * scope section 1.7:
 *   not_found          -> legacy 404 "Not found"
 *   not_active         -> legacy 400 "Payment is not active"
 *   no_pending_step    -> legacy 400 "No pending steps"    (trigger only)
 *   no_email_to_resend -> legacy 400 "No email to resend"  (resend only)
 *   already_resolved   -> legacy's `{ success: true, alreadyResolved: true }`
 *   unknown_intent     -> no legacy equivalent; legacy encodes the action in the
 *                         URL path, so an unknown action 404s at its router. One
 *                         POST target means Foxhound has to reject it in code.
 */
export type ManualActionOutcome =
  | { ok: true; intent: "note" }
  | { ok: true; intent: "cancel" }
  | { ok: true; intent: "mark_recovered" }
  /** The step ran. `action` is which executor ran it; `result` is the STORED
   *  step result, and `subject` the stored ai_subject for an email send. */
  | { ok: true; intent: "trigger"; action: "retry" | "email"; result: string; subject: string | null }
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
 * Whether an intent requires status 'active' server-side.
 *
 * Three of legacy's four action handlers re-check the status after the ownership
 * read and 400 if it is not active. Two entries deliberately read false:
 *
 * `note` because legacy's note route has no status gate at all, and a merchant
 * annotating a closed payment is a legitimate thing to do.
 *
 * `resend` because legacy's RESEND HANDLER never selects the status column, so
 * only its client gate stops a resend on a terminal payment (scope 1.5 defect 2).
 * **Ruling 264 has since RULED the server-side check REQUIRED for resend**, and
 * Session D flips this entry under that authority. It is left false here because
 * flipping it without wiring resend would change a refusal reason for an intent
 * this session does not own. The tripwire test on this value stays.
 */
export const MANUAL_ACTION_REQUIRES_ACTIVE: Record<ManualIntent, boolean> = {
  trigger: true,
  mark_recovered: true,
  cancel: true,
  // FLIPPED FROM false BY RULING 264, and this is the one place in this campaign
  // where a pinned test changes: it changes by RULING, never by drift. Legacy's
  // resend route never selects the status column, so only its client gate stops a
  // resend on a terminal payment (scope 1.5, defect 2), and Session A ported that
  // shape exactly with a tripwire test pinning `false` so any later change had to
  // be argued rather than slipped in. 264 argues it: resending a dunning email
  // about a payment already recovered or canceled asserts a FALSE state to the
  // customer and manufactures exactly the complaints the suppression check exists
  // to prevent, and a client-side state gate is treatment, never authority. The
  // tripwire did its job by making this a ruling.
  resend: true,
  note: false,
};

// ---------------------------------------------------------------------------
// Money-write routing (262 decision four)
// ---------------------------------------------------------------------------

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
 * The idempotency key for a manual action's money write.
 *
 * Omit `repeatToken` for an intent that may happen AT MOST ONCE per payment, so
 * a double-submit or a retried request collapses onto the same key and the DO's
 * seen-set makes the second attempt a no-op. Stop recovery is once-ever: a
 * stopped sequence stays stopped, and re-running it would be meaningless.
 *
 * Pass a `repeatToken` where collapsing would silently swallow a genuinely new
 * request. The namespace guarantees no manual key can ever collide with the
 * webhook spine's, which are Stripe event ids and `recovery:`-prefixed.
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

/**
 * Resolve, gate and (where wired) perform one manual action against the caller's
 * own account.
 *
 * Ownership is enforced the way every other read in this tree enforces it:
 * getFailedPaymentDetail is account-scoped, so a payment belonging to another
 * account is indistinguishable from one that does not exist and both land on
 * not_found. That is legacy's contract too, and it is what stops a payment id
 * being an enumeration oracle across tenants.
 */
export async function dispatchManualAction(
  req: ManualActionRequest,
): Promise<ManualActionOutcome> {
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
    // The SHARED selector, now picking by executed_at descending (legacy's SERVER
    // rule, settled in step-state.ts), so the mail the server resends is the one
    // legacy's own route would have chosen.
    const last = lastResendableEmailStep(detail.steps);
    if (last === null) return { ok: false, reason: "no_email_to_resend" };
    return resendLastEmail(req, last, detail.failedPayment.customerEmail);
  }

  if (intent === NOTE_INTENT) return saveNote(req);
  if (intent === "cancel") return stopRecovery(req);
  if (intent === "mark_recovered") {
    return markRecovered(req, detail.failedPayment.amountCents, detail.failedPayment.currency);
  }

  // Every member of ManualIntent is handled above, so `intent` is `never` here.
  // This used to return a runtime `not_wired` that nothing could reach: it dates
  // from Session A, when the dispatcher was built DELIBERATELY unwired (260),
  // and it was left standing after 272 wired all five. The type system enforces
  // the same intent strictly better. A SIXTH intent added to MANUAL_INTENTS
  // without a branch here is now a COMPILE error, where the old string would
  // have shipped and answered a merchant with a refusal nobody wrote on purpose.
  const exhaustive: never = intent;
  return exhaustive;
}

/**
 * Record a merchant-asserted recovery through the spine's own recorder.
 *
 * The idempotency key is once-ever per payment, `manual:mark_recovered:<id>`,
 * confirmed against the spine's own convention from money-writer.ts and
 * record-recovery.ts rather than chosen freely: the DO's seen-set is keyed on
 * this string, and a payment recovers once, so a double submit collapses. Note
 * this key and the OUTCOMES key are different instruments doing different jobs.
 * The DO key stops the same request being applied twice; the outcomes key
 * (`recovery:<failedPaymentId>`, shared with the webhook) stops two DIFFERENT
 * callers recording the same payment. Only the second protects against the
 * webhook, which is why it and not the DO key is the guarantee that matters.
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
    console.error("manual action mark_recovered: commit failed", err);
    // The outcomes unique index rejecting a replay surfaces here as a thrown
    // constraint error only if it escapes the committer; the committer itself
    // maps it to applied=false. Either way the honest answer is the same: this
    // payment was already recorded by someone.
    return { ok: false, reason: "already_resolved", intent: "mark_recovered" };
  }

  if (!applied) {
    // The DO reported an idempotent no-op: either this exact request already
    // landed, or the webhook recorded the recovery first and the shared outcomes
    // key rolled this batch back. Legacy's own alreadyResolved answer.
    return { ok: false, reason: "already_resolved", intent: "mark_recovered" };
  }
  return { ok: true, intent: "mark_recovered" };
}

/**
 * Resend the last dunning email, through the SAME send path the engine uses.
 *
 * Legacy's own resend route is the degraded parallel its SIBLING trigger route
 * documents and removed from itself: no suppression check, no unsubscribe token,
 * no List-Unsubscribe header, a raw provider call with no idempotency, and a
 * different auth helper from its three siblings (scope 1.5, defects 1 to 4).
 * Ruling 262 decision three ports the INTENT and not the defect, so this goes
 * through processEmailJob, which gates suppression, applies the live-send flag,
 * sends through the one send module and logs to email_sends.
 *
 * SEND-PRECEDES-PERSIST (268) APPLIES HERE TOO, and is stated rather than solved.
 * The idempotency key protects the ROW, not the send: two submits racing inside
 * the same second both reach processEmailJob before either persists, so both can
 * mail. That is the same shared defect 268 named and parked with a design owed,
 * and no executor semantics are changed here.
 */
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
  // success (262 decision three). Nothing is inserted: no mail left, so there is
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

  // The timeline row, through the per-account money-write DO (262 decision four).
  // This is a mutation this session AUTHORS, so it rides the DO regardless of the
  // row not being fee-bearing: the DO is what serializes an account's writes.
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
 * Run the next pending step now, through the SAME executors the 5-minute cron
 * dispatches to. Legacy does exactly this and says why in its own route header:
 * its earlier inline implementation was "a degraded parallel" with no
 * suppression check, no unsubscribe token and no idempotency, and reuse inherits
 * all of it. Foxhound reuses for the same reason, and additionally inherits the
 * money-path rules the executors already honor.
 *
 * MONEY INVARIANTS, unchanged by this path and deliberately so: the executors'
 * recovery_steps writes stay OPERATIONAL on their existing plain-batch path, and
 * `reconcileRetryRecovery` remains the only money-DO hop, exactly as when the
 * cron calls it. No new DO hop is added. 262 decision four governs mutations a
 * session AUTHORS; this session authors none, it calls a pre-existing engine.
 */
async function triggerNextStep(
  req: ManualActionRequest,
  stepId: string,
  stepType: string,
): Promise<ManualActionOutcome> {
  const action = stepAction(stepType);
  if (action === null) return { ok: false, reason: "unknown_step_type", stepType };

  const row = await req.trigger.loadStep(req.accountId, stepId);
  // The row's own gates already passed in the dispatcher (ownership, active
  // payment), so the remaining reason it can be missing is the ACCOUNT being
  // ineligible: the emergency brake is engaged, processing is paused, or the
  // account is canceled. Executing a step is processing, so the brake holds
  // here exactly as it holds over the cron.
  if (!row) return { ok: false, reason: "processing_paused" };

  let suppressed = false;
  try {
    if (action === "retry") {
      const ctx = toRetryContext(row);
      // No connected token: the charge is not attempted at all. The cron records
      // bounded grace here and lets the sweep re-select; a merchant pressing a
      // button gets told instead, and nothing is written, so reconnecting and
      // pressing again is the whole remedy.
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

  // Legacy re-reads the step after its executors return, because they return
  // void. Foxhound's return the result directly, so this read is not needed to
  // learn what was DECIDED. It is kept because it answers a different and
  // better question: what is actually STORED. The email patch is claim-guarded
  // (WHERE executed_at IS NULL, ruling 260), so a caller that loses the claim
  // decided one thing while the database holds the winner's. Reporting the
  // stored row is the only honest answer under that race.
  const [after] = await req.db
    .select({
      result: recoverySteps.result,
      aiSubject: recoverySteps.aiSubject,
    })
    .from(recoverySteps)
    .where(and(eq(recoverySteps.id, stepId), eq(recoverySteps.accountId, req.accountId)))
    .limit(1);

  const stored = after?.result ?? null;

  // Suppression is checked FIRST and from the executor's return, not from the
  // stored result, because Foxhound has no distinct stored value for it: a
  // suppressed recipient is a terminal success whose step lands on `email_sent`
  // (processEmailJob's contract, and sendResultToAttempt collapses the two).
  // Legacy stores `skipped_unsubscribed` and answers 409; without this branch
  // Foxhound would report a send that never happened.
  if (suppressed) return { ok: false, reason: "customer_unsubscribed" };

  if (stored === null) {
    // The send-attempt state machine left the step unexecuted and retryable, so
    // the next tick picks it up after the backoff. Legacy answers 503 here.
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
  const key = manualActionIdempotencyKey(
    NOTE_INTENT,
    req.failedPaymentId,
    await noteContentToken(note),
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
    // Legacy answers 500 "Failed to save note" here. The error itself is not
    // surfaced: it would carry query shape to the browser and tells a merchant
    // nothing they can act on.
    return { ok: false, reason: "write_failed", intent: NOTE_INTENT };
  }
  return { ok: true, intent: NOTE_INTENT };
}

async function stopRecovery(req: ManualActionRequest): Promise<ManualActionOutcome> {
  const now = req.now ?? new Date();
  try {
    await req.commit(req.accountId, manualActionIdempotencyKey("cancel", req.failedPaymentId), (db) =>
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

  // The commit result reports whether the KEY was newly applied, not whether the
  // claim took a row, so the honest answer to "did this actually stop anything"
  // comes from reading the status back. Anything other than canceled means a
  // concurrent writer resolved the payment inside the claim window, which is
  // legacy's `alreadyResolved` case answered truthfully rather than as success.
  const [after] = await req.db
    .select({ status: failedPayments.status })
    .from(failedPayments)
    .where(
      and(
        eq(failedPayments.id, req.failedPaymentId),
        eq(failedPayments.accountId, req.accountId),
      ),
    )
    .limit(1);

  if (after?.status !== FAILED_PAYMENT_STATUS_CANCELLED) {
    return { ok: false, reason: "already_resolved", intent: "cancel" };
  }
  return { ok: true, intent: "cancel" };
}
