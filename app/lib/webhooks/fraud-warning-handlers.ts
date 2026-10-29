// Early fraud warning intents of the connected-account webhook
// (radar.early_fraud_warning.created and .updated). Dispatched from process.ts.

import { and, eq } from "drizzle-orm";
import { earlyFraudWarnings, getDb } from "~/db";
import {
  readWarningCharge,
  sendEarlyFraudWarningNotice,
} from "~/lib/disputes/fraud-warnings.server";
import { executeMoneyWrite } from "~/lib/money/execute";

import { buildClaimOnlyBatch, buildWebhookClaim } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";
import { resolveDisputedRecovery } from "./lookups";

/**
 * Record the warning, one row per Stripe warning per account, claimed in the
 * same atomic batch as every other webhook side effect.
 *
 * A known warning only has its `actionable` flag moved (by .updated; a late
 * .created changes nothing). An unknown one, from either event, reads its charge
 * for the amount, currency and customer, links the Foxhound recovery the charge
 * was taken in when there is one, and inserts. The insert is guarded on the
 * (account, warning) unique index rather than relying on the read above, so two
 * events racing each other cannot make two rows.
 *
 * THE NOTICE goes out after the commit, on a redelivery too, for the same reason
 * the new-dispute notice does: its send claim (`early-fraud-warning:<row id>`)
 * keeps it to one email, and the notice itself skips a warning no longer open.
 */
export async function handleEarlyFraudWarning(
  ctx: WebhookContext,
  intent: IntentOf<"early_fraud_warning">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  const existing = await findWarningId(env, accountId, intent.stripeWarningId);

  let applied: boolean;
  if (existing) {
    ({ applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (b) =>
        intent.created
          ? buildClaimOnlyBatch(b, claim)
          : [
              buildWebhookClaim(b, claim),
              b
                .update(earlyFraudWarnings)
                .set({ actionable: intent.actionable })
                .where(and(eq(earlyFraudWarnings.id, existing), eq(earlyFraudWarnings.accountId, accountId))),
            ],
    }));
  } else {
    const charge = await readWarningCharge(env, connectionId, intent.chargeId);
    const paymentIntentId = intent.paymentIntentId ?? charge.paymentIntentId;
    const linked = await resolveDisputedRecovery(env, accountId, connectionId, paymentIntentId);
    const values = {
      id: crypto.randomUUID(),
      accountId,
      stripeConnectionId: connectionId,
      stripeWarningId: intent.stripeWarningId,
      stripeChargeId: intent.chargeId,
      stripePaymentIntentId: paymentIntentId,
      stripeCustomerId: charge.customerId,
      customerEmail: charge.customerEmail,
      customerName: charge.customerName,
      failedPaymentId: linked?.failedPayment.id ?? null,
      fraudType: intent.fraudType,
      actionable: intent.actionable,
      amountCents: charge.amountCents,
      currency: charge.currency,
      createdAt: intent.createdAt,
      receivedAt,
    };
    ({ applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (b) => [
        buildWebhookClaim(b, claim),
        intent.created
          ? b.insert(earlyFraudWarnings).values(values).onConflictDoNothing()
          : b.insert(earlyFraudWarnings).values(values).onConflictDoUpdate({
              target: [earlyFraudWarnings.accountId, earlyFraudWarnings.stripeWarningId],
              set: { actionable: intent.actionable },
            }),
      ],
    }));
  }

  const warningId = existing ?? (await findWarningId(env, accountId, intent.stripeWarningId).catch(() => null));
  if (warningId) await sendEarlyFraudWarningNotice(env, { accountId, warningId });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

async function findWarningId(env: Env, accountId: string, stripeWarningId: string): Promise<string | null> {
  const [row] = await getDb(env)
    .select({ id: earlyFraudWarnings.id })
    .from(earlyFraudWarnings)
    .where(and(eq(earlyFraudWarnings.accountId, accountId), eq(earlyFraudWarnings.stripeWarningId, stripeWarningId)))
    .limit(1);
  return row?.id ?? null;
}
