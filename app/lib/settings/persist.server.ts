import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db";

// Settings writes are plain, non-money updates (account preferences, merchant
// context inputs), so a direct db.update is the right primitive, not the
// money-write DO (gotcha #25: DO is for writes that gate billing or are a
// webhook claim). Builders return the query unexecuted so they compile-test
// against the schema the same way the money-write batch builders do.

export interface AccountProfileInput {
  name: string;
}

export function buildAccountProfileUpdate(
  db: Db,
  accountId: string,
  input: AccountProfileInput,
) {
  return db.update(accounts).set({ name: input.name }).where(eq(accounts.id, accountId));
}

export interface EmailSettingsInput {
  notificationEmail: string | null;
  digestEmail: string | null;
}

export function buildEmailSettingsUpdate(
  db: Db,
  accountId: string,
  input: EmailSettingsInput,
) {
  return db
    .update(accounts)
    .set({
      notificationEmail: input.notificationEmail,
      digestEmail: input.digestEmail,
    })
    .where(eq(accounts.id, accountId));
}

export interface NotificationSettingsInput {
  digestEnabled: boolean;
  slackNotificationsEnabled: boolean;
  slackWebhookUrl: string | null;
  recoveryNotificationsEnabled: boolean;
  sequenceCompleteNotificationsEnabled: boolean;
  winbackNotificationsEnabled: boolean;
  expiringCardNotificationsEnabled: boolean;
}

export function buildNotificationSettingsUpdate(
  db: Db,
  accountId: string,
  input: NotificationSettingsInput,
) {
  return db.update(accounts).set(input).where(eq(accounts.id, accountId));
}

// The three optional Intelligence context fields (SCHEMA.md customer_context):
// merchant-entered inputs the scoring engine will read once it exists. They
// are writable now even though nothing consumes them yet (PRICING.md rev 3
// free acquisition sweetener is a separate, unbuilt engine, see build-notes
// Open Items); do not gate these on that engine landing.
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

// Brand voice lives on stripe_connections (one row per connected Stripe
// account), not accounts (gotcha #52-adjacent grounding: confirmed in
// schema.ts). `resolveBrandVoice` (recovery/email-generation.ts) reads this
// single generic field as `voiceDescription`; the four decline-category
// specific columns (brand_voice_soft/expired/network/fraud) have no reader
// yet and are intentionally left out of this settings surface.
//
// SECURITY (account-scoping audit CRITICAL #1): the connectionId arrives from a
// client-POSTed form field, so the WHERE MUST also pin account_id, exactly like
// loadConnection does on the read side. Without it, a merchant could overwrite
// ANOTHER merchant's brand_voice, which feeds their live dunning-email tone
// (recovery/email-generation.ts). Tenant isolation is DB-enforced here, not
// caller-dependent: a foreign connectionId matches zero rows.
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

// ---------------------------------------------------------------------------
// S33: the sender settings on the connection (rulings 14, 40's launch-blocker
// list, and this session's brief).
// ---------------------------------------------------------------------------

// SENDER_NAME_MAX_LENGTH lives in the client-safe sender-name.ts, because the
// form renders it as maxLength and a .server import would ship drizzle in that
// route client chunk. Re-exported so server callers have one import site.
export { SENDER_NAME_MAX_LENGTH } from "./sender-name";

export interface SenderSettingsInput {
  /** NULL when the merchant clears the box, which is legacy's behaviour:
   *  `formData.get('sender_name')?.toString() || null`. Null is a real state,
   *  not a gap: the From header falls back to "Support" and delivers. */
  senderName: string | null;
}

/**
 * Writes `sender_name` and NOTHING ELSE.
 *
 * THE ALLOWLIST IS THE POINT, and it is legacy's own design rather than a
 * correction of it: `settings/update/route.ts` is nineteen
 * `if (formData.has('<name>'))` guards over named account columns plus eight
 * more over named connection columns, and its comment records that the
 * unconditional version clobbered every other section's columns to null. This
 * builder names one column, so a form posting `brand_voice` or `billing_exempt`
 * alongside it writes neither.
 *
 * SECURITY, the same rule buildBrandVoiceUpdate carries: `connectionId` arrives
 * from a client-POSTed field, so the WHERE pins `account_id` too. Tenant
 * isolation is DB-enforced, not caller-dependent, and a foreign connectionId
 * matches zero rows rather than overwriting another merchant's From header.
 */
export function buildSenderSettingsUpdate(
  db: Db,
  accountId: string,
  connectionId: string,
  input: SenderSettingsInput,
) {
  return db
    .update(stripeConnections)
    .set({ senderName: input.senderName })
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)));
}
