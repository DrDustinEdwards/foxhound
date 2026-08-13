import type { Db } from "~/db";
import { BULK_ACTION_CONCURRENCY, BULK_ACTION_MAX_PER_SUBMISSION } from "~/lib/constants";

import {
  dispatchManualAction,
  type ManualActionCommit,
  type ResendDeps,
  type TriggerDeps,
} from "./manual-actions.server";
import { toItemResult, type BulkActionRefusal, type BulkActionResult } from "./bulk-results";

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
 * DO already serialises the commits, so raising concurrency buys nothing on the
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
 * The ceiling is enforced HERE and not only in the browser, because a hand
 * crafted POST is exactly the case the client-side confirmation cannot cover.
 * Over the ceiling the whole submission is REFUSED with its own count reported;
 * it is never trimmed to the first hundred, which would mutate a set the
 * merchant never chose (274 decision four).
 */
export async function runBulkAction(
  input: RunBulkActionInput,
): Promise<BulkActionResult | BulkActionRefusal> {
  const ids = [...new Set(input.ids)];
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
