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

/** What a followed unsubscribe link did: Recova's two success states (row F7). */
export type UnsubscribeOutcome = "unsubscribed" | "already";

/**
 * Record a one-click unsubscribe (/u/:token) as a suppression row, scoped to the
 * account the token was signed for, and say whether this visit is the one that
 * suppressed the address. Operational write, not money, so plain statements
 * (matches the engagement + bounce-consumer precedent), never the money-write DO.
 * The raw token is stored as the traceability marker, mirroring how a bounce
 * stores its provider event id.
 *
 * Suppression is one row per address (the email unique index), and every
 * Foxhound writer of that table sets suppressed_at (buildSuppressionInsert), so
 * a row for the address means it is suppressed. The insert's RETURNING says
 * which visit this is: a row back means this visit suppressed the address; none
 * means an earlier unsubscribe, a bounce or a complaint already had, which is
 * "already" unsubscribed, as Recova reads any suppressed_at. A second click, or
 * a List-Unsubscribe POST after a GET, is a no-op, never an error.
 */
export async function recordUnsubscribe(
  env: Env,
  payload: UnsubscribeTokenPayload,
  token: string,
): Promise<UnsubscribeOutcome> {
  const db = getDb(env);
  const inserted = await buildSuppressionInsert(db, {
    email: payload.email,
    token,
    reason: UNSUBSCRIBE_REASON,
    accountId: payload.accountId,
    now: new Date(),
  }).returning({ id: emailSuppressions.id });
  return inserted.length > 0 ? "unsubscribed" : "already";
}
