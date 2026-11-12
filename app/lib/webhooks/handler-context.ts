import type Stripe from "stripe";

import { executeMoneyWrite } from "~/lib/money/execute";
import { buildClaimOnlyBatch, type WebhookClaimInput } from "./batches";
import type { WebhookIntent } from "./events";

export type WebhookOutcome =
  | { status: "applied" }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "error"; message: string };

/** What every intent handler gets: the event, the account it resolved to, the
 *  claim row and the money-write idempotency key, all fixed per delivery. */
export interface WebhookContext {
  env: Env;
  event: Stripe.Event;
  receivedAt: Date;
  accountId: string;
  connectionId: string;
  claim: WebhookClaimInput;
  idempotencyKey: string;
}

export type IntentOf<K extends WebhookIntent["kind"]> = Extract<WebhookIntent, { kind: K }>;

/** Commit the claim alone, with no other write: the event is recorded and ignored for
 *  `reason`, or comes back a duplicate when it was already claimed. */
export async function claimOnly(ctx: WebhookContext, reason: string): Promise<WebhookOutcome> {
  const { applied } = await executeMoneyWrite(ctx.env, {
    accountId: ctx.accountId,
    idempotencyKey: ctx.idempotencyKey,
    build: (db) => buildClaimOnlyBatch(db, ctx.claim),
  });
  return applied ? { status: "ignored", reason } : { status: "duplicate" };
}
