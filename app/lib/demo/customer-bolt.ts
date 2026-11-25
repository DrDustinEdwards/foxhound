import {
  type DemoCustomer,
  GROWTH_PER_SEAT_CENTS,
  TIER_BASE_CENTS,
  daysAgo,
} from "./customer-base";

export function boltScripted(now: Date): DemoCustomer[] {
  return [
    // Hilltop Metrics - Pro, recovered $99 about 10 days ago. Bolt's "your
    // save".
    {
      stripeCustomerId: "cus_bolt_hilltop_metrics",
      customerEmail: "billing@hilltop-metrics.demo",
      customerName: "Hilltop Metrics",
      customerSince: daysAgo(now, 6 * 30),
      tier: "pro",
      planBaseCents: TIER_BASE_CENTS.pro,
      billingCadence: "monthly",
      billingAnchorDay: 12,
      seats: 1,
      perSeatCents: 0,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "hilltop_metrics",
        failedPaymentEvents: [
          { detectedDaysAgo: 10, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
        ],
        healthTrajectory: [
          { daysAgo: 180, healthScore: 70, reason: "baseline" },
          { daysAgo: 120, healthScore: 73, reason: "stable" },
          { daysAgo: 60, healthScore: 75, reason: "engagement_growing" },
          { daysAgo: 20, healthScore: 50, reason: "failed_payment" },
          { daysAgo: 10, healthScore: 65, reason: "in_recovery" },
          { daysAgo: 2, healthScore: 78, reason: "recovery_succeeded" },
        ],
      },
    },
    // Driftwave Labs - Pro, recent upgrade gone cold. Churn risk.
    {
      stripeCustomerId: "cus_bolt_driftwave_labs",
      customerEmail: "founder@driftwave-labs.demo",
      customerName: "Driftwave Labs",
      customerSince: daysAgo(now, 21),
      // Set to cancel at the end of its billing period.
      scheduledChange: { kind: "cancel", daysFromNow: 9 },
      tier: "pro",
      planBaseCents: TIER_BASE_CENTS.pro,
      billingCadence: "monthly",
      billingAnchorDay: 7,
      seats: 1,
      perSeatCents: 0,
      addonCents: 0,
      status: "at_risk",
      churnedAt: null,
      scripted: {
        slug: "driftwave_labs",
        failedPaymentEvents: [
          // Three soft declines inside the last 30 days. With the override
          // below forcing zero opens, engagement reads red: a high-value
          // customer not engaging with email at all.
          { detectedDaysAgo: 24, declineCategory: "soft", outcome: "recovered", daysToRecover: 4 },
          { detectedDaysAgo: 14, declineCategory: "soft", outcome: "recovered", daysToRecover: 5 },
          { detectedDaysAgo: 5, declineCategory: "soft", outcome: "active" },
        ],
        healthTrajectory: [
          { daysAgo: 21, healthScore: 70, reason: "upgrade_to_pro" },
          { daysAgo: 16, healthScore: 65, reason: "first_login_post_upgrade" },
          { daysAgo: 12, healthScore: 55, reason: "engagement_dip" },
          { daysAgo: 7, healthScore: 42, reason: "inactivity" },
          { daysAgo: 2, healthScore: 30, reason: "critical_churn_risk" },
        ],
        healthFactors: {
          primaryConcern: "upgrade_churn_risk",
          supportingSignals: ["recent_upgrade_no_engagement", "extended_inactivity"],
          recommendedAction: "churn_save_outreach",
        },
        engagementOverride: {
          emailOpened30d: 0,
          emailClicked30d: 0,
          lastEmailOpenedAtDaysAgo: null,
        },
      },
    },
    // Corepath Devs - Pro power user.
    {
      stripeCustomerId: "cus_bolt_corepath_devs",
      customerEmail: "team@corepath-devs.demo",
      customerName: "Corepath Devs",
      customerSince: daysAgo(now, 8 * 30),
      tier: "pro",
      planBaseCents: TIER_BASE_CENTS.pro,
      billingCadence: "annual",
      billingAnchorDay: 15,
      seats: 2,
      perSeatCents: GROWTH_PER_SEAT_CENTS,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "corepath_devs",
        failedPaymentEvents: [
          // Three routine expired-card renewals: card-cycle noise, not customer
          // behavior, so they are flagged out of the headline aggregations.
          {
            detectedDaysAgo: 25,
            declineCategory: "expired",
            outcome: "recovered",
            daysToRecover: 2,
            isRenewalNoise: true,
          },
          {
            detectedDaysAgo: 15,
            declineCategory: "expired",
            outcome: "recovered",
            daysToRecover: 2,
            isRenewalNoise: true,
          },
          {
            detectedDaysAgo: 5,
            declineCategory: "expired",
            outcome: "recovered",
            daysToRecover: 2,
            isRenewalNoise: true,
          },
        ],
        healthTrajectory: [
          { daysAgo: 220, healthScore: 70, reason: "onboarding" },
          { daysAgo: 180, healthScore: 78, reason: "activation" },
          { daysAgo: 120, healthScore: 85, reason: "high_engagement" },
          { daysAgo: 60, healthScore: 90, reason: "power_user_pattern" },
          { daysAgo: 20, healthScore: 92, reason: "stable_excellent" },
          { daysAgo: 2, healthScore: 93, reason: "reference_customer" },
        ],
        healthFactors: {
          primaryConcern: null,
          supportingSignals: ["power_user", "high_engagement", "sustained_usage"],
          recommendedAction: "reference_customer",
        },
        engagementOverride: {
          emailOpened30d: 2,
          emailClicked30d: 1,
          lastEmailOpenedAtDaysAgo: 7,
        },
      },
    },
    // Stillwater Engineering - Hobby tier, hot expansion lead.
    {
      stripeCustomerId: "cus_bolt_stillwater_engineering",
      customerEmail: "hello@stillwater-engineering.demo",
      customerName: "Stillwater Engineering",
      customerSince: daysAgo(now, 4 * 30),
      tier: "hobby",
      planBaseCents: TIER_BASE_CENTS.hobby,
      billingCadence: "monthly",
      billingAnchorDay: 1,
      seats: 1,
      perSeatCents: 0,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "stillwater_engineering",
        failedPaymentEvents: [],
        healthTrajectory: [
          { daysAgo: 120, healthScore: 60, reason: "free_signup" },
          { daysAgo: 90, healthScore: 70, reason: "activation" },
          { daysAgo: 60, healthScore: 80, reason: "engagement_growing" },
          { daysAgo: 30, healthScore: 87, reason: "high_engagement" },
          { daysAgo: 7, healthScore: 89, reason: "pro_upgrade_signal" },
          { daysAgo: 1, healthScore: 90, reason: "pro_upgrade_signal" },
        ],
        healthFactors: {
          primaryConcern: null,
          supportingSignals: [
            "high_engagement_on_free_tier",
            "sustained_usage",
            "mature_hobby_tenure",
          ],
          recommendedAction: "pro_upgrade_outreach",
        },
      },
    },
  ];
}
