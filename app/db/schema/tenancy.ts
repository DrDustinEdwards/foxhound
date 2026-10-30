import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool } from "./columns";

// ============================================================================
// Tenancy and identity (business-owned; Better Auth owns user/session/etc.)
// ============================================================================

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
  /**
   * THE LIVE-SEND FLAG, ratified 2026-08-09 in commit 9766ff5 and scheduled onto
   * S7 Phase 2 Session D by ruling 268. Per-account, DEFAULTING OFF, checked in
   * processEmailJob immediately before sendEmail.
   *
   * It exists because nothing in this codebase ever CHOSE to be a send kill
   * switch. What actually stopped mail leaving was an UNSET PHYSICAL_ADDRESS
   * secret, which throws a CAN-SPAM compliance error inside buildEmailMessage: a
   * compliance guard doing duty as a switch nobody selected, undocumented as one,
   * and a single populated env var away from every eligible account mailing at
   * once. This column is the control that should have been there instead.
   *
   * 268 decoupled it from 9766ff5's own trigger condition deliberately. The
   * letter of that ratification was "the same commit as whatever first makes live
   * sends reachable", and 267 established the cron had ALREADY passed that point
   * before the ratification was written, so the letter could never fire again and
   * its purpose would have died with it. At zero live merchants this disables
   * nothing real, which is what makes now the cheapest moment it will ever have.
   */
  liveSendsEnabled: bool("live_sends_enabled").notNull().default(false),
  processingPaused: bool("processing_paused").notNull().default(false),
  // WHY this account is paused, so the global emergency brake can be released
  // safely. 'brake' means the global brake paused it; null means a human paused
  // it individually, or it is not paused at all.
  //
  // This column exists because engage and release are deliberately ASYMMETRIC.
  // Engage skips accounts that are already paused, so the brake never takes
  // ownership of a merchant an operator paused on purpose. Release then unpauses
  // ONLY rows carrying this marker, so lifting the brake cannot silently resume
  // a merchant who was paused for their own reason. Without the marker, release
  // would have to unpause everything and would quietly undo an unrelated
  // operator decision, which is the one way a safety control can itself cause an
  // incident.
  pauseReason: text("pause_reason"),
  // Operator-initiated cancel/disconnect (admin Pass 2). Distinct from
  // processingPaused on purpose: this is a PROCESSING gate only (recovery-tick,
  // intelligence-sync), never a billing gate. Already-matured, unbilled
  // recoveries/disputes must still bill after cancel unless the account is
  // ALSO billing_exempt (PRICING.md: cancel never silently forgives owed fees).
  // app/db/billable.ts's accountBillingEligibleCondition deliberately does not
  // reference this column.
  cancelledAt: ts("cancelled_at"),
  // When the owner deleted their account (row S40, Q14 and Q16). The row itself
  // survives, emptied of personal data, because billing joins it and its fee
  // evidence (recovered_payments, billing rows) hangs from its id; this stamp
  // says why it is empty. Written only by app/lib/auth/delete-account.server.ts.
  // Like cancelledAt it is NOT a billing gate: fees already earned stay owed.
  deletedAt: ts("deleted_at"),
  // Foxhound's OWN Stripe account customer id for this merchant (PRICING.md rev 3:
  // direct platform invoicing, not Connect application fees). Null until
  // billing-setup runs; createPlatformInvoice refuses to charge without it.
  platformStripeCustomerId: text("platform_stripe_customer_id"),
  disputeProductDescription: text("dispute_product_description"),
  disputeShipsPhysical: bool("dispute_ships_physical"),
  // Auto-submit disputes (Recova's toggle on /settings/disputes; migration
  // 0057). NULL reads as off, as Recova's `?? false`. The disputes cron submits
  // an unsubmitted dispute 24 hours before its deadline only while this is on,
  // and writes the dispute's approval from the standing opt-in below.
  disputeAutoSubmit: bool("dispute_auto_submit"),
  // Who turned auto-submit on, and when: the merchant's standing approval that
  // an automatic submission's dispute_approvals row records. Written with the
  // toggle (applyDisputeSettings), cleared when it is turned off.
  disputeAutoSubmitByUserId: text("dispute_auto_submit_by_user_id"),
  disputeAutoSubmitByEmail: text("dispute_auto_submit_by_email"),
  disputeAutoSubmitAt: ts("dispute_auto_submit_at"),
  // The Disputes on/off switch on /settings/disputes (Recova's DisputesToggle
  // over account_products). On by default, as Recova activated Disputes on
  // Stripe connect; while off, dispute intake (webhook and manual import)
  // creates no dispute.
  disputesEnabled: bool("disputes_enabled").notNull().default(true),
  auditLookbackDays: integer("audit_lookback_days"),
  auditAutoRun: bool("audit_auto_run"),
  theme: text("theme").notNull().default("dark"),
});

export const accountMembers = sqliteTable(
  "account_members",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    // soft ref to Better Auth user.id (Phase 3); no enforced FK yet
    userId: text("user_id"),
    role: text("role").notNull(),
    invitedEmail: text("invited_email"),
    status: text("status").notNull(),
    inviteToken: text("invite_token"),
    inviteExpiresAt: ts("invite_expires_at"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("account_members_account_idx").on(t.accountId),
    // Every signed-in request resolves its memberships by user. The partial
    // unique index below cannot serve it: its status = 'active' filter does not
    // match a bound parameter.
    index("account_members_user_idx").on(t.userId),
    // A user joins a given account AT MOST ONCE, and may join MANY accounts.
    //
    // This replaces `account_members_one_active_per_user_uq`, which was the same
    // partial unique on `user_id` ALONE and therefore capped every user at one
    // active membership. Ruling 324 struck it: Dustin ruled multi-account into
    // the parity campaign, and a Foxhound-internal rule that prevents parity is a
    // rule to remove, not a constraint to work around. The 232 comments that
    // described the old index as a live invariant are re-classified in phase (g);
    // this one is the index, so it describes the new one.
    //
    // WHAT LEGACY ACTUALLY ENFORCES, measured in 326 phase (a) Job 0 rather than
    // inferred. Legacy's DATABASE enforces NOTHING here: `account_members` has
    // one index, the NON-unique `account_members_user_status_idx` on
    // `(user_id, status)` (docs/reference/database.md, blob ae81ba51, the Indexes
    // table, which does mark uniques where they exist). Legacy's APPLICATION does
    // enforce exactly this pair: app/api/invite/accept/route.ts:47-57 (blob
    // 13708537) looks up an existing membership by `account_id` AND `user_id` AND
    // status active and short-circuits rather than activating a second. So the
    // pair below is legacy's real invariant, moved down one layer to where a race
    // cannot get past it.
    //
    // Pending invite rows carry a null user_id and status 'pending' and are
    // excluded twice over. The read-checks in acceptInvite and
    // createAccountForUser stay as fast paths; this is the backstop against a
    // concurrent double-accept of the SAME account's invite.
    uniqueIndex("account_members_user_account_active_uq")
      .on(t.userId, t.accountId)
      .where(sql`${t.status} = 'active'`),
  ],
);

// The one first account a user creates at /connect, written in the same money
// batch as that account. Its unique user_id is the database's half of the
// `connect:first:<user>` idempotency key: if the Durable Object dies after D1
// commits but before it records the key, the retry's batch is refused here and
// reports the account that already exists rather than minting a second.
export const accountFirstCreations = sqliteTable(
  "account_first_creations",
  {
    id: id(),
    userId: text("user_id").notNull(),
    accountId: text("account_id").notNull().references(() => accounts.id),
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
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeUserId: text("stripe_user_id").notNull(),
    // encrypted at rest by app code; never logged (ARCHITECTURE.md non-negotiable #5)
    stripeAccessToken: text("stripe_access_token"),
    stripePublishableKey: text("stripe_publishable_key"),
    stripeScope: text("stripe_scope"),
    name: text("name"),
    isPrimary: bool("is_primary").notNull().default(false),
    connectedAt: ts("connected_at"),
    disconnectedAt: ts("disconnected_at"),
    // Set when the Stripe oauth.deauthorize after a disconnect failed; the
    // daily stripe-deauthorize-retry cron retries it and clears it (FH-7).
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
    // The connected Stripe account's own health, from its latest account.updated
    // event (app/lib/stripe/account-health.ts). All NULL until the first one
    // arrives, and NULL reads as healthy: Foxhound never guesses a problem it
    // was not told about. health_updated_at is the EVENT's created time, so an
    // older event delivered late never overwrites a newer state.
    chargesEnabled: bool("charges_enabled"),
    payoutsEnabled: bool("payouts_enabled"),
    disabledReason: text("disabled_reason"),
    pastDueCount: integer("past_due_count"),
    currentDeadline: ts("current_deadline"),
    healthUpdatedAt: ts("health_updated_at"),
  },
  (t) => [
    index("stripe_connections_account_idx").on(t.accountId),
    // ONE LIVE FOXHOUND ACCOUNT PER STRIPE ACCOUNT (ruling 356, DEFECT 4).
    //
    // Money routing depends on this. `resolveConnection` maps an incoming
    // connected webhook to an account by `stripe_user_id` alone, so every
    // failed payment, recovered payment, outcome and billing line item for a
    // Stripe account follows whichever row that lookup returns. That is sound
    // only if the live mapping is ONE-TO-ONE, and until this index nothing
    // enforced it: two users who both hold Stripe access to one account could
    // attach it to two Foxhound accounts, and the webhook layer would honor
    // the wrong one faithfully and forever.
    //
    // SCOPED TO LIVE ROWS, which is binding 4 and not an accident of shape. S37
    // disconnects by stamping `disconnected_at` and leaving the row, so a
    // uniqueness rule over the whole table would make the first disconnect a
    // permanent ban on ever connecting that Stripe account again, here or
    // anywhere. Under this WHERE clause a disconnected row is invisible to the
    // constraint and reconnect stays legal.
    uniqueIndex("stripe_connections_live_stripe_account_uq")
      .on(t.stripeUserId)
      .where(sql`${t.disconnectedAt} is null`),
  ],
);

export const accountSubscriptions = sqliteTable(
  "account_subscriptions",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
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
    accountId: text("account_id").references(() => accounts.id),
    keyHash: text("key_hash").notNull(),
    label: text("label"),
    scope: text("scope").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    /** Null for a key made in Settings, which lives until revoked. Set on the
     *  one-hour access token an OAuth grant issues (J79); verifyMcpToken
     *  refuses the key once it has passed. */
    expiresAt: ts("expires_at"),
  },
  (t) => [
    index("api_keys_account_idx").on(t.accountId),
    // Every bearer-token request looks its key up by hash (auth/mcp-tokens.ts).
    index("api_keys_key_hash_idx").on(t.keyHash),
  ],
);
