import { logEvent } from "@dustinedwards/site-runtime/log";

import { outcomes } from "~/db";
import type { AttributionKind } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";

// recordOutcome: the Network Intelligence Layer write. Never throws: outcomes are analytics and must never
// block the recovery/dispute/billing path that called it. attributionKind + attributedRef are recorded on the
// row so lift and billing derive from it. The write rides the per-account money-write Durable Object with a
// required idempotency key (outcomes_idempotency_uq).

export interface RecordOutcomeParams {
  accountId: string;
  product: string;
  eventType: string;
  eventData?: Record<string, unknown>;
  outcome?: string;
  outcomeAt?: Date;
  attributionKind?: AttributionKind;
  attributedRef?: string;
  idempotencyKey: string;
}

/** Record an outcome. Never throws. True when newly written, false on an idempotent no-op or a swallowed failure. */
export async function recordOutcome(env: Env, params: RecordOutcomeParams): Promise<boolean> {
  try {
    const now = new Date();
    const { applied } = await executeMoneyWrite(env, {
      accountId: params.accountId,
      idempotencyKey: params.idempotencyKey,
      build: (db) => [
        db.insert(outcomes).values({
          accountId: params.accountId,
          product: params.product,
          eventType: params.eventType,
          eventData: params.eventData ?? {},
          outcome: params.outcome ?? null,
          outcomeAt: params.outcomeAt ?? now,
          createdAt: now,
          idempotencyKey: params.idempotencyKey,
          attributionKind: params.attributionKind ?? null,
          attributedRef: params.attributedRef ?? null,
        }),
      ],
    });
    return applied;
  } catch (err) {
    logEvent(
      "record_outcome_failed",
      { account_id: params.accountId, event_type: params.eventType, error: err },
      { level: "error" },
    );
    return false;
  }
}
