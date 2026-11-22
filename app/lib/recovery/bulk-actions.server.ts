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

// Bulk actions: THE WHOLE LAYER IS FAN-OUT AND
// AGGREGATION. Every per-payment semantic, precondition, refusal reason, idempotency key and
// money-path guarantee already belongs to dispatchManualAction and is left exactly where it is:
// this module calls it once per id and collects what it says. One call per id rather than one
// batched write, because ten payments are ten independent operations and a merchant does
// not want nine good ones rolled back by the tenth.

/**
 * Run `task` over `items` with at most `limit` in flight. The repo carries NO concurrency utility
 * (measured across app/: every "concurrent" occurrence is a comment about a database race, never a
 * limiter), so this is new rather than reused, and the number is reported for ratification rather
 * than claimed as convention. The per-account money-write DO already serializes the commits, so
 * raising concurrency buys nothing on the write path; what it would widen is the read phase and the
 * peak subrequest burst inside one Worker invocation.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
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
 * Fan one intent out over many payments and report what happened to each. THREE THINGS ARE REFUSED
 * WHOLE, before any payment is touched, and all three are enforced HERE and not only in the
 * browser, because a hand crafted POST is exactly the case a client-side control cannot cover. It
 * is never trimmed to the first hundred, which would mutate a set the merchant never chose.
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
