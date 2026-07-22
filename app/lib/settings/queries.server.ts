import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db";

// Settings read models (Phase 5 slice 5f). Added for the perf-audit ORM-leak
// fix (foxhound-audit-perf.md M-1): these were previously inline db.select()
// calls inside app/routes/app/settings/index.tsx's own loader, the identical
// anti-pattern flagged on disputes/detail.tsx, just one that had not yet
// leaked into a client chunk. Moving them here (this module is .server.ts,
// same convention as ~/lib/disputes/queries.server.ts) keeps drizzle-orm and
// the accounts/stripeConnections table objects out of any client bundle,
// structurally rather than by accident of code shape.

export type AccountRow = typeof accounts.$inferSelect;

/** The full account row, or null if the id does not resolve (should not
 *  happen for a session-derived accountId; the caller 404s defensively). */
export async function getAccount(db: Db, accountId: string): Promise<AccountRow | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return rows[0] ?? null;
}

export interface ActiveConnectionBrandVoice {
  id: string;
  brandVoice: string | null;
}

/** The account's active (non-disconnected) Stripe connection, oldest first,
 *  or null if none. Only the columns the settings page's brand-voice card
 *  needs. */
export async function getActiveConnectionBrandVoice(
  db: Db,
  accountId: string,
): Promise<ActiveConnectionBrandVoice | null> {
  const rows = await db
    .select({ id: stripeConnections.id, brandVoice: stripeConnections.brandVoice })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)))
    .orderBy(stripeConnections.connectedAt)
    .limit(1);
  return rows[0] ?? null;
}
