import * as Sentry from "@sentry/cloudflare";

import { outcomes } from "~/db";
import type { AttributionKind } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";

// recordOutcome: the Network Intelligence Layer write (the moat). Ported from
// legacy lib/outcomes.ts with its two load-bearing invariants preserved:
//
//   1. NEVER THROWS. Outcomes are analytics; a failure here must never block the
//      recovery/dispute/billing path that called it. Failures are captured and
//      dropped. (Legacy: try/catch + Sentry.captureException.)
//   2. ATTRIBUTION IS FIRST-CLASS. attributionKind + attributedRef are recorded
//      on the row (SCHEMA.md spine #1), so lift and billing derive from the row.
//
// Unlike legacy (a bare Supabase insert), the write is routed through the
// per-account money-write Durable Object: outcomes is a money/moat table, so it
// rides the same serialized, idempotent path as billing. The row carries a
// required idempotency key (outcomes_idempotency_uq) closing the legacy
// at-most-once crash gap (SCHEMA.md spine #4).
//
// Call-site inventory (which legacy sites map here, wired in 4b-4d):
// docs/engine/outcome-callsites.md.

export interface RecordOutcomeParams {
  accountId: string;
  /** recovery | disputes | intelligence | audit (SCHEMA.md product vocabulary). */
  product: string;
  /** The outcomes-table event vocabulary (e.g. recovery_succeeded, dispute_won). */
  eventType: string;
  eventData?: Record<string, unknown>;
  outcome?: string;
  outcomeAt?: Date;
  /** Attribution (SCHEMA.md spine #1). Required for billable recovery outcomes. */
  attributionKind?: AttributionKind;
  /** FK/id of the attributing action (retry step, engagement event, card update). */
  attributedRef?: string;
  /** Stable per logical event; a replay collapses via outcomes_idempotency_uq. */
  idempotencyKey: string;
}

/**
 * Record an outcome. Never throws. Returns true when the row was newly written,
 * false on an idempotent no-op (already recorded) or a swallowed failure.
 */
export async function recordOutcome(
  env: Env,
  params: RecordOutcomeParams,
): Promise<boolean> {
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
    // Moat write must not block the caller. Capture and drop (legacy semantics).
    Sentry.captureException(err, {
      extra: {
        scope: "recordOutcome",
        accountId: params.accountId,
        eventType: params.eventType,
      },
    });
    return false;
  }
}
