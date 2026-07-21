import { and, eq, isNotNull } from "drizzle-orm";

import { getDb, emailSuppressions } from "~/db";

import { buildSuppressionInsert } from "./events";
import type { UnsubscribeTokenPayload } from "./unsubscribe-token";

// Suppression gate: never send to an address that has bounced or unsubscribed.
// The suppression rows are written by the bounce/complaint queue consumer and the
// unsubscribe route; this read gates every send.
export async function isSuppressed(env: Env, email: string): Promise<boolean> {
  const db = getDb(env);
  const rows = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.email, email), isNotNull(emailSuppressions.suppressedAt)))
    .limit(1);
  return rows.length > 0;
}

// Reason marker for a recipient-initiated opt-out (vs "bounce"/"complaint" from
// the Email Service events consumer). Distinct so CAN-SPAM audits can tell an
// explicit unsubscribe apart from a deliverability suppression.
export const UNSUBSCRIBE_REASON = "unsubscribe";

/**
 * Record a one-click unsubscribe (/u/:token) as a suppression row, scoped to the
 * account the token was signed for. Idempotent by construction: the single write
 * is buildSuppressionInsert's onConflictDoNothing on the email unique index, so a
 * second click (or a List-Unsubscribe POST after a GET) is a no-op, never an
 * error. Operational write, not money, so a plain insert (matches the engagement
 * + bounce-consumer precedent), never the money-write DO. The raw token is stored
 * as the traceability marker, mirroring how a bounce stores its provider event id.
 */
export async function recordUnsubscribe(
  env: Env,
  payload: UnsubscribeTokenPayload,
  token: string,
): Promise<void> {
  const db = getDb(env);
  await buildSuppressionInsert(db, {
    email: payload.email,
    token,
    reason: UNSUBSCRIBE_REASON,
    accountId: payload.accountId,
    now: new Date(),
  });
}
