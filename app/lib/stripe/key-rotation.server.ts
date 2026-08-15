import { eq, isNotNull } from "drizzle-orm";

import type { Db } from "~/db/client";
import { stripeConnections } from "~/db/schema";
import { keyIdOf, loadKeyring, reencryptToken } from "~/lib/stripe/encryption";

/** Step 4 of the rotation runbook in app/lib/stripe/encryption.ts: move every
 *  stored connection token onto the ACTIVE key, so ENCRYPTION_KEYS_OLD can be
 *  dropped.
 *
 *  WHY THIS EXISTS BEFORE IT HAS ANYTHING TO DO. Ruling 311 measured
 *  `stripe_connections` at exactly ONE row, demo_teamflow, with a NULL token, so
 *  this writer processes ZERO rows today. 312 ordered it built anyway, because
 *  the alternative is writing it under pressure during the first real rotation,
 *  against live merchant tokens, with no test. Building and testing it against
 *  zero rows is cheaper and safer than needing it and not having it.
 *
 *  NEVER LOGS A TOKEN, plaintext or ciphertext (ARCHITECTURE.md non-negotiable
 *  #5). The report carries counts, connection ids and error messages only.
 *
 *  NOT TRANSACTIONAL ACROSS ROWS, deliberately. Each connection is rewritten on
 *  its own, so a failure part way leaves earlier rows correctly re-encrypted
 *  rather than rolling back work that succeeded. Re-running is safe: a row
 *  already on the active key is skipped, which is what makes this idempotent. */
export interface RotationReport {
  /** Connections holding a non-null token. */
  scanned: number;
  /** Rewritten onto the active key this run. */
  rewritten: number;
  /** Already on the active key, so nothing to do. */
  alreadyActive: number;
  /** Connection ids that could not be re-encrypted, with the reason. No token
   *  material appears here. */
  failures: { connectionId: string; reason: string }[];
  /** The active key id at the time of the run, for the runbook's record. */
  activeKeyId: string;
}

export async function reencryptConnectionTokens(env: Env, db: Db): Promise<RotationReport> {
  // Loaded once and up front so a broken keyring fails before any row is
  // touched, rather than half way through a rewrite.
  const keyring = loadKeyring(env);

  const rows = await db
    .select({ id: stripeConnections.id, token: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(isNotNull(stripeConnections.stripeAccessToken));

  const report: RotationReport = {
    scanned: rows.length,
    rewritten: 0,
    alreadyActive: 0,
    failures: [],
    activeKeyId: keyring.activeId,
  };

  for (const row of rows) {
    const current = row.token;
    if (!current) continue;

    if (keyIdOf(current) === keyring.activeId) {
      report.alreadyActive += 1;
      continue;
    }

    try {
      const next = await reencryptToken(env, current);
      if (next === null) {
        report.alreadyActive += 1;
        continue;
      }
      await db
        .update(stripeConnections)
        .set({ stripeAccessToken: next })
        .where(eq(stripeConnections.id, row.id));
      report.rewritten += 1;
    } catch (err) {
      // The message is the failure reason, never the value that failed.
      report.failures.push({
        connectionId: row.id,
        reason: err instanceof Error ? err.message : "re-encrypt failed",
      });
    }
  }

  return report;
}
