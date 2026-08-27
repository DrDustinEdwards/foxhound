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

export interface SettingsConnection {
  id: string;
  name: string | null;
  stripeUserId: string;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
}

/**
 * Every Stripe connection on the account, live and disconnected, oldest first.
 *
 * S37 renders the LIVE ones as legacy's StripeSection does (blob `4068961e`) and
 * keeps the disconnected ones out of the list, matching legacy, whose loader
 * passes only what its own query returned. They are selected here anyway so the
 * route can tell "this account never connected" from "this account disconnected
 * everything", which drives two different empty states.
 *
 * Ordered by `connected_at` so the list is stable across requests. Legacy's
 * component imposes no order at all and renders whatever its loader hands it,
 * which is the same nondeterminism class 326 corrected on the membership list.
 */
export async function listAccountConnections(
  db: Db,
  accountId: string,
): Promise<SettingsConnection[]> {
  return db
    .select({
      id: stripeConnections.id,
      name: stripeConnections.name,
      stripeUserId: stripeConnections.stripeUserId,
      connectedAt: stripeConnections.connectedAt,
      disconnectedAt: stripeConnections.disconnectedAt,
    })
    .from(stripeConnections)
    .where(eq(stripeConnections.accountId, accountId))
    .orderBy(stripeConnections.connectedAt, stripeConnections.id);
}

export interface SenderSettingsConnection {
  id: string;
  senderName: string | null;
}

/**
 * The account's PRIMARY live connection and its sender name, or null.
 *
 * Legacy reads the primary connection for this section (`getPrimaryConnection`
 * in `settings-data.ts`, consumed by `settings/email/page.tsx`), so the sender
 * settings are per-connection values surfaced for ONE connection. That is a
 * genuine ambiguity once a login holds several accounts, and this walk records
 * it rather than resolving it.
 *
 * `is_primary = true AND disconnected_at IS NULL` is reader 2's exact pattern
 * (`getConnectionSummary`), and it matters here for the reason 333 gave: S37
 * leaves `is_primary` SET on a disconnected row, so a reader without the null
 * check would hand the settings form a severed connection to write to.
 */
export async function getPrimarySenderConnection(
  db: Db,
  accountId: string,
): Promise<SenderSettingsConnection | null> {
  const rows = await db
    .select({ id: stripeConnections.id, senderName: stripeConnections.senderName })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.accountId, accountId),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface MerchantContext {
  merchantIndustry: string | null;
  primaryCustomerType: string | null;
  merchantMrrSelfReportedCents: number | null;
}

/**
 * The three merchant-context fields, and ONLY those three.
 *
 * A NARROW READER RATHER THAN `getAccount`, deliberately. The account row
 * carries the Stripe customer id, the billing state and every other column on
 * `accounts`, and the caller that needed this reader is an MCP tool: reusing the
 * wide reader would have handed a third-party agent the whole row to expose
 * three fields of it. The route has `getAccount` and is welcome to it.
 *
 * The shape is `IntelligenceContextState`'s field for field, so the reader and
 * `applyIntelligenceContext` agree by construction and an agent reads back
 * exactly the three values it can write (375: a writer an agent cannot read
 * first forces the echo workaround).
 *
 * The account comes from the caller's credential, so there is no foreign-id case
 * to refuse here, which is the same reason the writer has none.
 */
export async function getMerchantContext(db: Db, accountId: string): Promise<MerchantContext | null> {
  const rows = await db
    .select({
      merchantIndustry: accounts.merchantIndustry,
      primaryCustomerType: accounts.primaryCustomerType,
      merchantMrrSelfReportedCents: accounts.merchantMrrSelfReported,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}

export interface PrimaryBrandVoices {
  id: string;
  /** The general `brand_voice`, the third rung of resolveBrandVoice. */
  general: string | null;
  soft: string | null;
  expired: string | null;
  network: string | null;
  fraud: string | null;
}

/**
 * The account's PRIMARY live connection and its four per-category voices, or
 * null. S31.
 *
 * Legacy reads the primary connection for this page too
 * (`settings/brand-voice/page.tsx`, blob `81435702`), so these are
 * per-connection values surfaced for one connection, the same ambiguity S33's
 * reader records for a login holding several accounts.
 *
 * `is_primary = true AND disconnected_at IS NULL` for the reason 333 gave: S37
 * leaves `is_primary` SET on a disconnected row, so a reader without the null
 * check would hand the form a severed connection to write to.
 */
export async function getPrimaryBrandVoices(
  db: Db,
  accountId: string,
): Promise<PrimaryBrandVoices | null> {
  const rows = await db
    .select({
      id: stripeConnections.id,
      // The GENERAL voice, added session 59 when the brand-voice page took over
      // the field the /settings index used to carry. Legacy's own form writes
      // both from one submit.
      general: stripeConnections.brandVoice,
      soft: stripeConnections.brandVoiceSoft,
      expired: stripeConnections.brandVoiceExpired,
      network: stripeConnections.brandVoiceNetwork,
      fraud: stripeConnections.brandVoiceFraud,
    })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.accountId, accountId),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
