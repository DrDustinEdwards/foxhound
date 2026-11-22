import { eq } from "drizzle-orm";

import { accounts } from "~/db";
import type { Db } from "~/db";

import { readAuditSettings, type LookbackOption } from "./audit-settings";

// The account-scoped read of S30's two columns, on the server side of the line. THROUGH
// readAuditSettings, NOT A SECOND `?? 90`. A `.server.ts` because a route module must not reach the
// database directly, or the ORM ships in that route's client chunk.

/** S30's settings for one account, with NULL resolved the one agreed way. */
export async function readAccountAuditSettings(
  db: Db,
  accountId: string,
): Promise<{ lookbackDays: LookbackOption; autoRun: boolean }> {
  const [row] = await db
    .select({
      auditLookbackDays: accounts.auditLookbackDays,
      auditAutoRun: accounts.auditAutoRun,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  return readAuditSettings(row ?? { auditLookbackDays: null, auditAutoRun: null });
}
