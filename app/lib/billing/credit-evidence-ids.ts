import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";

import { getDb, recoveredPayments } from "~/db";

/**
 * Every live recovery under one failed payment that carries `stamp`. The
 * dispute stamp is per failed payment; the fee lines hang off the recoveries
 * under it.
 */
async function stampedRecoveryIdsFor(
  env: Env,
  failedPaymentId: string,
  stamp: typeof recoveredPayments.disputedAt,
): Promise<string[]> {
  const rows = await getDb(env)
    .select({ id: recoveredPayments.id })
    .from(recoveredPayments)
    .where(
      and(
        eq(recoveredPayments.failedPaymentId, failedPaymentId),
        isNotNull(stamp),
        isNull(recoveredPayments.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Every recovery stamped disputed for one failed payment. */
export const disputedRecoveryIdsFor = (env: Env, failedPaymentId: string) =>
  stampedRecoveryIdsFor(env, failedPaymentId, recoveredPayments.disputedAt);

/**
 * Every live recovery under one failed payment with any refund, full or
 * partial.
 */
export async function refundedRecoveryIdsFor(env: Env, failedPaymentId: string): Promise<string[]> {
  const rows = await getDb(env)
    .select({ id: recoveredPayments.id })
    .from(recoveredPayments)
    .where(
      and(
        eq(recoveredPayments.failedPaymentId, failedPaymentId),
        or(isNotNull(recoveredPayments.refundedAt), gt(recoveredPayments.refundedCents, 0)),
        isNull(recoveredPayments.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}
