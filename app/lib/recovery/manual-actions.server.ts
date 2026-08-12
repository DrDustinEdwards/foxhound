import type { MoneyWriteBuilder } from "~/db/money-write";
import type { Db } from "~/db";
import { FAILED_PAYMENT_STATUS_ACTIVE } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";

import { getFailedPaymentDetail } from "./queries.server";
import { lastResendableEmailStep, nextPendingStep } from "./step-state";

// The shared entry point for S7's four manual payment-detail actions: Trigger
// next step now, Mark as recovered, Stop recovery, Resend last email. Legacy
// ships these as four separate Next.js route handlers that each re-implement
// auth, account scoping, ownership and the status gate
// (app/api/payments/[id]/{trigger,recover,cancel,resend}/route.ts, read in full
// in parity/S7-PHASE2-SCOPE.md section 1). Foxhound has one POST target and one
// dispatcher, so those four checks are written once and cannot drift, which is
// exactly where legacy's four copies DID drift: its resend handler resolves the
// account through a different helper than its three siblings and skips the
// status gate entirely (scope section 1.5, defects 2 and 4).
//
// THIS SESSION LANDS PLUMBING, NOT BEHAVIOR (ruling 260, Session A). Every
// intent resolves to NOT_WIRED after its preconditions pass, so the route's
// response is unchanged. Sessions B through E replace one NOT_WIRED at a time,
// each governed by its own ruling in 262.
//
// Money-path contract, ruling 262 decision four: EVERY Phase 2 mutation routes
// through the per-account money-write Durable Object. No intent mutates yet, so
// nothing is committed here; commitManualActionWrite below is the seam each
// wiring session commits through, and it is the only sanctioned path. A future
// intent that reaches for getDb().batch() directly is a defect, not a shortcut.

/** Legacy's four actions, in legacy's order. `note` is deliberately NOT here:
 *  it is a separate POST target in legacy with no money surface, no status gate
 *  and no precondition, and test/payment-detail-actions.test.ts pins its absence
 *  from the action row. */
export const MANUAL_ACTION_INTENTS = ["trigger", "mark_recovered", "cancel", "resend"] as const;

export type ManualActionIntent = (typeof MANUAL_ACTION_INTENTS)[number];

/** Narrow an untrusted form value to a known intent. Returns null for anything
 *  else, including `note`, so an unrecognized POST is refused rather than
 *  falling through to a default action. */
export function parseManualActionIntent(raw: unknown): ManualActionIntent | null {
  return typeof raw === "string" && (MANUAL_ACTION_INTENTS as readonly string[]).includes(raw)
    ? (raw as ManualActionIntent)
    : null;
}

/**
 * Why a manual action did not run, or that it passed every gate and is simply
 * not wired yet. Mapped to a response by the caller; nothing here formats user
 * copy, so the route owns the strings and this module owns the decision.
 *
 * The refusal reasons mirror legacy's own status codes, recorded per action in
 * scope section 1.7:
 *   not_found          -> legacy 404 "Not found"
 *   not_active         -> legacy 400 "Payment is not active"
 *   no_pending_step    -> legacy 400 "No pending steps"    (trigger only)
 *   no_email_to_resend -> legacy 400 "No email to resend"  (resend only)
 *   unknown_intent     -> no legacy equivalent; legacy encodes the action in the
 *                         URL path, so an unknown action 404s at the router. One
 *                         POST target means Foxhound has to reject it in code.
 */
export type ManualActionOutcome =
  | { ok: false; reason: "unknown_intent" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_active"; intent: ManualActionIntent }
  | { ok: false; reason: "no_pending_step" }
  | { ok: false; reason: "no_email_to_resend" }
  | { ok: false; reason: "not_wired"; intent: ManualActionIntent };

/**
 * Whether an intent requires status 'active' server-side.
 *
 * Three of legacy's four handlers re-check the status after the ownership read
 * and 400 if it is not active. Legacy's RESEND HANDLER DOES NOT: it never selects
 * the status column, so only the client's `isActive` gate stops a resend on a
 * recovered or terminal payment (scope section 1.5, defect 2, and scope section
 * 4 raises the question). Ruling 262 decided resend's SUPPRESSION gap and did not
 * decide this one, so legacy's shape is ported exactly rather than silently
 * hardened, and the gap is carried as a REPORTED open question. If it is later
 * ruled closed, this map is the single line that changes.
 */
export const MANUAL_ACTION_REQUIRES_ACTIVE: Record<ManualActionIntent, boolean> = {
  trigger: true,
  mark_recovered: true,
  cancel: true,
  resend: false,
};

/**
 * Resolve and gate one manual action against the caller's own account.
 *
 * Ownership is enforced the same way every other read in this tree enforces it:
 * getFailedPaymentDetail is account-scoped, so a payment belonging to another
 * account is indistinguishable from one that does not exist, and both land on
 * not_found. That is legacy's contract too (its handlers filter on account_id
 * and return the same 404 for a mismatch), and it is what keeps a payment id
 * from being an enumeration oracle across tenants.
 *
 * `accountId` is the CALLER'S resolved account and must come from the request's
 * authenticated session, never from the submitted form.
 */
export async function dispatchManualAction(
  db: Db,
  accountId: string,
  failedPaymentId: string,
  rawIntent: unknown,
): Promise<ManualActionOutcome> {
  const intent = parseManualActionIntent(rawIntent);
  if (!intent) return { ok: false, reason: "unknown_intent" };

  const detail = await getFailedPaymentDetail(db, accountId, failedPaymentId);
  if (!detail) return { ok: false, reason: "not_found" };

  if (
    MANUAL_ACTION_REQUIRES_ACTIVE[intent] &&
    detail.failedPayment.status !== FAILED_PAYMENT_STATUS_ACTIVE
  ) {
    return { ok: false, reason: "not_active", intent };
  }

  if (intent === "trigger" && nextPendingStep(detail.steps) === null) {
    return { ok: false, reason: "no_pending_step" };
  }

  if (intent === "resend" && lastResendableEmailStep(detail.steps) === null) {
    return { ok: false, reason: "no_email_to_resend" };
  }

  return { ok: false, reason: "not_wired", intent };
}

/**
 * The idempotency key for a manual action's money write.
 *
 * Omit `repeatToken` for an intent that may happen AT MOST ONCE for a payment,
 * so a double-submit or a retried request collapses onto the same key and the
 * Durable Object's seen-set makes the second attempt a no-op. Mark as recovered
 * and Stop recovery are both once-ever: a payment is recovered once, and a
 * stopped sequence stays stopped.
 *
 * Pass a `repeatToken` for an intent a merchant may legitimately perform more
 * than once, where collapsing would silently swallow the second request. Resend
 * is the clear case: sending the same email twice on purpose is a real thing a
 * merchant does, so its key has to vary per request rather than per payment.
 *
 * The choice per intent is NOT made here, because it is a behavioral decision
 * belonging to the session that wires that intent (262 decisions one, two, three
 * and five each govern one). This function only guarantees the namespace, so no
 * manual action can ever collide with the webhook spine's own keys, which are
 * Stripe event ids and `recovery:`-prefixed.
 */
export function manualActionIdempotencyKey(
  intent: ManualActionIntent,
  failedPaymentId: string,
  repeatToken?: string,
): string {
  const base = `manual:${intent}:${failedPaymentId}`;
  return repeatToken === undefined ? base : `${base}:${repeatToken}`;
}

/**
 * The ONLY sanctioned way a manual action mutates (ruling 262 decision four).
 * Serializes on the account through the money-write Durable Object and commits
 * the caller's statements as one atomic batch, so two manual actions on the same
 * account, or a manual action racing the webhook spine, cannot interleave.
 *
 * Nothing calls this yet: every intent returns not_wired this session. It is
 * exported now so each wiring session inherits the routing rather than choosing
 * it, which is the mistake ruling 262 exists to prevent.
 */
export async function commitManualActionWrite(
  env: Env,
  accountId: string,
  idempotencyKey: string,
  build: MoneyWriteBuilder,
): Promise<{ applied: boolean }> {
  return executeMoneyWrite(env, { accountId, idempotencyKey, build });
}
