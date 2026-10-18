import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { accounts, getDb, emailSuppressions } from "~/db";

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
 * Suppression is one row per address (the email unique index). Foxhound's own
 * writers always set suppressed_at, but rows migrated from Recova can carry it
 * NULL, because Recova registered a token row per send. So the write is an
 * upsert whose update runs only on a row that is not yet suppressed:
 *  - no row: inserted, and this visit unsubscribed;
 *  - a row with suppressed_at NULL: suppressed now with reason=unsubscribe and
 *    this link's token and account, so the row records the opt-out that caused
 *    it (Recova's own update branch), and this visit unsubscribed;
 *  - a suppressed row (an earlier unsubscribe, a bounce, a complaint): the
 *    setWhere refuses the update, nothing comes back, and the address is
 *    "already" unsubscribed, as Recova reads any suppressed_at. A second click,
 *    or a List-Unsubscribe POST after a GET, is a no-op, never an error.
 */
export async function recordUnsubscribe(
  env: Env,
  payload: UnsubscribeTokenPayload,
  token: string,
): Promise<UnsubscribeOutcome> {
  const db = getDb(env);
  const now = new Date();
  const written = await db
    .insert(emailSuppressions)
    .values({
      email: payload.email,
      token,
      reason: UNSUBSCRIBE_REASON,
      accountId: payload.accountId,
      suppressedAt: now,
    })
    .onConflictDoUpdate({
      target: emailSuppressions.email,
      set: { suppressedAt: now, reason: UNSUBSCRIBE_REASON, token, accountId: payload.accountId },
      setWhere: isNull(emailSuppressions.suppressedAt),
    })
    .returning({ id: emailSuppressions.id });
  return written.length > 0 ? "unsubscribed" : "already";
}

/** What a followed digest unsubscribe link did. "changed": the account no
 *  longer sends its digest to this address, so nothing was switched off and
 *  the visit is not reported as a success (RULES.md 3.9). */
export type DigestUnsubscribeOutcome = UnsubscribeOutcome | "changed";

/**
 * Record a digest unsubscribe (E23, review round 1 of PR 158): switch off the
 * weekly digest for the account the token was signed for, while that account
 * still sends its digest to the token's address. No suppression row is
 * written: the digest's link leaves the digest, as a Recova merchant sees it,
 * and every other mail to the address, and every other account sharing it,
 * carries on (RULES.md 3.16, 1.6).
 *
 * One conditional UPDATE does the switch, its guard joined to the write (3.9):
 * it matches only a row whose id, address and toggle (on) all agree. When it
 * matches nothing, a read says which of the two reasons applies: the toggle was
 * already off (or NULL, which reads as off) for this address, "already"; or the
 * account's address is no longer this one, "changed".
 */
export async function recordDigestUnsubscribe(
  env: Env,
  payload: UnsubscribeTokenPayload,
): Promise<DigestUnsubscribeOutcome> {
  const db = getDb(env);
  const match = and(eq(accounts.id, payload.accountId), eq(accounts.notificationEmail, payload.email));
  const switched = await db
    .update(accounts)
    .set({ digestEnabled: false })
    .where(and(match, eq(accounts.digestEnabled, true)))
    .returning({ id: accounts.id });
  if (switched.length > 0) return "unsubscribed";
  const still = await db.select({ id: accounts.id }).from(accounts).where(match).limit(1);
  return still.length > 0 ? "already" : "changed";
}
