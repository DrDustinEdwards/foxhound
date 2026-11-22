import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db";
import {
  activeConnectionWhere,
  activePrimaryConnectionWhere,
} from "~/lib/stripe/connections.server";

// Settings read models.

export type AccountRow = typeof accounts.$inferSelect;

/** The full account row, or null if the id does not resolve (should not
 *  happen for a session-derived accountId; the caller 404s defensively). */
export async function getAccount(db: Db, accountId: string): Promise<AccountRow | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
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
 * Every Stripe connection on the account, live and disconnected, oldest first. They are selected
 * here anyway so the route can tell "this account never connected" from "this account disconnected
 * everything", which drives two different empty states.
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

/** Each connection's stored Stripe account health (account.updated), by id,
 *  for the warning on /settings/stripe. Kept apart from listAccountConnections,
 *  whose shape the MCP tools return. */
export async function listConnectionHealth(db: Db, accountId: string) {
  return db
    .select({
      id: stripeConnections.id,
      chargesEnabled: stripeConnections.chargesEnabled,
      payoutsEnabled: stripeConnections.payoutsEnabled,
      disabledReason: stripeConnections.disabledReason,
      pastDueCount: stripeConnections.pastDueCount,
      currentDeadline: stripeConnections.currentDeadline,
    })
    .from(stripeConnections)
    .where(activeConnectionWhere(accountId));
}

export interface SenderSettingsConnection {
  id: string;
  senderName: string | null;
  /** `reply_to_email`, the Reply-To on customer mail. */
  replyToEmail: string | null;
}

/** The account's PRIMARY live connection and its sender name, or null. */
export async function getPrimarySenderConnection(
  db: Db,
  accountId: string,
): Promise<SenderSettingsConnection | null> {
  const rows = await db
    .select({
      id: stripeConnections.id,
      senderName: stripeConnections.senderName,
      replyToEmail: stripeConnections.replyToEmail,
    })
    .from(stripeConnections)
    .where(activePrimaryConnectionWhere(accountId))
    .limit(1);
  return rows[0] ?? null;
}

export interface MerchantContext {
  merchantIndustry: string | null;
  primaryCustomerType: string | null;
  merchantMrrSelfReportedCents: number | null;
}

/**
 * The three merchant-context fields, and ONLY those three. A NARROW READER RATHER THAN
 * `getAccount`, deliberately.
 */
export async function getMerchantContext(
  db: Db,
  accountId: string,
): Promise<MerchantContext | null> {
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
  /** `brand_voice_samples` as stored; read with readVoiceSamples. */
  samples: string | null;
}

/** The account's PRIMARY live connection and its four per-category voices, or null. S31. */
export async function getPrimaryBrandVoices(
  db: Db,
  accountId: string,
): Promise<PrimaryBrandVoices | null> {
  const rows = await db
    .select({
      id: stripeConnections.id,
      general: stripeConnections.brandVoice,
      soft: stripeConnections.brandVoiceSoft,
      expired: stripeConnections.brandVoiceExpired,
      network: stripeConnections.brandVoiceNetwork,
      fraud: stripeConnections.brandVoiceFraud,
      samples: stripeConnections.brandVoiceSamples,
    })
    .from(stripeConnections)
    .where(activePrimaryConnectionWhere(accountId))
    .limit(1);
  return rows[0] ?? null;
}
