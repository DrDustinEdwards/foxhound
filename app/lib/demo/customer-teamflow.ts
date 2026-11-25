import {
  type DemoCustomer,
  type DemoEngagementOverride,
  GROWTH_PER_SEAT_CENTS,
  SCALE_PER_SEAT_CENTS,
  TIER_BASE_CENTS,
  daysAgo,
} from "./customer-base";

const RECENT_RECOVERY_ENGAGEMENT: DemoEngagementOverride = {
  emailOpened30d: 2,
  emailClicked30d: 1,
  lastEmailOpenedAtDaysAgo: 5,
};

export function teamflowScripted(now: Date): DemoCustomer[] {
  return [
    // Acme Industries - Scale, recovered $299 about 18 days ago. The headline
    // "your historical save" customer for the dashboard + Intelligence.
    {
      stripeCustomerId: "cus_teamflow_acme_industries",
      customerEmail: "founder@acme-industries.demo",
      customerName: "Acme Industries",
      customerSince: daysAgo(now, 14 * 30),
      tier: "scale",
      planBaseCents: TIER_BASE_CENTS.scale,
      billingCadence: "monthly",
      billingAnchorDay: 5,
      seats: 1,
      perSeatCents: SCALE_PER_SEAT_CENTS,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "acme_industries",
        failedPaymentEvents: [
          // Headline: $299 recovered 18 days ago, soft decline.
          { detectedDaysAgo: 18, declineCategory: "soft", outcome: "recovered", daysToRecover: 3 },
          // Supporting: smaller blip 8 days ago, recovered after 2 days.
          // Together with the 18d and 25d events this keeps emails_sent_30d >=
          // 3 so the engagement band resolves above unknown.
          { detectedDaysAgo: 8, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
          // Supporting: third event 25 days ago, recovered after 2 days.
          { detectedDaysAgo: 25, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
        ],
        engagementOverride: RECENT_RECOVERY_ENGAGEMENT,
        healthTrajectory: [
          { daysAgo: 150, healthScore: 78, reason: "baseline" },
          { daysAgo: 120, healthScore: 80, reason: "stable" },
          { daysAgo: 60, healthScore: 75, reason: "stable" },
          { daysAgo: 20, healthScore: 50, reason: "failed_payment" },
          { daysAgo: 10, healthScore: 55, reason: "in_recovery" },
          { daysAgo: 3, healthScore: 58, reason: "recovery_succeeded" },
        ],
      },
    },
    // Bluewave Studios - Scale, active failure 3 days ago. Headline "active
    // recovery in progress" for Intelligence.
    {
      stripeCustomerId: "cus_teamflow_bluewave_studios",
      customerEmail: "founder@bluewave-studios.demo",
      customerName: "Bluewave Studios",
      customerSince: daysAgo(now, 8 * 30),
      tier: "scale",
      planBaseCents: TIER_BASE_CENTS.scale,
      billingCadence: "monthly",
      billingAnchorDay: 18,
      seats: 5,
      perSeatCents: SCALE_PER_SEAT_CENTS,
      addonCents: 0,
      status: "at_risk",
      churnedAt: null,
      scripted: {
        slug: "bluewave_studios",
        failedPaymentEvents: [
          // Headline: $495 active recovery in progress, 3 days in.
          { detectedDaysAgo: 3, declineCategory: "soft", outcome: "active" },
          // Supporting: prior soft decline 15 days ago, recovered after 2 days.
          { detectedDaysAgo: 15, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
          // Supporting: third event 25 days ago, recovered after 2 days.
          { detectedDaysAgo: 25, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
        ],
        engagementOverride: RECENT_RECOVERY_ENGAGEMENT,
        healthTrajectory: [
          { daysAgo: 60, healthScore: 75, reason: "baseline_strong" },
          { daysAgo: 45, healthScore: 68, reason: "engagement_dip" },
          { daysAgo: 30, healthScore: 55, reason: "failed_payment" },
          { daysAgo: 20, healthScore: 42, reason: "in_recovery" },
          { daysAgo: 10, healthScore: 35, reason: "in_recovery" },
          { daysAgo: 2, healthScore: 28, reason: "critical_active_recovery" },
        ],
      },
    },
    // Harborline Group - Growth, no FPs (dispute story instead). The disputes
    // seed attaches the won-dispute row to this customer id.
    {
      stripeCustomerId: "cus_teamflow_harborline_group",
      customerEmail: "billing@harborline-group.demo",
      customerName: "Harborline Group",
      customerSince: daysAgo(now, 10 * 30),
      tier: "growth",
      planBaseCents: TIER_BASE_CENTS.growth,
      billingCadence: "monthly",
      billingAnchorDay: 1,
      seats: 1,
      perSeatCents: 0,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "harborline_group",
        failedPaymentEvents: [],
        healthTrajectory: [
          { daysAgo: 180, healthScore: 72, reason: "baseline" },
          { daysAgo: 120, healthScore: 75, reason: "stable" },
          { daysAgo: 60, healthScore: 68, reason: "stable" },
          { daysAgo: 40, healthScore: 50, reason: "dispute_opened" },
          { daysAgo: 20, healthScore: 60, reason: "dispute_won" },
          { daysAgo: 5, healthScore: 62, reason: "recovered_post_dispute" },
        ],
      },
    },
    // Northpoint Logistics - Growth, no FPs, expansion-ready power user.
    {
      stripeCustomerId: "cus_teamflow_northpoint_logistics",
      customerEmail: "finance@northpoint-logistics.demo",
      customerName: "Northpoint Logistics",
      customerSince: daysAgo(now, 11 * 30),
      tier: "growth",
      planBaseCents: TIER_BASE_CENTS.growth,
      billingCadence: "annual",
      billingAnchorDay: 15,
      seats: 1,
      perSeatCents: 0,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "northpoint_logistics",
        failedPaymentEvents: [],
        healthTrajectory: [
          { daysAgo: 300, healthScore: 65, reason: "onboarding" },
          { daysAgo: 240, healthScore: 72, reason: "activation" },
          { daysAgo: 180, healthScore: 80, reason: "stable" },
          { daysAgo: 120, healthScore: 84, reason: "engagement_growing" },
          { daysAgo: 60, healthScore: 87, reason: "high_usage" },
          { daysAgo: 20, healthScore: 89, reason: "expansion_signal" },
          { daysAgo: 3, healthScore: 90, reason: "expansion_signal" },
        ],
        healthFactors: {
          primaryConcern: null,
          supportingSignals: ["high_engagement", "sustained_usage", "mature_tenure"],
          recommendedAction: "expansion_outreach",
        },
      },
    },
    // Sycamore Co - Starter, voluntary-churn pattern.
    {
      stripeCustomerId: "cus_teamflow_sycamore_co",
      customerEmail: "admin@sycamore-co.demo",
      customerName: "Sycamore Co",
      customerSince: daysAgo(now, 135),
      tier: "starter",
      planBaseCents: TIER_BASE_CENTS.starter,
      billingCadence: "monthly",
      billingAnchorDay: 1,
      seats: 1,
      perSeatCents: 0,
      addonCents: 0,
      status: "churned",
      churnedAt: daysAgo(now, 18),
      scripted: {
        slug: "sycamore_co",
        failedPaymentEvents: [],
        healthTrajectory: [
          { daysAgo: 135, healthScore: 60, reason: "onboarding" },
          { daysAgo: 100, healthScore: 65, reason: "activation" },
          { daysAgo: 70, healthScore: 58, reason: "engagement_dip" },
          { daysAgo: 45, healthScore: 48, reason: "declining" },
          { daysAgo: 25, healthScore: 35, reason: "pre_churn_signal" },
          { daysAgo: 18, healthScore: 20, reason: "voluntary_churn" },
        ],
        healthFactors: {
          primaryConcern: "voluntary_churn",
          supportingSignals: ["low_engagement", "short_tenure"],
          recommendedAction: "win_back_sequence",
        },
      },
    },
    // Pinecrest Software - Growth, stable.
    {
      stripeCustomerId: "cus_teamflow_pinecrest_software",
      customerEmail: "ops@pinecrest-software.demo",
      customerName: "Pinecrest Software",
      customerSince: daysAgo(now, 9 * 30),
      tier: "growth",
      planBaseCents: TIER_BASE_CENTS.growth,
      billingCadence: "monthly",
      billingAnchorDay: 8,
      seats: 2,
      perSeatCents: GROWTH_PER_SEAT_CENTS,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "pinecrest_software",
        failedPaymentEvents: [],
        healthTrajectory: [
          { daysAgo: 270, healthScore: 62, reason: "onboarding" },
          { daysAgo: 200, healthScore: 70, reason: "activation" },
          { daysAgo: 130, healthScore: 75, reason: "stable" },
          { daysAgo: 60, healthScore: 76, reason: "stable" },
          { daysAgo: 5, healthScore: 78, reason: "stable" },
        ],
      },
    },
    // Lakeside Ventures - Scale, stable enterprise.
    {
      stripeCustomerId: "cus_teamflow_lakeside_ventures",
      customerEmail: "finance@lakeside-ventures.demo",
      customerName: "Lakeside Ventures",
      customerSince: daysAgo(now, 14 * 30),
      // A negotiated 15% off the annual contract.
      couponPercentOff: 15,
      tier: "scale",
      planBaseCents: TIER_BASE_CENTS.scale,
      billingCadence: "annual",
      billingAnchorDay: 1,
      seats: 4,
      perSeatCents: SCALE_PER_SEAT_CENTS,
      addonCents: 0,
      status: "active",
      churnedAt: null,
      scripted: {
        slug: "lakeside_ventures",
        failedPaymentEvents: [],
        healthTrajectory: [
          { daysAgo: 420, healthScore: 70, reason: "onboarding" },
          { daysAgo: 300, healthScore: 78, reason: "activation" },
          { daysAgo: 200, healthScore: 82, reason: "stable" },
          { daysAgo: 100, healthScore: 84, reason: "stable" },
          { daysAgo: 30, healthScore: 85, reason: "stable" },
          { daysAgo: 5, healthScore: 86, reason: "stable" },
        ],
      },
    },
  ];
}
