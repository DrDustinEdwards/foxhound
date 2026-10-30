import { and, desc, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db } from "~/db";
import { accounts, earlyFraudWarnings, getDb, stripeConnections } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getConnectedStripe } from "~/lib/stripe/client";
import { asId } from "~/lib/stripe/ids";
import { decryptToken } from "~/lib/stripe/encryption";

import { isDefiniteRefusal } from "./accept.server";
import {
  EARLY_FRAUD_WARNING_TEMPLATE,
  EARLY_FRAUD_WARNINGS_PATH,
  earlyFraudWarningNotice,
  isOpenWarning,
  REFUND_MESSAGES,
  type RefundRefusal,
  warningCustomerLabel,
} from "./fraud-warnings";
import { disputeNoticeFooterNote } from "./notices";
import { appUrl, type DisputeNoticeOutcome, send } from "./notices.server";
import { getConnectionAccessToken } from "./queries.server";

// EARLY FRAUD WARNINGS, the reads and writes (the words are ./fraud-warnings.ts).
//
// THE REFUND is the merchant's choice on the disputes dashboard, guarded like
// the dispute Accept (accept.server.ts): the warning is read under the signed-in
// account, Stripe is asked first, and only then is anything written. Before it
// refunds, Stripe's own charge is read, and a charge already fully refunded or
// already disputed is never refunded here; the page says which.
//
// ONE STRIPE REFUND PER WARNING. refunds.create carries the idempotency key
// `early-fraud-warning-refund:<stripe warning id>`, so two tabs or two clicks
// make one refund at Stripe and the second gets the first's result back.
//
// NOTHING BILLABLE. A refund here is not a won dispute and earns Foxhound
// nothing, so the only write is the warning's own refunded_at and refund id.
// When the refunded charge was a Foxhound recovery, Stripe's charge.refunded
// event unbills that recovery through the existing refund stamp, as any refund
// does (ruling 29).

export type WarningRow = typeof earlyFraudWarnings.$inferSelect;

/** The open warnings on the page, newest first, and whether the account has
 *  ever had one (the section shows only then). */
export async function listEarlyFraudWarnings(
  db: Db,
  accountId: string,
): Promise<{ open: WarningRow[]; any: boolean }> {
  const rows = await db
    .select()
    .from(earlyFraudWarnings)
    .where(eq(earlyFraudWarnings.accountId, accountId))
    .orderBy(desc(earlyFraudWarnings.createdAt));
  return { open: rows.filter(isOpenWarning), any: rows.length > 0 };
}

/** One warning, pinned to the account. */
async function findEarlyFraudWarning(db: Db, accountId: string, warningId: string): Promise<WarningRow | null> {
  const [row] = await db
    .select()
    .from(earlyFraudWarnings)
    .where(and(eq(earlyFraudWarnings.id, warningId), eq(earlyFraudWarnings.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export interface WarningCharge {
  amountCents: number;
  currency: string;
  customerId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  paymentIntentId: string | null;
}

/**
 * The warned charge, read from the connected account when the warning arrives.
 * THROWS on any failure (no token, decrypt, Stripe), so the webhook 500s and
 * Stripe redelivers with nothing claimed: the amount is what the merchant
 * decides on, and a row without it would be a guess.
 */
export async function readWarningCharge(env: Env, connectionId: string, chargeId: string): Promise<WarningCharge> {
  const token = await getConnectionAccessToken(getDb(env), connectionId);
  if (!token) throw new Error("no stored access token for connection");
  const charge = await getConnectedStripe(await decryptToken(env, token)).charges.retrieve(chargeId);
  return {
    amountCents: charge.amount,
    currency: charge.currency,
    customerId: asId(charge.customer),
    customerEmail: charge.billing_details?.email ?? charge.receipt_email ?? null,
    customerName: charge.billing_details?.name ?? null,
    paymentIntentId: asId(charge.payment_intent),
  };
}

/**
 * The merchant's notice for a new actionable warning. Gated the way the
 * new-dispute notice is (sendDisputeCreatedNotice): the account's notification
 * address only, nothing while processing is paused, and once per warning at the
 * send layer (`early-fraud-warning:<row id>`). A warning no longer open is not
 * announced. Never throws.
 */
export async function sendEarlyFraudWarningNotice(
  env: Env,
  ctx: { accountId: string; warningId: string },
): Promise<DisputeNoticeOutcome> {
  try {
    const [row] = await getDb(env)
      .select({
        warning: earlyFraudWarnings,
        notificationEmail: accounts.notificationEmail,
        processingPaused: accounts.processingPaused,
        senderName: stripeConnections.senderName,
      })
      .from(earlyFraudWarnings)
      .innerJoin(accounts, eq(accounts.id, earlyFraudWarnings.accountId))
      .leftJoin(stripeConnections, eq(stripeConnections.id, earlyFraudWarnings.stripeConnectionId))
      .where(and(eq(earlyFraudWarnings.id, ctx.warningId), eq(earlyFraudWarnings.accountId, ctx.accountId)))
      .limit(1);
    if (!row || !isOpenWarning(row.warning)) return { kind: "skipped", reason: "not_found" };
    if (row.processingPaused) return { kind: "skipped", reason: "paused" };
    if (!row.notificationEmail) return { kind: "skipped", reason: "no_recipient" };
    const w = row.warning;
    const notice = {
      ...earlyFraudWarningNotice({
        amountCents: w.amountCents,
        currency: w.currency,
        customerLabel: warningCustomerLabel(w),
        fraudType: w.fraudType,
        chargeId: w.stripeChargeId,
        pageUrl: appUrl(env, EARLY_FRAUD_WARNINGS_PATH),
      }),
      footerNote: disputeNoticeFooterNote(row.senderName, new Date().getUTCFullYear()),
    };
    return await send(
      env,
      ctx.accountId,
      row.notificationEmail,
      notice,
      EARLY_FRAUD_WARNING_TEMPLATE,
      `early-fraud-warning:${w.id}`,
      null,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`early fraud warning notice failed for account ${ctx.accountId} warning ${ctx.warningId}:`, message);
    return { kind: "error", message };
  }
}

export type RefundWarningResult =
  | { status: "refunded"; refundId: string }
  | { status: "error"; reason: RefundRefusal; message: string };

function refused(reason: RefundRefusal, detail?: string): RefundWarningResult {
  return { status: "error", reason, message: detail ?? REFUND_MESSAGES[reason] };
}

/** The Stripe idempotency key for refunding one warned charge. */
function refundIdempotencyKey(stripeWarningId: string): string {
  return `early-fraud-warning-refund:${stripeWarningId}`;
}

/**
 * Refund the charge behind one warning. Never throws for an expected refusal;
 * a database failure after Stripe refunded is reported in words that say so.
 */
export async function refundEarlyFraudWarning(
  env: Env,
  input: { accountId: string; warningId: string; now: Date },
  deps: { stripe?: Stripe } = {},
): Promise<RefundWarningResult> {
  const db = getDb(env);
  const warning = await findEarlyFraudWarning(db, input.accountId, input.warningId);
  if (!warning) return refused("not_found");
  if (warning.refundedAt) return refused("already_refunded");
  if (warning.dismissedAt) return refused("dismissed");
  if (!warning.actionable) return refused("not_actionable");

  let stripe = deps.stripe;
  if (!stripe) {
    const token = warning.stripeConnectionId
      ? await getConnectionAccessToken(db, warning.stripeConnectionId)
      : null;
    if (!token) return refused("no_connection");
    stripe = getConnectedStripe(await decryptToken(env, token));
  }

  // Stripe's own word on the charge, read now: the warning row can be behind it.
  let refundId: string;
  try {
    const charge = await stripe.charges.retrieve(warning.stripeChargeId);
    if (charge.refunded) return refused("stripe_refunded");
    if (charge.disputed) return refused("stripe_disputed");
    const refund = await stripe.refunds.create(
      { charge: warning.stripeChargeId, reason: "fraudulent" },
      { idempotencyKey: refundIdempotencyKey(warning.stripeWarningId) },
    );
    refundId = refund.id;
  } catch (error) {
    if (isDefiniteRefusal(error)) {
      return refused(
        "stripe_refused",
        `Stripe did not refund the charge: ${error instanceof Error ? error.message : "Stripe refused the request"}`,
      );
    }
    console.error("early fraud warning refund at Stripe has an unknown result", error);
    return refused("unknown");
  }

  try {
    await executeMoneyWrite(env, {
      accountId: input.accountId,
      idempotencyKey: `early-fraud-warning-refunded:${warning.id}`,
      build: (b) => [
        b
          .update(earlyFraudWarnings)
          .set({ refundedAt: input.now, stripeRefundId: refundId })
          .where(
            and(
              eq(earlyFraudWarnings.id, warning.id),
              eq(earlyFraudWarnings.accountId, input.accountId),
              isNull(earlyFraudWarnings.refundedAt),
            ),
          ),
      ],
    });
  } catch (err) {
    console.error("early fraud warning refund write failed after Stripe refunded", err);
    return refused("not_recorded");
  }
  return { status: "refunded", refundId };
}

/** Dismiss one open warning: the merchant chose not to refund. Returns whether
 *  a row was open to dismiss. */
async function dismissEarlyFraudWarning(
  env: Env,
  input: { accountId: string; warningId: string; now: Date },
): Promise<boolean> {
  const warning = await findEarlyFraudWarning(getDb(env), input.accountId, input.warningId);
  if (!warning || !isOpenWarning(warning)) return false;
  await executeMoneyWrite(env, {
    accountId: input.accountId,
    idempotencyKey: `early-fraud-warning-dismissed:${warning.id}`,
    build: (b) => [
      b
        .update(earlyFraudWarnings)
        .set({ dismissedAt: input.now })
        .where(
          and(
            eq(earlyFraudWarnings.id, warning.id),
            eq(earlyFraudWarnings.accountId, input.accountId),
            isNull(earlyFraudWarnings.dismissedAt),
            isNull(earlyFraudWarnings.refundedAt),
          ),
        ),
    ],
  });
  return true;
}

/** The intents the disputes dashboard's warning section posts. */
const WARNING_INTENTS = ["refund_warning_confirm", "refund_warning", "dismiss_warning"] as const;
type WarningIntent = (typeof WARNING_INTENTS)[number];

export function isWarningIntent(intent: string): intent is WarningIntent {
  return (WARNING_INTENTS as readonly string[]).includes(intent);
}

type WarningActionData = { efwConfirm: string } | { efw: { ok: boolean; message: string } };

/**
 * The disputes dashboard's warning posts, under the signed-in account the app
 * shell resolved (the dispute Accept's guard: the record is read under that
 * account, so another account's id is "not found"). The demo never reaches
 * here: the shell refuses its every non-GET with 405.
 */
export async function runWarningAction(
  env: Env,
  accountId: string,
  intent: WarningIntent,
  warningId: string,
): Promise<{ data: WarningActionData; status: number }> {
  if (intent === "refund_warning_confirm") {
    const warning = await findEarlyFraudWarning(getDb(env), accountId, warningId);
    if (!warning) return { data: { efw: { ok: false, message: REFUND_MESSAGES.not_found } }, status: 404 };
    return { data: { efwConfirm: warning.id }, status: 200 };
  }
  if (intent === "dismiss_warning") {
    const dismissed = await dismissEarlyFraudWarning(env, { accountId, warningId, now: new Date() });
    return dismissed
      ? { data: { efw: { ok: true, message: "Warning dismissed. The charge was not refunded." } }, status: 200 }
      : { data: { efw: { ok: false, message: "That warning is no longer open." } }, status: 409 };
  }
  const result = await refundEarlyFraudWarning(env, { accountId, warningId, now: new Date() });
  if (result.status === "refunded") {
    return { data: { efw: { ok: true, message: `Refunded. Stripe refund ${result.refundId}.` } }, status: 200 };
  }
  return {
    data: { efw: { ok: false, message: result.message } },
    status: result.reason === "not_found" ? 404 : result.reason === "unknown" ? 502 : 409,
  };
}
