import { and, eq, isNull } from "drizzle-orm";

import { accounts, getDb, emailSuppressions } from "~/db";

import type { UnsubscribeTokenPayload } from "./unsubscribe-token";

// Suppression is read by SendGates in ./dispatch; these writers serve the bounce consumer and unsubscribe route.

// Reason for a recipient-initiated opt-out, distinct from "bounce"/"complaint" so audits can tell them apart.
export const UNSUBSCRIBE_REASON = "unsubscribe";

export type UnsubscribeOutcome = "unsubscribed" | "already";

/**
 * Record a one-click unsubscribe (/u/:token) as a suppression row for the token's account, and say
 * whether this visit suppressed the address. Plain statements, not the money-write DO. Rows migrated
 * from Recova can have suppressed_at NULL, so the write is an upsert whose update runs only on a row
 * not yet suppressed; an already-suppressed address returns "already" (a repeat click is a no-op).
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

/** "changed": the account no longer sends its digest to this address, so nothing was switched off. */
export type DigestUnsubscribeOutcome = UnsubscribeOutcome | "changed";

/**
 * Record a digest unsubscribe: switch off the weekly digest for the token's account while it still sends
 * to the token's address. No suppression row; other mail to the address is unaffected. One conditional
 * UPDATE; when it matches nothing, a read says "already" (toggle off) or "changed" (address differs).
 */
export async function recordDigestUnsubscribe(
  env: Env,
  payload: UnsubscribeTokenPayload,
): Promise<DigestUnsubscribeOutcome> {
  const db = getDb(env);
  const match = and(
    eq(accounts.id, payload.accountId),
    eq(accounts.notificationEmail, payload.email),
  );
  const switched = await db
    .update(accounts)
    .set({ digestEnabled: false })
    .where(and(match, eq(accounts.digestEnabled, true)))
    .returning({ id: accounts.id });
  if (switched.length > 0) return "unsubscribed";
  const still = await db.select({ id: accounts.id }).from(accounts).where(match).limit(1);
  return still.length > 0 ? "already" : "changed";
}
