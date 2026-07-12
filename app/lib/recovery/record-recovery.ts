import type { Db, MoneyWriteBatch } from "~/db";
import { outcomes, recoveredPayments } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { isBillableAttribution, type ResolvedAttribution } from "./attribution";

// Records a recovered payment WITH its attribution, through the per-account
// money-write Durable Object, as ONE atomic batch: the recovered_payments row
// (the billing denominator) + the outcomes moat row. Both attributed and
// baseline recoveries are recorded with equal fidelity; baseline is the free
// line (PRICING.md spine #2).
//
// Boundary: the invoice.payment_succeeded webhook (Phase 4c) owns setting the
// failed_payments 'recovered' status (the race rule); THIS records the recovery
// evidence + attribution and is called from that webhook. Phase 4b builds and
// unit-tests it.
//
// Idempotency: the outcomes row carries a stable key (outcomes_idempotency_uq),
// so a webhook redelivery makes the whole atomic batch fail the unique
// constraint and roll back - exactly-once recovery recording by construction.

export interface RecordRecoveryInput {
  accountId: string;
  failedPaymentId: string;
  amountCents: number;
  currency: string;
  recoveredAt: Date;
  attribution: ResolvedAttribution;
  /** The recovery_steps row credited (e.g. the succeeded retry), if any. */
  recoveredByStepId?: string | null;
  /** How the money came back: retry | email | card_update | stripe_baseline. */
  recoveryMethod: string;
  /** Stable per recovery event (e.g. the Stripe event id) so replays collapse. */
  idempotencyKey: string;
}

/** The atomic batch for a recovery recording. Extracted so it is unit-testable. */
export function buildRecoveryBatch(db: Db, input: RecordRecoveryInput): MoneyWriteBatch {
  const attributed = isBillableAttribution(input.attribution.kind);
  const key = `recovery:${input.idempotencyKey}`;
  return [
    db.insert(recoveredPayments).values({
      accountId: input.accountId,
      failedPaymentId: input.failedPaymentId,
      recoveredAt: input.recoveredAt,
      amountCents: input.amountCents,
      currency: input.currency,
      recoveryMethod: input.recoveryMethod,
      recoveredByStepId: input.recoveredByStepId ?? null,
      attributionKind: input.attribution.kind,
      attributionRef: input.attribution.ref,
      // Attributed recoveries stamp attributed_at; baseline stays null (free).
      attributedAt: attributed ? input.recoveredAt : null,
    }),
    db.insert(outcomes).values({
      accountId: input.accountId,
      product: "recovery",
      eventType: "payment_recovered",
      outcome: attributed ? "recovered_attributed" : "recovered_baseline",
      outcomeAt: input.recoveredAt,
      createdAt: input.recoveredAt,
      idempotencyKey: key,
      attributionKind: input.attribution.kind,
      attributedRef: input.attribution.ref,
      eventData: {
        amountCents: input.amountCents,
        currency: input.currency,
        method: input.recoveryMethod,
      },
    }),
  ];
}

/** Record a recovery. Returns true if newly recorded, false on idempotent replay. */
export async function recordRecovery(
  env: Env,
  input: RecordRecoveryInput,
): Promise<boolean> {
  const { applied } = await executeMoneyWrite(env, {
    accountId: input.accountId,
    idempotencyKey: `recovery:${input.idempotencyKey}`,
    build: (db) => buildRecoveryBatch(db, input),
  });
  return applied;
}
