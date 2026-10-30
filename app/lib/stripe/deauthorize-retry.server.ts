// Revoking a disconnected Stripe grant, and retrying one that failed (Grok
// audit FH-7). Cancel, disconnect and account deletion all commit the local
// disconnect first and then call oauth.deauthorize, which never rolls the local
// state back. A failed call used to be a log line and nothing else, so a Stripe
// outage at that moment left the platform's grant on the merchant's account
// for good. Now the failure is stamped on the connection row, which keeps its
// stripe_user_id after a disconnect and after an account scrub, and the daily
// stripe-deauthorize-retry cron retries it until Stripe accepts.
//
// Plain writes, not executeMoneyWrite: this is account state on
// stripe_connections, cancelMerchant's posture (RULES.md 3.2).

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { type Db, getDb, stripeConnections } from "~/db";

import { type DeauthorizeResult, deauthorizeConnectedAccount } from "./connect";

export type Deauthorize = (env: Env, stripeUserId: string) => Promise<DeauthorizeResult>;

export interface DeauthorizeFailure {
  connectionId: string;
  stripeUserId: string;
  error: string;
  /** False when the retry stamp could not be written either, so no cron will
   *  retry this grant and it needs a manual revoke. Set on the first revoke
   *  only; the retry cron's own failures leave it absent. */
  queued?: boolean;
}

/** Attempts at the retry stamp before the failure is reported as not queued. */
const STAMP_ATTEMPTS = 2;

/** Stamp deauthorize_failed_at, true only when a row took it. A throw or a
 *  zero-row UPDATE (hard rule 3) is retried once, then reported. */
async function stampRetry(env: Env, connectionId: string, now: Date): Promise<boolean> {
  for (let attempt = 0; attempt < STAMP_ATTEMPTS; attempt++) {
    try {
      const rows = await getDb(env)
        .update(stripeConnections)
        .set({ deauthorizeFailedAt: now })
        .where(eq(stripeConnections.id, connectionId))
        .returning({ id: stripeConnections.id });
      if (rows.length > 0) return true;
      console.error(`deauthorize retry stamp matched no row for connection ${connectionId}`);
    } catch (err) {
      console.error(`could not queue the deauthorize retry for connection ${connectionId}:`, err);
    }
  }
  return false;
}

/**
 * Revoke each just-disconnected connection's grant. A failure is stamped on
 * the row for the retry cron and returned for the caller to surface; it never
 * throws and never undoes the disconnect. A stamp that cannot be written is
 * part of the returned failure (queued: false, and said in its error), since
 * then nothing will ever retry that grant.
 */
export async function revokeDisconnectedGrants(
  env: Env,
  connections: ReadonlyArray<{ id: string; stripeUserId: string }>,
  now: Date,
  deauthorize: Deauthorize = deauthorizeConnectedAccount,
): Promise<DeauthorizeFailure[]> {
  const failures: DeauthorizeFailure[] = [];
  for (const c of connections) {
    const result = await deauthorize(env, c.stripeUserId);
    if (result.ok) continue;
    const error = result.error ?? "unknown error";
    const queued = await stampRetry(env, c.id, now);
    console.error(
      `stripe deauthorize failed for connection ${c.id}, ${queued ? "queued for retry" : "NOT queued for retry"}:`,
      error,
    );
    failures.push({
      connectionId: c.id,
      stripeUserId: c.stripeUserId,
      error: queued ? error : `${error} (not queued for retry: revoke manually)`,
      queued,
    });
  }
  return failures;
}

export interface DeauthorizeRetryResult {
  revoked: number;
  /** Cleared without a call: the Stripe account is live on a Foxhound account
   *  again, and a revoke would cut that live connection. */
  superseded: number;
  failed: DeauthorizeFailure[];
}

/**
 * Retry every revoke that failed. Before each call it checks that no live
 * connection holds the same Stripe account: oauth.deauthorize cuts the
 * platform's whole connection to that account, so revoking after the merchant
 * reconnected would disconnect them from Stripe behind Foxhound's back.
 */
export async function retryFailedDeauthorizations(
  env: Env,
  db: Db,
  deauthorize: Deauthorize = deauthorizeConnectedAccount,
): Promise<DeauthorizeRetryResult> {
  const pending = await db
    .select({ id: stripeConnections.id, stripeUserId: stripeConnections.stripeUserId })
    .from(stripeConnections)
    .where(and(isNotNull(stripeConnections.deauthorizeFailedAt), isNotNull(stripeConnections.disconnectedAt)));

  const result: DeauthorizeRetryResult = { revoked: 0, superseded: 0, failed: [] };
  for (const row of pending) {
    const live = await db
      .select({ id: stripeConnections.id })
      .from(stripeConnections)
      .where(and(eq(stripeConnections.stripeUserId, row.stripeUserId), isNull(stripeConnections.disconnectedAt)))
      .limit(1);
    if (live.length > 0) {
      await clearPending(db, row.id);
      result.superseded += 1;
      continue;
    }
    const attempt = await deauthorize(env, row.stripeUserId);
    if (attempt.ok) {
      await clearPending(db, row.id);
      result.revoked += 1;
    } else {
      result.failed.push({ connectionId: row.id, stripeUserId: row.stripeUserId, error: attempt.error ?? "unknown error" });
    }
  }
  return result;
}

async function clearPending(db: Db, connectionId: string): Promise<void> {
  await db.update(stripeConnections).set({ deauthorizeFailedAt: null }).where(eq(stripeConnections.id, connectionId));
}

export function describeDeauthorizeRetry(result: DeauthorizeRetryResult): string {
  return `${result.revoked} revoked, ${result.superseded} superseded by a live reconnect, ${result.failed.length} still failing`;
}

/** The alert text when a grant is still not revoked after the retry, or null. */
export function deauthorizeRetryFailureError(result: DeauthorizeRetryResult): string | null {
  if (result.failed.length === 0) return null;
  const detail = result.failed.map((f) => `connection ${f.connectionId}: ${f.error}`).join("; ");
  return `${result.failed.length} Stripe grant(s) still not revoked after disconnect: ${detail}`;
}
