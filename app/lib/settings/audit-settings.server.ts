import { eq } from "drizzle-orm";

import { accounts } from "~/db";
import type { Db } from "~/db";

import { readAuditSettings, type LookbackOption } from "./audit-settings";

// The account-scoped read of S30's two columns, on the server side of the line.
//
// ADDED IN PHASE (f), because the audit's live results page is the FIRST reader
// of `accounts.audit_lookback_days` outside the settings page that writes it.
// The walk recorded that column as having no reader at all; it has one now.
//
// THROUGH readAuditSettings, NOT A SECOND `?? 90`. That function is the one
// named place deciding what NULL means for these two columns, precisely so the
// page and any cron-facing read cannot disagree. A results page that inlined its
// own coalesce would be a second answer to the same question, which is 336
// binding 3's defect in its quietest form: both would be right today and only
// one of them would be changed when the default moves.
//
// A `.server.ts` because a route module must not reach the database directly, or
// the ORM ships in that route's client chunk.

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
