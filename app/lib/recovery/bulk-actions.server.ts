import type { Db } from "~/db";
import { BULK_ACTION_CONCURRENCY, BULK_ACTION_MAX_PER_SUBMISSION } from "~/lib/constants";

import { dispatchManualAction, type ManualActionCommit } from "./manual-actions.server";
import { type ResendDeps, type TriggerDeps } from "./manual-action-deps.server";
import {
  isBulkActionIntent,
  toItemResult,
  type BulkActionRefusal,
  type BulkActionResult,
} from "./bulk-results";

// S6 bulk actions, Session 2 (274 decisions one, four and five).
//
// THE WHOLE LAYER IS FAN-OUT AND AGGREGATION. Every per-payment semantic,
// precondition, refusal reason, idempotency key and money-path guarantee already
// belongs to dispatchManualAction and is left exactly where it is: this module
// calls it once per id and collects what it says. 274 decision five chose that
// shape (option A in parity/S6-BULK-SCOPE.md 2.5) over one batched write,
// because ten payments are ten independent operations and a merchant does not
// want nine good ones rolled back by the tenth.
//
// THE CLIENT'S CLAIM IS TREATMENT, NEVER AUTHORITY. The ids arrive from a
// browser, so every one of them is re-derived server-side through the
// dispatcher's own account-scoped read and per-intent preconditions. A payment
// that is not owned answers not_found exactly as it would singly, and a payment
// that is no longer active answers not_active. Nothing is filtered out silently
// on the way in: an id that was sent appears in the results with its reason.
//
// SESSION 3 adds the two remaining intents and NO mechanism. Trigger and
// mark_recovered ride this same function; what changed is the vocabulary the
// results can carry (bulk-results.ts) and an intent allow-list, which Session 2
// shipped without.
//
// SEND-PRECEDES-PERSIST APPLIES TO BULK TRIGGER, WITH THE SURFACE
// MULTIPLIED, and is STATED here rather than solved, exactly as 268 parked it.
// The defect is the executor's: an email step's claim (WHERE executed_at IS
// NULL) prevents the double WRITE, not the double SEND, so a manual trigger
// racing the 5-minute tick inside the same window can put two copies of one
// dunning email in a customer's inbox. Bulk does not create that race and does
// not widen it per payment; it multiplies the number of payments exposed to it
// in one click, so N selected email steps are N independent chances at the same
// shared defect. Two things bound it and neither is a fix: 274 decision four's
// confirmation and ceiling bound N, and the executors are untouched here,
// so the exposure is exactly the single-payment one, N times. The design is owed
// at the pre-first-merchant hardening pass, and no session may quietly
// close it by changing executor semantics from this layer.

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * The repo carries NO concurrency utility (measured across app/: every
 * "concurrent" occurrence is a comment about a database race, never a limiter),
 * so this is new rather than reused, and the number is reported for ratification
 * rather than claimed as convention.
 *
 * Why a cap at all, and why a small one. Legacy's fan-out is an UNCAPPED
 * Promise.all over the whole selection (scope 1.6). The per-account money-write
 * DO already serializes the commits, so raising concurrency buys nothing on the
 * write path; what it would widen is the read phase and the peak subrequest
 * burst inside one Worker invocation. The repo's own budget arithmetic for
 * RECOVERY_TICK_LIMIT reasons in exactly those terms, about 4 to 5 subrequests
 * per unit of work keeping one invocation inside one subrequest budget, and the
 * ceiling of 100 per submission lands this fan-out in the same envelope it
 * already sizes for.
 *
 * Results are returned in INPUT order regardless of completion order, so the
 * surface is deterministic.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunBulkActionInput {
  db: Db;
  accountId: string;
  intent: string;
  ids: readonly string[];
  commit: ManualActionCommit;
  trigger: TriggerDeps;
  resend: ResendDeps;
  now?: Date;
}

/**
 * Fan one intent out over many payments and report what happened to each.
 *
 * THREE THINGS ARE REFUSED WHOLE, before any payment is touched, and all three
 * are enforced HERE and not only in the browser, because a hand crafted POST is
 * exactly the case a client-side control cannot cover.
 *
 * An intent outside the bulk set. The dispatcher accepts five intents and bulk
 * offers three, legacy's own set (scope 1.5). Without this gate a POST carrying
 * intent=resend would have fanned a real send out over the whole selection and
 * intent=note would have blanked N notes, neither of them reachable from the
 * interface and neither of them bounded by anything the ceiling checks.
 *
 * An empty submission, which is a refusal rather than a successful nothing.
 *
 * A submission over the ceiling, REFUSED with its own count reported. It is
 * never trimmed to the first hundred, which would mutate a set the merchant
 * never chose.
 */
export async function runBulkAction(
  input: RunBulkActionInput,
): Promise<BulkActionResult | BulkActionRefusal> {
  const ids = [...new Set(input.ids)];
  if (!isBulkActionIntent(input.intent)) {
    return {
      refused: "unknown_intent",
      submitted: ids.length,
      ceiling: BULK_ACTION_MAX_PER_SUBMISSION,
    };
  }
  if (ids.length === 0) {
    return { refused: "empty", submitted: 0, ceiling: BULK_ACTION_MAX_PER_SUBMISSION };
  }
  if (ids.length > BULK_ACTION_MAX_PER_SUBMISSION) {
    return {
      refused: "over_ceiling",
      submitted: ids.length,
      ceiling: BULK_ACTION_MAX_PER_SUBMISSION,
    };
  }

  const results = await mapWithConcurrency(ids, BULK_ACTION_CONCURRENCY, async (id) => {
    const outcome = await dispatchManualAction({
      db: input.db,
      accountId: input.accountId,
      failedPaymentId: id,
      intent: input.intent,
      commit: input.commit,
      trigger: input.trigger,
      resend: input.resend,
      now: input.now,
    });
    return toItemResult(id, outcome);
  });

  return { intent: input.intent, results };
}
