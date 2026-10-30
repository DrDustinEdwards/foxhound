// Win-back intents of the connected-account webhook: reactivation and sequence
// start. Dispatched from process.ts.

import { DAY_MS, WINBACK_RECENT_RESOLVED_DAYS } from "~/lib/constants";
import { recordOutcome } from "~/lib/engine/outcomes";
import { reactivateWinbackSequence } from "~/lib/recovery/winback-reactivation.server";
import { executeMoneyWrite } from "~/lib/money/execute";

import { buildClaimOnlyBatch, buildInvoluntaryStopBatch, buildWinbackStartBatch } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";
import {
  findWinbackSequence,
  hasRecentlyResolvedFailedPayment,
  listActiveFailedPaymentIds,
  resolveConnectedCustomer,
  resolveWinbackStep1Offset,
} from "./lookups";

export async function handleWinbackReactivate(
  ctx: WebhookContext,
  intent: IntentOf<"winback_reactivate">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim, idempotencyKey } = ctx;
  // THE REACTIVATION, PRIMARY PATH. The session carries the sequence id
  // Foxhound put on it at the resubscribe click, so the match is exact and
  // needs no Stripe read.
  //
  // THE FLIP RUNS FIRST AND THROUGH THE PLAIN BATCH PATH,
  // and its own status condition is the idempotency claim: a redelivery
  // flips zero rows and records no second outcome, whether it arrives
  // before or after the webhook claim below lands.
  const outcome = await reactivateWinbackSequence(env, {
    accountId,
    sequenceId: intent.sequenceId,
    now: receivedAt,
  });
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => buildClaimOnlyBatch(db, claim),
  });
  if (!applied) return { status: "duplicate" };
  return outcome.status === "reactivated"
    ? { status: "applied" }
    : { status: "ignored", reason: `winback_${outcome.status}` };
}

export async function handleWinbackStart(
  ctx: WebhookContext,
  intent: IntentOf<"winback_start">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // WIN-BACK CREATION, ported from legacy's handleSubscriptionDeleted.
  // Legacy's eligibility conditions in legacy's order; each returns without
  // a sequence, and each still CLAIMS the event so redelivery short-circuits.
  //
  // 1. INVOLUNTARY CHURN. Legacy: `.eq('status','active')` over this
  //    customer's failed_payments, `const isInvoluntary = ... length > 0`,
  //    and when true it cancels those payments and returns WITHOUT a
  //    win-back. A customer whose card failed did not choose to leave, so
  //    chasing them with a win-back is the wrong sequence.
  //    SCOPE, stated rather than silently dropped: the GUARD is ported here.
  //    Legacy's accompanying SIDE EFFECT, flipping those failed_payments to
  //    'cancelled' and resolving their steps, is NOT ported in this fold and
  //    is RAISED: that exact transition is 265's ratified Stop-recovery
  //    shape, which claims on `status = 'active'` and conditions the steps
  //    on the claim landing, and legacy's unconditional per-row update would
  //    either duplicate or contradict it. Re-deciding a ratified money
  //    transition is a ruling, not a build session's default.
  const involuntaryIds = await listActiveFailedPaymentIds(env, accountId, intent.customerId);
  if (involuntaryIds.length > 0) {
    // THE FLIP LANDS HERE, through 265's ratified transition rather
    // than legacy's unconditional per-row update. Still no win-back.
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) =>
        buildInvoluntaryStopBatch(db, {
          claim,
          accountId,
          failedPaymentIds: involuntaryIds,
          now: receivedAt,
        }),
    });
    return applied ? { status: "ignored", reason: "involuntary_churn" } : { status: "duplicate" };
  }

  // 2. RECENTLY CHASED. Legacy: statuses ['cancelled','recovered'] with
  //    `resolved_at >= sevenDaysAgo`, WINBACK_RECENT_RESOLVED_DAYS = 7,
  //    "keeps Recova from chasing customers we already chased".
  const recentlyResolved = await hasRecentlyResolvedFailedPayment(
    env,
    accountId,
    intent.customerId,
    receivedAt.getTime() - WINBACK_RECENT_RESOLVED_DAYS * DAY_MS,
  );
  if (recentlyResolved) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    return applied ? { status: "ignored", reason: "recently_resolved" } : { status: "duplicate" };
  }

  // 3. REPLAY GUARD. Legacy keys its own on stripe_subscription_id: "one
  //    win-back sequence per canceled subscription, ever". This SELECT is
  //    the cheap pre-check; the real guarantee is the unique index, which
  //    makes a concurrent redelivery roll the whole batch back.
  const existing = await findWinbackSequence(env, accountId, intent.subscriptionId);
  if (existing) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    return applied ? { status: "ignored", reason: "winback_exists" } : { status: "duplicate" };
  }

  // 4. THE EMAIL GATE. Legacy fetches the customer and returns on a missing
  //    address: a sequence with nobody to mail is three dead rows. The read
  //    is best-effort, so a Stripe failure ignores rather than 500s, which
  //    matches legacy catching its own retrieve and falling through to the
  //    same empty-email return.
  const customer = await resolveConnectedCustomer(env, connectionId, intent.customerId);
  if (!customer?.email) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    return applied ? { status: "ignored", reason: "no_customer_email" } : { status: "duplicate" };
  }

  // 5. THE INTELLIGENCE GATE, SEMANTICALLY ported from legacy.
  //    Legacy's provenance, quoted:
  //
  //      const { data: intelligenceProduct } = await supabase
  //        .from('account_products').select('status')
  //        .eq('account_id', accountId).eq('product', 'intelligence')
  //        .eq('status', 'active').maybeSingle()
  //      if (intelligenceProduct) {
  //        ... if (recommendation !== 'winback_priority') { step1OffsetHours = 4 }
  //      }
  //
  // INTELLIGENCE IS FREE (Dustin, 2026-10-29), so legacy's condition is true
  // on every account and the gate itself is gone; only its body remains.
  //
  // Value and direction stay legacy's: a customer NOT flagged
  // winback_priority is DELAYED from the 1h default to 4h, and a flagged
  // customer keeps the default. Legacy falls open to the default on any
  // lookup error and so does this.
  //
  // The flagged branch needs `winback_priority` in recommended_action; a
  // customer without it takes the unflagged 4h branch.
  const step1OffsetHours = await resolveWinbackStep1Offset(env, accountId, intent.customerId);

  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildWinbackStartBatch(db, {
        claim,
        accountId,
        stripeConnectionId: connectionId,
        stripeCustomerId: intent.customerId,
        stripeSubscriptionId: intent.subscriptionId,
        customerEmail: customer.email as string,
        customerName: customer.name ?? null,
        planName: intent.planName,
        amountCents: intent.amountCents,
        currency: intent.currency,
        cancelReason: intent.cancelReason,
        canceledAt: receivedAt,
        step1OffsetHours,
      }),
  });
  // THE STARTED OUTCOME, the pre-existing divergence this
  // session fixes. Legacy records `winback_sequence_started` at creation;
  // buildWinbackStartBatch wrote the sequence and its steps and recorded
  // nothing, so a Foxhound merchant's moat was missing a row legacy has.
  //
  // It hooks AFTER the money write and only when it applied, which is 339
  // binding 1's pattern: `applied` is this delivery's claim, false on a
  // replay because the webhook claim collides and the whole batch rolls
  // back. The outcome's own idempotency key is keyed on the SUBSCRIPTION,
  // which is what legacy keys its one-sequence-ever guard on and what
  // win_back_sequences_subscription_uq enforces here, so the two layers
  // agree on granularity.
  if (applied) {
    await recordOutcome(env, {
      accountId,
      product: "recovery",
      eventType: "winback_sequence_started",
      outcome: "started",
      eventData: {
        amountCents: intent.amountCents,
        currency: intent.currency,
        cancelReason: intent.cancelReason,
      },
      idempotencyKey: `winback-started:${intent.subscriptionId}`,
      outcomeAt: receivedAt,
    });
  }
  return applied ? { status: "applied" } : { status: "duplicate" };
}
