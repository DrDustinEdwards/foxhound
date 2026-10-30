// Revoking the anonymous audit's Stripe grant when its window ends (2026-10-29).
//
// WHY THIS EXISTS. Stripe gives the read_only Connect scope only to Extensions
// (https://docs.stripe.com/connect/oauth-changes-for-standard-platforms), so the
// audit asks for read_write like /connect does (STRIPE_AUDIT_SCOPE). A read_write
// grant left standing on a stranger's Stripe account after a free audit is more
// access than the audit needs, so Foxhound revokes it itself once the grant
// cookie's life (AUDIT_TOKEN_TTL_SECONDS) is over. Recova never revoked anything.
//
// THE DELAY IS THE AUDIT QUEUE'S OWN delaySeconds. The callback sends one
// message to AUDIT_QUEUE with the window as its delay, and the queue consumer
// hands it here. No new Cloudflare resource and no table: the message carries
// only the Stripe account id, never the token (oauth.deauthorize needs the
// platform's client id and the account id, not the merchant's token).
//
// THE SAFETY CHECK IS AT REVOKE TIME. oauth.deauthorize cuts the platform's
// WHOLE connection to that Stripe account, so if any Foxhound account holds a
// live stripe_connections row for it, by the time the message is delivered, a
// revoke would disconnect a real merchant. That case is skipped, never revoked.
// Checking at grant time instead would miss a visitor who runs the audit and
// then connects within the window.
//
// RETRY: ONE. A failed deauthorize is logged and retried once (the consumer's
// retry_delay apart); after that it is acked. Logs carry counts and outcomes,
// never a token.

import { getDb } from "~/db";
import { AUDIT_TOKEN_TTL_SECONDS } from "~/lib/constants";
import { type DeauthorizeResult, deauthorizeConnectedAccount } from "~/lib/stripe/connect";
import { findLiveAttachment } from "~/lib/stripe/connections.server";

/** Marks a revoke message on the shared AUDIT_QUEUE, beside the monthly audit's. */
const AUDIT_GRANT_REVOKE_KIND = "audit-grant-revoke";

export interface AuditGrantRevokeMessage {
  kind: typeof AUDIT_GRANT_REVOKE_KIND;
  stripeAccountId: string;
}

type Deauthorize = (env: Env, stripeUserId: string) => Promise<DeauthorizeResult>;

type AuditGrantRevokeOutcome = "revoked" | "skipped_live_connection" | "failed";

/** The message body, or null when it is not a revoke message. */
export function parseAuditGrantRevokeMessage(body: unknown): AuditGrantRevokeMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const { kind, stripeAccountId } = body as Record<string, unknown>;
  if (kind !== AUDIT_GRANT_REVOKE_KIND) return null;
  if (typeof stripeAccountId !== "string" || !stripeAccountId.startsWith("acct_")) return null;
  return { kind, stripeAccountId };
}

/** Queue the revoke for when the audit's window ends. Throws if the send fails,
 *  so the callback can refuse the run rather than leave a grant nobody revokes. */
export async function scheduleAuditGrantRevoke(env: Env, stripeAccountId: string): Promise<void> {
  await env.AUDIT_QUEUE.send(
    { kind: AUDIT_GRANT_REVOKE_KIND, stripeAccountId } satisfies AuditGrantRevokeMessage,
    { delaySeconds: AUDIT_TOKEN_TTL_SECONDS },
  );
}

/** Revoke the audit grant unless a Foxhound account holds that Stripe account
 *  live right now. Never throws for a Stripe failure; reports "failed". */
export async function revokeAuditGrant(
  env: Env,
  stripeAccountId: string,
  deauthorize: Deauthorize = deauthorizeConnectedAccount,
): Promise<AuditGrantRevokeOutcome> {
  const live = await findLiveAttachment(getDb(env), stripeAccountId, []);
  if (live.status !== "unattached") return "skipped_live_connection";
  const result = await deauthorize(env, stripeAccountId);
  return result.ok ? "revoked" : "failed";
}

/** One delivered revoke message, and what the queue should do with it. */
export async function processAuditGrantRevokeMessage(
  env: Env,
  message: AuditGrantRevokeMessage,
  attempts: number,
  deauthorize: Deauthorize = deauthorizeConnectedAccount,
): Promise<"ack" | "retry"> {
  let outcome: AuditGrantRevokeOutcome;
  try {
    outcome = await revokeAuditGrant(env, message.stripeAccountId, deauthorize);
  } catch {
    // A D1 read that threw. The error object is not logged: nothing in this
    // path holds a token, but the line stays fixed like the callback's.
    outcome = "failed";
  }
  if (outcome !== "failed") {
    console.info(`audit grant revoke: ${outcome}`);
    return "ack";
  }
  const retry = attempts <= 1;
  console.error(`audit grant revoke: failed on attempt ${attempts}${retry ? ", retrying once" : ", giving up"}`);
  return retry ? "retry" : "ack";
}
