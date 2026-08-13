import { and, eq, isNull, sql } from "drizzle-orm";

import type { MoneyWriteBatch, MoneyWriteBuilder } from "~/db/money-write";
import type { Db } from "~/db";
import { failedPayments, recoverySteps } from "~/db";
import {
  queryStepForManualTrigger,
  toEmailContext,
  toRetryContext,
  type DueStepRow,
} from "~/lib/cron/recovery-tick";
import {
  executeEmailStep,
  executeRetryStep,
  type EmailStepContext,
  type EmailStepResult,
  type RetryStepContext,
  type RetryStepResult,
} from "~/lib/engine/execute-step";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { stepAction } from "~/lib/engine/step-runner";
import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_CANCELLED,
  MANUAL_ATTRIBUTION_KIND,
} from "~/lib/constants";
import { buildRecoveryBatch } from "./record-recovery";
import { executeMoneyWrite } from "~/lib/money/execute";

import { getFailedPaymentDetail } from "./queries.server";
import { lastResendableEmailStep, nextPendingStep } from "./step-state";

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
// WIRED SO FAR: note and cancel (Session B). trigger (C), resend (D) and
// mark_recovered (E) still resolve to NOT_WIRED after their preconditions pass.
//
// MONEY-PATH CONTRACT, ruling 262 decision four: EVERY Phase 2 mutation routes
// through the per-account money-write Durable Object, without exception and
// regardless of whether the individual write touches a fee-bearing table. The DO
// is what serializes writes per account; a bypass reintroduces exactly the races
// it exists to kill. Both wired intents commit through `ManualActionCommit`, and
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
  | { ok: false; reason: "write_failed"; intent: ManualIntent }
  | { ok: false; reason: "not_wired"; intent: ManualActionIntent };

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
  // about a payment already recovered or cancelled asserts a FALSE state to the
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

/**
 * The note key's repeat token: a digest of the note's CONTENT.
 *
 * This is the shape the brief asks for and the reason is worth stating. A key
 * fixed per payment would collapse every later edit into a no-op, so the second
 * thing a merchant ever typed would be silently discarded. A key varying per
 * request would make a retried submission write twice, which for this update is
 * harmless but defeats the point of having a key at all. Keying on the content
 * gives both: re-submitting the SAME text is a true no-op, and changing one
 * character is a new key that applies.
 */
export async function noteContentToken(note: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(note));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Atomic batches. Exported pure so each is unit-tested against the real schema.
// ---------------------------------------------------------------------------

export interface SaveNoteInput {
  accountId: string;
  failedPaymentId: string;
  /** Raw textarea value. Empty string becomes NULL, exactly as legacy does. */
  note: string;
}

/** Legacy's note contract, one statement (app/api/payments/[id]/note/route.ts):
 *  `.update({ notes: note || null }).eq('id', id).eq('account_id', ...)`. The
 *  `|| null` is legacy's, so a cleared textarea clears the column rather than
 *  storing an empty string; whitespace-only text is preserved, also as legacy. */
export function buildSaveNoteBatch(db: Db, input: SaveNoteInput): MoneyWriteBatch {
  return [
    db
      .update(failedPayments)
      .set({ notes: input.note || null })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
        ),
      ),
  ];
}

/** email_sends.template label for a merchant-initiated resend. Distinct from the
 *  engine's own labels so "how much mail was resent by hand" is one WHERE clause. */
export const TEMPLATE_LABEL_RESEND = "recovery_resend";

/** The step_type legacy writes for a resend, so the timeline shows it as its own
 *  event rather than mutating the original send's row. */
export const RESEND_STEP_TYPE = "email_resend";

/**
 * The resend key's repeat token, chosen under 265's key-design reasoning.
 *
 * The unit of identity here is the SEND EVENT, not the submission and not the
 * payment. A per-payment key would collapse every later resend into the first,
 * silently discarding deliberate ones. A per-request key would collapse nothing.
 * Keying on the provider's own message id collapses exactly the case worth
 * collapsing, a retried PERSIST of a send that already happened, while a
 * genuinely new send carries a new id and applies.
 *
 * This is also why the token is NOT derived from the submit: because the send
 * precedes the persist (268), a double-click produces TWO real sends, and
 * collapsing their rows would hide mail that actually reached the customer. The
 * row should record what happened, not what was clicked.
 *
 * The fallback, when the provider returns no id, is step plus timestamp: it
 * cannot collapse, which errs toward recording a send twice rather than losing
 * one. Under-recording a send is the worse failure on a compliance surface.
 */
export function resendRepeatToken(
  providerMessageId: string | null,
  stepId: string,
  now: Date,
): string {
  return providerMessageId ?? `${stepId}:${now.getTime()}`;
}

export interface ResendStepInput {
  accountId: string;
  failedPaymentId: string;
  subject: string;
  bodyHtml: string;
  providerMessageId: string | null;
  now: Date;
}

/**
 * Legacy's resend timeline row, one statement (its route's own insert): a NEW
 * recovery_steps row with step_type `email_resend`, `step_number` null, executed
 * now, carrying the resent copy and the provider's send id.
 *
 * Schema-legal without a migration: `step_number` is a nullable integer and
 * `step_type` and `result` are free text with no CHECK, verified against the
 * committed migrations. `result` is `email_sent`, matching what the engine writes
 * for a delivered send, so the timeline renders it with the existing tone map
 * rather than needing a new vocabulary entry.
 *
 * THE PROVIDER ID IS NOT ON THIS ROW, and that is a deliberate internal
 * difference. Legacy carries a `resend_message_id` column on its step;
 * recovery_steps has no such column and does not need one, because
 * processEmailJob already logged this send to `email_sends` with its
 * `provider_message_id`, its template label and its recipient hash. Duplicating
 * it here would create a second home for the same fact. Class (a): invisible to
 * the merchant, who sees the timeline row either way.
 *
 * NO fee row and NO outcome row, which is legacy's own shape: a resend is
 * outreach, not a recovery, and nothing about it is billable.
 */
export function buildResendStepBatch(db: Db, input: ResendStepInput): MoneyWriteBatch {
  return [
    db.insert(recoverySteps).values({
      accountId: input.accountId,
      failedPaymentId: input.failedPaymentId,
      stepType: RESEND_STEP_TYPE,
      stepNumber: null,
      scheduledAt: input.now,
      executedAt: input.now,
      result: "email_sent",
      aiSubject: input.subject,
      aiBodyHtml: input.bodyHtml,
    }),
  ];
}

export interface MarkRecoveredInput {
  accountId: string;
  failedPaymentId: string;
  amountCents: number;
  currency: string;
  now: Date;
}

/**
 * Mark as recovered, as ONE atomic batch through the per-account money-write DO.
 *
 * ENTERS THROUGH THE SPINE'S OWN RECORDER (262 decision five). Statement two is
 * `buildRecoveryBatch`, the exact builder the invoice.payment_succeeded webhook
 * uses, not a parallel insert. "No second writer of recovered_payments" is
 * satisfied by one BUILDER, and the fee row and the moat row stay a single
 * atomic pair rather than drifting apart.
 *
 * THE IDEMPOTENCY GUARD IS INHERITED, NOT INVENTED, and this is why no unique
 * index was added to recovered_payments. `buildRecoveryBatch` derives its
 * outcomes key from its `idempotencyKey` input, and the webhook passes the
 * FAILED PAYMENT ID (webhooks/batches.ts). Passing the same here puts both
 * callers in one key space, `recovery:<failedPaymentId>`, guarded by the real
 * partial unique index `outcomes_idempotency_uq`. Whichever commits second rolls
 * the whole batch back, fee row included. A unique index on
 * recovered_payments.failed_payment_id would be a second mechanism for a
 * guarantee that already holds, bought with a UNIQUE migration on a fee-bearing
 * table that fails to apply if any duplicate already exists.
 *
 * THE CLAIM SHAPE is legacy's own and the one 265 ratified for cancel: the
 * status UPDATE carries `status = 'active'`, so it CLAIMS the transition rather
 * than asserting it. Legacy's recover route explains why in its own comment: the
 * webhook can resolve the payment between the read and the write.
 *
 * NEVER BILLABLE (262 decision one): the attribution kind is `manual`, which is
 * absent from BILLABLE_ATTRIBUTION_KINDS, so `buildRecoveryBatch` stamps
 * `attributed_at` NULL and every billing predicate skips the row while the moat
 * keeps it.
 *
 * STEP THREE is legacy's, read from source rather than assumed symmetric with
 * cancel: recover also resolves the unexecuted steps to `cancelled`. It is
 * conditioned on the claim having landed, through a correlated subquery reading
 * statement one's effect inside the same transaction, so a lost race cancels
 * nothing. Foxhound also scopes it by account, which legacy's does not.
 */
export function buildMarkRecoveredBatch(db: Db, input: MarkRecoveredInput): MoneyWriteBatch {
  const paymentIsRecovered = sql`exists (select 1 from ${failedPayments} where ${failedPayments.id} = ${input.failedPaymentId} and ${failedPayments.accountId} = ${input.accountId} and ${failedPayments.status} = ${"recovered"})`;
  return [
    db
      .update(failedPayments)
      .set({ status: "recovered", resolvedAt: input.now })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
          eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        ),
      ),
    ...buildRecoveryBatch(db, {
      accountId: input.accountId,
      failedPaymentId: input.failedPaymentId,
      amountCents: input.amountCents,
      currency: input.currency,
      recoveredAt: input.now,
      attribution: { kind: MANUAL_ATTRIBUTION_KIND, ref: null },
      recoveredByStepId: null,
      recoveryMethod: MANUAL_ATTRIBUTION_KIND,
      idempotencyKey: input.failedPaymentId,
    }),
    db
      .update(recoverySteps)
      .set({ result: "cancelled" })
      .where(
        and(
          eq(recoverySteps.failedPaymentId, input.failedPaymentId),
          eq(recoverySteps.accountId, input.accountId),
          isNull(recoverySteps.executedAt),
          paymentIsRecovered,
        ),
      ),
  ];
}

export interface StopRecoveryInput {
  accountId: string;
  failedPaymentId: string;
  now: Date;
}

/**
 * Stop recovery, as ONE atomic batch: the payment goes terminal and every
 * unexecuted step is cancelled together, or neither happens.
 *
 * TWO GUARDS, and the first is a deliberate hardening over legacy.
 *
 * (1) The status UPDATE carries `status = 'active'` in its WHERE, so it CLAIMS
 * the active-to-cancelled transition rather than asserting it. Legacy's cancel
 * route does NOT do this; it fires an unconditional `Promise.all` and discards
 * both results, which was safe for legacy only because nothing bills on cancel.
 * Legacy's own RECOVER route uses exactly this claim shape and explains why: a
 * concurrent writer can resolve the payment between the read and the write. That
 * window is real here too, and a terminal overwrite inside it would assert a
 * FALSE state, recording a merchant-stopped sequence over a payment that had
 * actually been recovered. Ruling 262 decision four routes this through the DO
 * precisely to kill such races; the claim is the same intent expressed in SQL.
 *
 * (2) The steps UPDATE is conditioned on the payment ACTUALLY being cancelled
 * now, via a correlated subquery. Statements in a batch run in order inside one
 * transaction, so this reads statement (1)'s effect: if the claim took zero rows
 * because something else resolved the payment first, the subquery is false and
 * no step is touched. That is what keeps "do not cancel steps when the claim
 * loses" true without branching, which a single atomic batch cannot do.
 *
 * Step cancellation is what actually stops the engine: `stepDueCondition`
 * requires `result IS NULL`, so a cancelled step is never selected again. The
 * exhausted-sequence sweep is separately safe, since it gates on status
 * 'active' and a cancelled payment no longer matches.
 */
export function buildStopRecoveryBatch(db: Db, input: StopRecoveryInput): MoneyWriteBatch {
  const paymentIsCancelled = sql`exists (select 1 from ${failedPayments} where ${failedPayments.id} = ${input.failedPaymentId} and ${failedPayments.accountId} = ${input.accountId} and ${failedPayments.status} = ${FAILED_PAYMENT_STATUS_CANCELLED})`;
  return [
    db
      .update(failedPayments)
      .set({ status: FAILED_PAYMENT_STATUS_CANCELLED, resolvedAt: input.now })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
          eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        ),
      ),
    db
      .update(recoverySteps)
      .set({ result: FAILED_PAYMENT_STATUS_CANCELLED })
      .where(
        and(
          eq(recoverySteps.failedPaymentId, input.failedPaymentId),
          eq(recoverySteps.accountId, input.accountId),
          isNull(recoverySteps.executedAt),
          paymentIsCancelled,
        ),
      ),
  ];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The IO the trigger intent needs, injected so the dispatcher never touches
 * `Env` directly and both executor branches are drivable in tests. The defaults
 * are the cron's own loader and executors; nothing here is a parallel engine.
 */
export interface TriggerDeps {
  loadStep: (accountId: string, stepId: string) => Promise<DueStepRow | null>;
  runRetry: (ctx: RetryStepContext) => Promise<RetryStepResult>;
  runEmail: (ctx: EmailStepContext) => Promise<EmailStepResult>;
}

/**
 * The IO the resend intent needs. One seam, so the send path is drivable in
 * tests without a Workers runtime and the dispatcher never touches `Env`.
 */
export interface ResendSendInput {
  accountId: string;
  recoveryStepId: string;
  to: string;
  subject: string;
  bodyHtml: string;
  now: Date;
}

export interface ResendDeps {
  send: (input: ResendSendInput) => Promise<EmailJobResult>;
}

/**
 * Bind the real send path to `env`: processEmailJob, which is suppression gate,
 * live-send flag, send, and email_sends log, in that order. `queueMessageId` is
 * null because this is the synchronous path, exactly as the engine's defaultSend
 * passes null.
 *
 * THE CAN-SPAM FIELDS ARE ASSEMBLED HERE, and this is where legacy's resend
 * differs most. Legacy's route sends a raw provider call with NO unsubscribe
 * token and NO List-Unsubscribe header, two of the four defects its own sibling
 * trigger route documents as the degraded parallel it removed from itself (scope
 * 1.5). EmailJob makes them non-optional, and buildEmailMessage throws without a
 * physical address, so the pipeline refuses to send a non-compliant message at
 * all. 262 decision three ports the intent, not the defect.
 */
export function resendDepsFor(env: Env): ResendDeps {
  return {
    send: async (input) => {
      const unsubscribeToken = await signUnsubscribeToken(env, {
        email: input.to,
        accountId: input.accountId,
      });
      const job: EmailJob = {
        accountId: input.accountId,
        recoveryStepId: input.recoveryStepId,
        to: input.to,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        template: TEMPLATE_LABEL_RESEND,
        unsubscribeToken,
        physicalAddress: env.PHYSICAL_ADDRESS ?? "",
        idempotencyKey: `resend:${input.recoveryStepId}:${input.now.getTime()}`,
      };
      return processEmailJob(env, job, null);
    },
  };
}

/** Bind the real executors to `env`. The route's only job is to call this. */
export function triggerDepsFor(env: Env, db: Db): TriggerDeps {
  return {
    loadStep: (accountId, stepId) => queryStepForManualTrigger(db, accountId, stepId),
    runRetry: (ctx) => executeRetryStep(env, ctx),
    runEmail: (ctx) => executeEmailStep(env, ctx),
  };
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

  return { ok: false, reason: "not_wired", intent };
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
  } catch {
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
  } catch {
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
  } catch {
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
 * money-path rules the executors already honour.
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
  // account is cancelled. Executing a step is processing, so the brake holds
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
  } catch {
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
  } catch {
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
  } catch {
    return { ok: false, reason: "write_failed", intent: "cancel" };
  }

  // The commit result reports whether the KEY was newly applied, not whether the
  // claim took a row, so the honest answer to "did this actually stop anything"
  // comes from reading the status back. Anything other than cancelled means a
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
