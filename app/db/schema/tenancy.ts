import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { bool, id, json, ts } from "./columns";

export const accounts = sqliteTable("accounts", {
  id: id(),
  name: text("name"),
  notificationEmail: text("notification_email"),
  slackWebhookUrl: text("slack_webhook_url"),
  digestEnabled: bool("digest_enabled"),
  recoveryNotificationsEnabled: bool("recovery_notifications_enabled"),
  sequenceCompleteNotificationsEnabled: bool("sequence_complete_notifications_enabled"),
  winbackNotificationsEnabled: bool("winback_notifications_enabled"),
  expiringCardNotificationsEnabled: bool("expiring_card_notifications_enabled"),
  onboardingCompleted: bool("onboarding_completed"),
  createdAt: ts("created_at"),
  mrrEstimateCents: integer("mrr_estimate_cents"),
  // merchant home currency for mrr_estimate_cents / merchant_mrr_self_reported
  currency: text("currency"),
  merchantIndustry: text("merchant_industry"),
  primaryCustomerType: text("primary_customer_type"),
  merchantMrrSelfReported: integer("merchant_mrr_self_reported"),
  slackNotificationsEnabled: bool("slack_notifications_enabled"),
  digestEmail: text("digest_email"),
  lastVisitedPath: text("last_visited_path"),
  lastVisitedProduct: text("last_visited_product"),
  billingExempt: bool("billing_exempt").notNull().default(false),
  /** THE LIVE-SEND FLAG: per-account, DEFAULTING OFF, checked in processEmailJob immediately before sendJobEmail. It is the explicit send kill switch: otherwise what stops mail leaving is an unset PHYSICAL_ADDRESS secret, which throws a CAN-SPAM compliance error inside buildEmailMessage, a compliance guard doing duty as a switch and a single populated env var away from every eligible account mailing at once. */
  liveSendsEnabled: bool("live_sends_enabled").notNull().default(false),
  processingPaused: bool("processing_paused").notNull().default(false),
  // WHY this account is paused, so the global emergency brake can be released safely. 'brake' means the global brake paused it; null means a human paused it individually, or it is not paused at all. Engage and release are deliberately ASYMMETRIC: engage skips accounts already paused, so the brake never takes ownership of a merchant an operator paused on purpose, and release unpauses ONLY rows carrying this marker, so lifting the brake cannot silently resume a merchant who was paused for their own reason.
  pauseReason: text("pause_reason"),
  // Operator-initiated cancel/disconnect. Distinct from processingPaused on purpose: this is a PROCESSING gate only (recovery-tick, intelligence-sync), never a billing gate. Already-matured, unbilled recoveries/disputes must still bill after cancel unless the account is ALSO billing_exempt (PRICING.md: cancel never silently forgives owed fees). accountBillingEligibleCondition in app/db/billable.ts deliberately does not reference this column.
  cancelledAt: ts("cancelled_at"),
  // When the owner deleted their account. The row survives, emptied of personal data, because billing joins it and its fee evidence hangs from its id; this stamp says why it is empty. Written only by app/lib/auth/delete-account.server.ts. Like cancelledAt it is NOT a billing gate: fees already earned stay owed.
  deletedAt: ts("deleted_at"),
  // Foxhound's OWN Stripe account customer id for this merchant (PRICING.md rev 3: direct platform invoicing, not Connect application fees). Null until billing-setup runs; createPlatformInvoice refuses to charge without it.
  platformStripeCustomerId: text("platform_stripe_customer_id"),
  disputeProductDescription: text("dispute_product_description"),
  disputeShipsPhysical: bool("dispute_ships_physical"),
  // Auto-submit disputes (/settings/disputes). NULL reads as off. The disputes cron submits an unsubmitted dispute 24 hours before its deadline only while this is on, and writes the dispute's approval from the standing opt-in below.
  disputeAutoSubmit: bool("dispute_auto_submit"),
  // Who turned auto-submit on, and when: the merchant's standing approval that
  // an automatic submission's dispute_approvals row records. Written with the
  // toggle (applyDisputeSettings), cleared when it is turned off.
  disputeAutoSubmitByUserId: text("dispute_auto_submit_by_user_id"),
  disputeAutoSubmitByEmail: text("dispute_auto_submit_by_email"),
  disputeAutoSubmitAt: ts("dispute_auto_submit_at"),
  // The Disputes on/off switch on /settings/disputes. On by default; while off, dispute intake (webhook and manual import) creates no dispute.
  disputesEnabled: bool("disputes_enabled").notNull().default(true),
  auditLookbackDays: integer("audit_lookback_days"),
  auditAutoRun: bool("audit_auto_run"),
  theme: text("theme").notNull().default("dark"),
});

/** The tenant column every account-scoped table carries (hard rule 8): the owning
 *  account, required. */
export const accountRef = () =>
  text("account_id")
    .notNull()
    .references(() => accounts.id);
/** The same column on a table whose row may belong to no account. */
export const optionalAccountRef = () => text("account_id").references(() => accounts.id);

export const accountMembers = sqliteTable(
  "account_members",
  {
    id: id(),
    accountId: accountRef(),
    // soft ref to Better Auth user.id; no enforced FK
    userId: text("user_id"),
    role: text("role").notNull(),
    invitedEmail: text("invited_email"),
    status: text("status").notNull(),
    // SHA-256 of the invite link's token (app/lib/auth/invites.ts).
    inviteToken: text("invite_token"),
    inviteExpiresAt: ts("invite_expires_at"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("account_members_account_idx").on(t.accountId),
    uniqueIndex("account_members_invite_token_uq").on(t.inviteToken),
    // Every signed-in request resolves its memberships by user. The partial unique index below cannot serve it: its status = 'active' filter does not match a bound parameter.
    index("account_members_user_idx").on(t.userId),
    // A user joins a given account AT MOST ONCE, and may join MANY accounts (a unique on (user_id, account_id), not on user_id alone, which would cap every user at one active membership). The application's accept-invite path enforces the same pair; the index moves it down to where a race cannot get past it. Pending invite rows carry a null user_id and status 'pending' and are excluded twice over. The read-checks in acceptInvite and createAccountForUser stay as fast paths; this is the backstop against a concurrent double-accept of the SAME account's invite.
    uniqueIndex("account_members_user_account_active_uq")
      .on(t.userId, t.accountId)
      .where(sql`${t.status} = 'active'`),
  ],
);

// The one first account a user creates at /connect, written in the same money batch as that account. Its unique user_id is the database's half of the `connect:first:<user>` idempotency key: if the Durable Object dies after D1 commits but before it records the key, the retry's batch is refused here and reports the account that already exists rather than minting a second.
export const accountFirstCreations = sqliteTable(
  "account_first_creations",
  {
    id: id(),
    userId: text("user_id").notNull(),
    accountId: accountRef(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("account_first_creations_user_uq").on(t.userId),
    index("account_first_creations_account_idx").on(t.accountId),
  ],
);

export const stripeConnections = sqliteTable(
  "stripe_connections",
  {
    id: id(),
    accountId: accountRef(),
    stripeUserId: text("stripe_user_id").notNull(),
    // encrypted at rest by app code; never logged
    stripeAccessToken: text("stripe_access_token"),
    stripePublishableKey: text("stripe_publishable_key"),
    stripeScope: text("stripe_scope"),
    name: text("name"),
    isPrimary: bool("is_primary").notNull().default(false),
    connectedAt: ts("connected_at"),
    disconnectedAt: ts("disconnected_at"),
    // Set when the Stripe oauth.deauthorize after a disconnect failed; the daily stripe-deauthorize-retry cron retries it and clears it.
    deauthorizeFailedAt: ts("deauthorize_failed_at"),
    lastWebhookAt: ts("last_webhook_at"),
    webhookEndpointId: text("webhook_endpoint_id"),
    createdAt: ts("created_at").notNull(),
    senderName: text("sender_name"),
    senderDomain: text("sender_domain"),
    replyToEmail: text("reply_to_email"),
    brandVoice: text("brand_voice"),
    brandVoiceSoft: text("brand_voice_soft"),
    brandVoiceExpired: text("brand_voice_expired"),
    brandVoiceNetwork: text("brand_voice_network"),
    brandVoiceFraud: text("brand_voice_fraud"),
    // The merchant's own past emails, a JSON array of up to five strings
    // (app/lib/recovery/voice-samples.ts). NULL when there are none.
    brandVoiceSamples: text("brand_voice_samples"),
    // The connected Stripe account's own health, from its latest account.updated event (app/lib/stripe/account-health.ts). All NULL until the first one arrives, and NULL reads as healthy: Foxhound never guesses a problem it was not told about. health_updated_at is the EVENT's created time, so an older event delivered late never overwrites a newer state.
    chargesEnabled: bool("charges_enabled"),
    payoutsEnabled: bool("payouts_enabled"),
    disabledReason: text("disabled_reason"),
    pastDueCount: integer("past_due_count"),
    currentDeadline: ts("current_deadline"),
    healthUpdatedAt: ts("health_updated_at"),
  },
  (t) => [
    index("stripe_connections_account_idx").on(t.accountId),
    // ONE LIVE FOXHOUND ACCOUNT PER STRIPE ACCOUNT. Money routing depends on this: `resolveConnection` maps an incoming connected webhook to an account by `stripe_user_id` alone, so every failed payment, recovered payment, outcome and billing line item for a Stripe account follows whichever row that lookup returns. That is sound only if the live mapping is one-to-one; otherwise two users holding Stripe access to one account could attach it to two Foxhound accounts and the webhook layer would honor the wrong one forever.
    // SCOPED TO LIVE ROWS: disconnect stamps `disconnected_at` and leaves the row, so a uniqueness rule over the whole table would make the first disconnect a permanent ban on connecting that Stripe account again. Under this WHERE clause a disconnected row is invisible to the constraint and reconnect stays legal.
    uniqueIndex("stripe_connections_live_stripe_account_uq")
      .on(t.stripeUserId)
      .where(sql`${t.disconnectedAt} is null`),
  ],
);

export const accountSubscriptions = sqliteTable(
  "account_subscriptions",
  {
    id: id(),
    accountId: accountRef(),
    product: text("product").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    status: text("status").notNull(),
    billingInterval: text("billing_interval"),
    currentPeriodEndsAt: ts("current_period_ends_at"),
    trialEndsAt: ts("trial_ends_at"),
    createdAt: ts("created_at").notNull(),
    canceledAt: ts("canceled_at"),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    cancellationReason: text("cancellation_reason"),
    cancellationFeedback: text("cancellation_feedback"),
    // admin_granted rows never touch Stripe APIs (PRICING.md / SCHEMA.md)
    adminGranted: bool("admin_granted").notNull().default(false),
  },
  (t) => [index("account_subscriptions_account_idx").on(t.accountId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    accountId: optionalAccountRef(),
    keyHash: text("key_hash").notNull(),
    label: text("label"),
    scope: text("scope").notNull(),
    /** The merchant MCP scopes this key holds: merchant.read, and merchant.write when the owner allowed changes. Null reads as merchant.read (keyScopes in app/lib/oauth/metadata.ts). */
    scopes: json<string[]>("scopes"),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    /** Null for a key made in Settings, which lives until revoked. Set on the one-hour access token an OAuth grant issues; verifyMcpToken refuses the key once it has passed. */
    expiresAt: ts("expires_at"),
  },
  (t) => [
    index("api_keys_account_idx").on(t.accountId),
    // Every bearer-token request looks its key up by hash (auth/mcp-tokens.ts), and a hash must name one key, so the lookup can never pick between two.
    uniqueIndex("api_keys_key_hash_uq").on(t.keyHash),
  ],
);
