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
}

export function buildEmailSettingsUpdate(
  db: Db,
  accountId: string,
  input: EmailSettingsInput,
) {
  // ONE column. `digest_email` was here and is gone (336 binding 3): no legacy
  // counterpart, no reader, and the audit digest sends to `notification_email`.
  // Leaving it in the set would keep a write alive for a field no form posts.
  return db
    .update(accounts)
    .set({ notificationEmail: input.notificationEmail })
    .where(eq(accounts.id, accountId));
}

/**
 * The SIX controls legacy's notifications page renders, and no others.
 *
 * It carried `winbackNotificationsEnabled` and `expiringCardNotificationsEnabled`
 * until session 56, and it had no caller. Legacy's
 * `NotificationsSection.tsx` (blob 494c6dfa, 4,573 bytes) renders FOUR toggles
 * and two text fields; the win-back and expiring-card toggles live on S34's
 * features page, which is 336's reversal against the docs' "six toggles". A
 * builder that writes columns its page never shows is 336 binding 3's defect
 * inverted, so the two were removed rather than left for a future caller to
 * pass by accident.
 */
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

/**
 * S34's TWO feature toggles, and nothing else.
 *
 * Legacy's features page (blob d130d2c8, 1,160 bytes) selects exactly
 * `winback_notifications_enabled` and `expiring_card_notifications_enabled`,
 * and its FeaturesSection (blob e7559f6b, 1,536 bytes) renders exactly two
 * toggles. **IT NEVER TOUCHES `account_products`**, which is what the S34 row
 * cell claims and what session 44's walk denied; the walk is right.
 *
 * Separate from buildNotificationSettingsUpdate on purpose: these are a
 * different page, and one builder spanning both would let either page write
 * columns it does not render.
 */
export interface FeatureSettingsInput {
  winbackNotificationsEnabled: boolean;
  expiringCardNotificationsEnabled: boolean;
}

export function buildFeatureSettingsUpdate(
  db: Db,
  accountId: string,
  input: FeatureSettingsInput,
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

// ---------------------------------------------------------------------------
// S33: the sender settings on the connection (rulings 14, 40's launch-blocker
// list, and this session's brief).
// ---------------------------------------------------------------------------

// SENDER_NAME_MAX_LENGTH lives in the client-safe sender-name.ts, because the
// form renders it as maxLength and a .server import would ship drizzle in that
// route client chunk. Re-exported so server callers have one import site.
;

export interface SenderSettingsInput {
  /** NULL when the merchant clears the box, which is legacy's behavior:
   *  `formData.get('sender_name')?.toString() || null`. Null is a real state,
   *  not a gap: the From header falls back to "Support" and delivers. */
  senderName: string | null;
  /** `reply_to_email` (J03). UNDEFINED leaves the column alone, which is
   *  legacy's `if (formData.has('reply_to_email'))`; NULL clears it. */
  replyToEmail?: string | null;
}

/**
 * Writes `sender_name`, and `reply_to_email` when the input carries it, and
 * NOTHING ELSE.
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
 * Writes the FOUR per-category voice columns and nothing else. S31.
 *
 * The allowlist is legacy's own design: `settings/update/route.ts` guards each
 * of `brand_voice_soft`, `brand_voice_expired`, `brand_voice_network` and
 * `brand_voice_fraud` with its own `formData.has(...)` and writes
 * `?.toString() || null`, so an empty selection stores NULL. Null is the real
 * state here, not a gap: `resolveBrandVoice` reads it as "same as main voice".
 *
 * The generic `brand_voice` is NOT touched. Legacy's brand-voice page does not
 * render it either; it is written from a different form.
 *
 * SECURITY, the rule buildBrandVoiceUpdate and buildSenderSettingsUpdate carry:
 * `connectionId` arrives from a client-POSTed field, so the WHERE pins
 * `account_id` and a foreign id matches zero rows.
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
