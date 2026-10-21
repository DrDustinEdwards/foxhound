import type Stripe from "stripe";

import type { WebhookClaimInput } from "./batches";
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
