import { and, eq, isNotNull, isNull } from "drizzle-orm";

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
 * Suppression is one row per address (the email unique index), so:
 *  - no row yet: buildSuppressionInsert lands one and this visit unsubscribed;
 *  - a row with no suppressed_at: it is suppressed now, with reason=unsubscribe,
 *    which is Recova's own update branch. Without this second statement the
 *    insert's onConflictDoNothing would leave the address mailable while the
 *    page told the recipient it was done;
 *  - a suppressed row (an earlier unsubscribe, a bounce, a complaint): nothing is
 *    written and the address is "already" unsubscribed, as Recova reads any
 *    suppressed_at. A second click, or a List-Unsubscribe POST after a GET, is a
 *    no-op, never an error.
 */
export async function recordUnsubscribe(
  env: Env,
  payload: UnsubscribeTokenPayload,
  token: string,
): Promise<UnsubscribeOutcome> {
  const db = getDb(env);
  const now = new Date();
  const inserted = await buildSuppressionInsert(db, {
    email: payload.email,
    token,
    reason: UNSUBSCRIBE_REASON,
    accountId: payload.accountId,
    now,
  }).returning({ id: emailSuppressions.id });
  if (inserted.length > 0) return "unsubscribed";

  const suppressedNow = await db
    .update(emailSuppressions)
    .set({ suppressedAt: now, reason: UNSUBSCRIBE_REASON })
    .where(and(eq(emailSuppressions.email, payload.email), isNull(emailSuppressions.suppressedAt)))
    .returning({ id: emailSuppressions.id });
  return suppressedNow.length > 0 ? "unsubscribed" : "already";
}
