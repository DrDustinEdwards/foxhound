import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db";

// Settings writes are plain, non-money updates (account preferences, merchant context inputs), so a
// direct db.update is the right primitive, not the money-write DO (gotcha #25: DO is for writes
// that gate billing or are a webhook claim). Builders return the query unexecuted so they
// compile-test against the schema the same way the money-write batch builders do.

export interface AccountProfileInput {
  name: string;
}

export function buildAccountProfileUpdate(db: Db, accountId: string, input: AccountProfileInput) {
  return db.update(accounts).set({ name: input.name }).where(eq(accounts.id, accountId));
}

export interface NotificationSettingsInput {
  notificationEmail: string | null;
  slackWebhookUrl: string | null;
  slackNotificationsEnabled: boolean;
  digestEnabled: boolean;
  recoveryNotificationsEnabled: boolean;
  sequenceCompleteNotificationsEnabled: boolean;
}

export function buildNotificationSettingsUpdate(
  db: Db,
  accountId: string,
  input: NotificationSettingsInput,
) {
  return db.update(accounts).set(input).where(eq(accounts.id, accountId));
}

export interface FeatureSettingsInput {
  winbackNotificationsEnabled: boolean;
  expiringCardNotificationsEnabled: boolean;
  liveSendsEnabled?: boolean;
}

export function buildFeatureSettingsUpdate(db: Db, accountId: string, input: FeatureSettingsInput) {
  return db
    .update(accounts)
    .set({
      winbackNotificationsEnabled: input.winbackNotificationsEnabled,
      expiringCardNotificationsEnabled: input.expiringCardNotificationsEnabled,
      ...(input.liveSendsEnabled === undefined ? {} : { liveSendsEnabled: input.liveSendsEnabled }),
    })
    .where(eq(accounts.id, accountId));
}

export interface IntelligenceContextInput {
  merchantIndustry: string | null;
  primaryCustomerType: string | null;
  merchantMrrSelfReportedCents: number | null;
}

export function buildIntelligenceContextUpdate(
  db: Db,
  accountId: string,
  input: IntelligenceContextInput,
) {
  return db
    .update(accounts)
    .set({
      merchantIndustry: input.merchantIndustry,
      primaryCustomerType: input.primaryCustomerType,
      merchantMrrSelfReported: input.merchantMrrSelfReportedCents,
    })
    .where(eq(accounts.id, accountId));
}

// Brand voice lives on stripe_connections (one row per connected Stripe account), not accounts
// (gotcha #52-adjacent grounding: confirmed in schema.ts). SECURITY (account-scoping audit CRITICAL
// #1): the connectionId arrives from a client-POSTed form field, so the WHERE MUST also pin
// account_id, exactly like loadConnection does on the read side. Tenant isolation is DB-enforced
// here, not caller-dependent: a foreign connectionId matches zero rows.
export function buildBrandVoiceUpdate(
  db: Db,
  accountId: string,
  connectionId: string,
  brandVoice: string | null,
) {
  return db
    .update(stripeConnections)
    .set({ brandVoice })
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)));
}

/** Writes `brand_voice_samples` (the stored JSON, or NULL) and nothing else,
 *  with the same account pin as buildBrandVoiceUpdate. */
export function buildVoiceSamplesUpdate(
  db: Db,
  accountId: string,
  connectionId: string,
  brandVoiceSamples: string | null,
) {
  return db
    .update(stripeConnections)
    .set({ brandVoiceSamples })
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)));
}

// The sender settings on the connection.

// SENDER_NAME_MAX_LENGTH lives in the client-safe sender-name.ts, because the
// form renders it as maxLength and a .server import would ship drizzle in that
// route client chunk. Re-exported so server callers have one import site.

export interface SenderSettingsInput {
  /** Null is a real state, not a gap: the From header falls back to the account's name and delivers. */
  senderName: string | null;
  /** `reply_to_email`. */
  replyToEmail?: string | null;
}

/**
 * Writes `sender_name`, and `reply_to_email` when the input carries it, and NOTHING ELSE. SECURITY,
 * the same rule buildBrandVoiceUpdate carries: `connectionId` arrives from a client-POSTed field,
 * so the WHERE pins `account_id` too. Tenant isolation is DB-enforced, not caller-dependent, and a
 * foreign connectionId matches zero rows rather than overwriting another merchant's From header.
 */
export function buildSenderSettingsUpdate(
  db: Db,
  accountId: string,
  connectionId: string,
  input: SenderSettingsInput,
) {
  return db
    .update(stripeConnections)
    .set(
      input.replyToEmail === undefined
        ? { senderName: input.senderName }
        : { senderName: input.senderName, replyToEmail: input.replyToEmail },
    )
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)));
}

export interface CategoryVoicesInput {
  soft: string | null;
  expired: string | null;
  network: string | null;
  fraud: string | null;
}

/**
 * Writes the FOUR per-category voice columns and nothing else. The generic `brand_voice` is
 * NOT touched. SECURITY, the rule buildBrandVoiceUpdate and buildSenderSettingsUpdate carry:
 * `connectionId` arrives from a client-POSTed field, so the WHERE pins `account_id` and a foreign
 * id matches zero rows.
 */
export function buildCategoryVoicesUpdate(
  db: Db,
  accountId: string,
  connectionId: string,
  input: CategoryVoicesInput,
) {
  return db
    .update(stripeConnections)
    .set({
      brandVoiceSoft: input.soft,
      brandVoiceExpired: input.expired,
      brandVoiceNetwork: input.network,
      brandVoiceFraud: input.fraud,
    })
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)));
}
