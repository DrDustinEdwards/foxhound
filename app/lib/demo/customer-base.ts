import type { DeclineCategory } from "~/lib/constants";

// Shared demo customer base: a pure, deterministic 200-customer Teamflow roster
// (+ a 200-customer Bolt roster, built but not seeded yet: the demo seeds ONE
// account, TASK-foxhound-demo-data-engine.md locked constraint #3, which is a
// demo decision and not the struck single-account rule). Ported near-verbatim
// from legacy lib/demo-customer-base.ts.
//
// Pure: no DB access, no env reads, no I/O. Reproducible: every customer's
// attributes derive from a stable seed string (FNV-1a), so the same `now`
// produces the same roster every time.
//
// Scripted customers carry their narrative inline (slug + scripted
// failed_payment events + health_trajectory). Anonymous customers fill the
// per-tier slot count after scripted entries are allocated to their tiers, so
// the totals stay at 200 / 200.
//
// Day-walk eligibility: scripted customers and Hobby-tier customers are
// excluded (see isDayWalkEligible). Scripted customers' failed payments are
// placed by their failed_payment_events schedule alone, no random failures
// layered on top, so the Acme / Bluewave narratives stay clean.

export type DemoTier = "starter" | "growth" | "scale" | "pro" | "hobby";
export type DemoLifecycleStatus = "active" | "at_risk" | "churned" | "paused";
export type DemoBillingCadence = "monthly" | "annual";
export type DemoFpOutcome = "recovered" | "failed_unrecovered" | "active";

export interface DemoScriptedFpEvent {
  detectedDaysAgo: number;
  declineCategory: DeclineCategory;
  outcome: DemoFpOutcome;
  daysToRecover?: number;
  // Routine card-renewal noise, excluded from headline dashboard aggregations
  // (failedPayments.isRenewalNoise).
  isRenewalNoise?: boolean;
}

export interface DemoHealthPoint {
  daysAgo: number;
  healthScore: number;
  reason: string;
}

// Optional override for the Intelligence layer's customerContext.engagementSignals
// write. When present on a scripted customer, the intelligence seed uses these
// values instead of computing from the default formula, for narratives that need
// an opens/recency profile the formula would not otherwise produce.
export interface DemoEngagementOverride {
  emailOpened30d?: number;
  emailClicked30d?: number;
  lastEmailOpenedAtDaysAgo?: number | null; // null = no opens at all
}

export interface DemoScripted {
  slug: string;
  failedPaymentEvents: DemoScriptedFpEvent[];
  healthTrajectory: DemoHealthPoint[];
  healthFactors?: Record<string, unknown>;
  engagementOverride?: DemoEngagementOverride;
}

export interface DemoCustomer {
  // Identity
  stripeCustomerId: string;
  customerEmail: string;
  customerName: string;
  customerSince: Date;

  // Subscription shape
  tier: DemoTier;
  planBaseCents: number;
  billingCadence: DemoBillingCadence;
  billingAnchorDay: number; // 1..28
  seats: number; // >=1
  perSeatCents: number; // 4900 Scale, 2500 Growth multi-seat, 0 elsewhere
  addonCents: number; // 0 | 2500 | 5000 (Growth only)

  // Lifecycle
  status: DemoLifecycleStatus;
  churnedAt: Date | null; // populated iff status === 'churned'

  // Optional scripted overrides
  scripted: DemoScripted | null;
}

export interface CustomerBaseSummary {
  total: number;
  byTier: Record<DemoTier, number>;
  byStatus: Record<DemoLifecycleStatus, number>;
  byCadence: Record<DemoBillingCadence, number>;
  scriptedSlugs: string[];
  totalMrrCents: number;
  scriptedFpEventCount: number;
}

// ============================================================================
// Pricing constants
// ============================================================================

const TIER_BASE_CENTS: Record<DemoTier, number> = {
  starter: 2900,
  growth: 9900,
  scale: 29900,
  pro: 9900,
  hobby: 0,
};

const SCALE_PER_SEAT_CENTS = 4900;
const GROWTH_PER_SEAT_CENTS = 2500;
const ANNUAL_DISCOUNT = 0.9; // 10% off annual prepay

// ============================================================================
// Public utilities
// ============================================================================

/** The customer's total recurring monthly rate before any annual discount:
 *  base covers the first seat, per-seat applies only to additional seats. */
export function monthlyTotalCents(c: DemoCustomer): number {
  if (c.tier === "hobby") return 0;
  return c.planBaseCents + Math.max(0, c.seats - 1) * c.perSeatCents + c.addonCents;
}

/** Per-invoice amount given the customer's billing cadence. Annual prepay is
 *  monthly_total * 12 * 0.9 (10% discount). Hobby is always 0. */
export function invoiceAmountCents(c: DemoCustomer): number {
  const monthly = monthlyTotalCents(c);
  if (c.billingCadence === "annual") {
    return Math.round(monthly * 12 * ANNUAL_DISCOUNT);
  }
  return monthly;
}

/** Monthly recurring contribution toward MRR. Annual subscriptions normalize
 *  to (annual_amount / 12). Churned and Hobby customers contribute 0. */
export function monthlyMrrCents(c: DemoCustomer): number {
  if (c.status === "churned") return 0;
  const monthly = monthlyTotalCents(c);
  if (c.billingCadence === "annual") {
    return Math.round((monthly * 12 * ANNUAL_DISCOUNT) / 12);
  }
  return monthly;
}

/** Day-walk eligibility: scripted customers have hand-placed failure events
 *  only, no random failures layered on top. Hobby tier has no invoices. */
export function isDayWalkEligible(c: DemoCustomer): boolean {
  return c.scripted === null && c.tier !== "hobby";
}

const TIER_LABEL: Record<DemoTier, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  pro: "Pro",
  hobby: "Hobby",
};

/** The failed_payments.plan_name label: tier + a variance suffix (seats,
 *  add-on, annual), so a reader can tell a multi-seat/annual customer apart
 *  from the base tier without opening the customer record. */
export function planNameFor(c: DemoCustomer): string {
  const parts: string[] = [];
  if (c.seats > 1) parts.push(`${c.seats} seats`);
  if (c.addonCents > 0) parts.push("with add-on");
  if (c.billingCadence === "annual") parts.push("annual");
  return parts.length ? `${TIER_LABEL[c.tier]} (${parts.join(", ")})` : TIER_LABEL[c.tier];
}

export function summarize(customers: DemoCustomer[]): CustomerBaseSummary {
  const byTier: Record<DemoTier, number> = { starter: 0, growth: 0, scale: 0, pro: 0, hobby: 0 };
  const byStatus: Record<DemoLifecycleStatus, number> = { active: 0, at_risk: 0, churned: 0, paused: 0 };
  const byCadence: Record<DemoBillingCadence, number> = { monthly: 0, annual: 0 };
  const scriptedSlugs: string[] = [];
  let totalMrrCents = 0;
  let scriptedFpEventCount = 0;

  for (const c of customers) {
    byTier[c.tier]++;
    byStatus[c.status]++;
    byCadence[c.billingCadence]++;
    totalMrrCents += monthlyMrrCents(c);
    if (c.scripted) {
      scriptedSlugs.push(c.scripted.slug);
      scriptedFpEventCount += c.scripted.failedPaymentEvents.length;
    }
  }

  return {
    total: customers.length,
    byTier,
    byStatus,
    byCadence,
    scriptedSlugs: scriptedSlugs.sort(),
    totalMrrCents,
    scriptedFpEventCount,
  };
}

// ============================================================================
// Seeded helpers (FNV-1a, shared with recovery-seed.ts and intelligence-seed.ts
// so the whole demo engine hashes off one deterministic scheme)
// ============================================================================

export function seededInt(seed: string, max: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % max;
}

export function seededFloat(seed: string): number {
  return seededInt(seed, 1_000_000) / 1_000_000;
}

export function pick<T>(seed: string, choices: readonly T[]): T {
  return choices[seededInt(seed, choices.length)];
}

// ============================================================================
// Name pools (fictitious)
// ============================================================================

const FIRST_NAMES = [
  "Alex", "Bailey", "Carmen", "Devin", "Elena", "Felix", "Grace", "Hassan",
  "Iris", "Jordan", "Kai", "Luna", "Mateo", "Nadia", "Owen", "Priya",
  "Quincy", "Rosa", "Sam", "Tara", "Uma", "Vince", "Willa", "Xavier",
  "Yara", "Zane", "Amir", "Brielle", "Caleb", "Dahlia", "Esme", "Finn",
  "Greta", "Hugo", "Imani", "Jace", "Kira", "Leo", "Mira", "Nico",
] as const;
const LAST_NAMES = [
  "Adler", "Burke", "Castro", "Dalton", "Esparza", "Fields", "Gomez", "Hayes",
  "Iverson", "Jansen", "Kapoor", "Lowe", "Marsh", "Nakamura", "Oduya", "Pace",
  "Quinn", "Rojas", "Stein", "Tomlin", "Underwood", "Vega", "Wexler", "Xu",
  "Young", "Zara", "Abramov", "Beck", "Choi", "Diaz",
] as const;
const TEAMFLOW_COMPANY_PREFIXES = [
  "North", "South", "East", "West", "Bright", "Iron", "Silver", "Cedar",
  "Maple", "Pine", "Oak", "Ridge", "Stone", "River", "Lake", "Bay",
  "Coast", "Field", "Forge", "Cobalt", "Amber", "Slate", "Crimson", "Ember",
] as const;
const TEAMFLOW_COMPANY_SUFFIXES = [
  "Labs", "Works", "Group", "Studio", "Co", "Stack", "Logic", "Loop",
  "Cloud", "Forge", "Build", "Sync", "Flow", "Grid", "Hub", "Core",
] as const;
const BOLT_COMPANY_PREFIXES = [
  "Apex", "Beacon", "Cipher", "Drift", "Echo", "Flux", "Glyph", "Hex",
  "Iota", "Jolt", "Kelp", "Loft", "Mesh", "Nexa", "Orbit", "Pulse",
  "Quark", "Relay", "Sigma", "Tally", "Unit", "Vector", "Wave", "Xen",
] as const;
const BOLT_COMPANY_SUFFIXES = [
  "Stack", "Logic", "IO", "Engine", "Lab", "Compute", "Probe", "Trace",
  "Pipe", "Grid", "Cloud", "Ops", "Metric", "Sense", "Pulse", "Build",
] as const;

function generateName(
  seed: string,
  companyBiasPct: number,
  prefixes: readonly string[],
  suffixes: readonly string[],
): string {
  if (seededInt(`${seed}:kind`, 100) < companyBiasPct) {
    const prefix = pick(`${seed}:cprefix`, prefixes);
    const suffix = pick(`${seed}:csuffix`, suffixes);
    return `${prefix}${suffix}`;
  }
  const first = pick(`${seed}:first`, FIRST_NAMES);
  const last = pick(`${seed}:last`, LAST_NAMES);
  return `${first} ${last}`;
}

/** Reroll the anonymous-customer name if it collides with a scripted customer
 *  name. `reserved` is built from the scripted customers in the base. Rerolls
 *  up to 5 times with sub-seed variations; final fallback appends " II" so the
 *  function always returns a non-colliding string. */
function generateNameNoCollision(
  seed: string,
  companyBiasPct: number,
  prefixes: readonly string[],
  suffixes: readonly string[],
  reserved: Set<string>,
): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const subSeed = attempt === 0 ? seed : `${seed}:retry${attempt}`;
    const name = generateName(subSeed, companyBiasPct, prefixes, suffixes);
    if (!reserved.has(name)) return name;
  }
  return `${generateName(`${seed}:retry-final`, companyBiasPct, prefixes, suffixes)} II`;
}

function emailFromName(name: string, customerId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return `${slug}@${customerId}.demo`;
}

// ============================================================================
// Anonymous-customer attribute samplers
// ============================================================================

const MS_PER_DAY = 86_400_000;
function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * MS_PER_DAY);
}

/** Customer signup date with growth-curve weighting: 40% in last 6 months,
 *  35% in months 6-12, 25% in months 12-18. */
function sampleCustomerSince(seed: string, now: Date): Date {
  const bucket = seededInt(`${seed}:agebucket`, 100);
  let days: number;
  if (bucket < 40) {
    days = seededInt(`${seed}:agedays`, 180);
  } else if (bucket < 75) {
    days = 180 + seededInt(`${seed}:agedays`, 180);
  } else {
    days = 360 + seededInt(`${seed}:agedays`, 180);
  }
  return daysAgo(now, days);
}

/** 80% monthly, 20% annual prepay. */
function sampleBillingCadence(seed: string): DemoBillingCadence {
  return seededInt(`${seed}:cadence`, 100) < 80 ? "monthly" : "annual";
}

/** Billing anchor day-of-month, weighted toward 1 and 15: 30% on day 1, 25%
 *  on day 15, 45% spread across 1-28. */
function sampleBillingAnchorDay(seed: string): number {
  const bias = seededInt(`${seed}:anchorbias`, 100);
  if (bias < 30) return 1;
  if (bias < 55) return 15;
  return 1 + seededInt(`${seed}:anchor`, 28);
}

/** Lifecycle status: 70% active, 15% at_risk, 10% churned, 5% paused. */
function sampleLifecycleStatus(seed: string): DemoLifecycleStatus {
  const r = seededInt(`${seed}:status`, 100);
  if (r < 70) return "active";
  if (r < 85) return "at_risk";
  if (r < 95) return "churned";
  return "paused";
}

/** churnedAt: 40% in last 14 days (active win-back candidates), 35% in 14-60
 *  days, 25% in 60-180 days (long-gone). */
function sampleChurnedAt(seed: string, now: Date): Date {
  const bucket = seededInt(`${seed}:churnedbucket`, 100);
  let days: number;
  if (bucket < 40) days = 1 + seededInt(`${seed}:d`, 13); // 1..13
  else if (bucket < 75) days = 14 + seededInt(`${seed}:d`, 47); // 14..60
  else days = 60 + seededInt(`${seed}:d`, 121); // 60..180
  return daysAgo(now, days);
}

/** Per-tier seat distribution. */
function sampleSeats(seed: string, tier: DemoTier): number {
  if (tier === "starter" || tier === "hobby") return 1;
  if (tier === "growth" || tier === "pro") {
    const r = seededInt(`${seed}:seats`, 100);
    if (r < 70) return 1;
    if (r < 90) return 2;
    return 3;
  }
  // Scale: ~30% solo, ~50% 2-5 seats, ~15% 6-10, ~5% 11-20.
  const r = seededInt(`${seed}:seats`, 100);
  if (r < 30) return 1;
  if (r < 80) return 2 + seededInt(`${seed}:seatsmid`, 4);
  if (r < 95) return 6 + seededInt(`${seed}:seatshigh`, 5);
  return 11 + seededInt(`${seed}:seatsxhi`, 10);
}

function perSeatCentsForTier(tier: DemoTier, seats: number): number {
  if (tier === "scale") return SCALE_PER_SEAT_CENTS;
  if ((tier === "growth" || tier === "pro") && seats > 1) return GROWTH_PER_SEAT_CENTS;
  return 0;
}

/** Growth: 30% have an addon (15% $25, 15% $50). Else 0. */
function sampleAddon(seed: string, tier: DemoTier): number {
  if (tier !== "growth") return 0;
  const r = seededInt(`${seed}:addon`, 100);
  if (r < 15) return 2500;
  if (r < 30) return 5000;
  return 0;
}

// ============================================================================
// Anonymous-customer construction
// ============================================================================

function buildAnonymousCustomer(
  seedPrefix: string,
  customerId: string,
  tier: DemoTier,
  companyBiasPct: number,
  prefixes: readonly string[],
  suffixes: readonly string[],
  now: Date,
  reservedNames: Set<string>,
): DemoCustomer {
  const seed = `${seedPrefix}:${customerId}`;
  const customerName = generateNameNoCollision(seed, companyBiasPct, prefixes, suffixes, reservedNames);
  const customerEmail = emailFromName(customerName, customerId);
  const customerSince = sampleCustomerSince(seed, now);
  const billingCadence = sampleBillingCadence(seed);
  const billingAnchorDay = sampleBillingAnchorDay(seed);
  const seats = sampleSeats(seed, tier);
  const perSeatCents = perSeatCentsForTier(tier, seats);
  const addonCents = sampleAddon(seed, tier);
  const status = sampleLifecycleStatus(seed);
  const churnedAt = status === "churned" ? sampleChurnedAt(seed, now) : null;

  return {
    stripeCustomerId: customerId,
    customerEmail,
    customerName,
    customerSince,
    tier,
    planBaseCents: TIER_BASE_CENTS[tier],
    billingCadence,
    billingAnchorDay,
    seats,
    perSeatCents,
    addonCents,
    status,
    churnedAt,
    scripted: null,
  };
}

// ============================================================================
// Scripted customers - Teamflow
// ============================================================================

function teamflowScripted(now: Date): DemoCustomer[] {
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
          // Supporting: smaller blip 8 days ago, recovered after 2 days. Together
          // with the 18d and 25d events this keeps emails_sent_30d >= 3 so the
          // engagement band resolves above unknown.
          { detectedDaysAgo: 8, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
          // Supporting: third event 25 days ago, recovered after 2 days.
          { detectedDaysAgo: 25, declineCategory: "soft", outcome: "recovered", daysToRecover: 2 },
        ],
        engagementOverride: {
          emailOpened30d: 2,
          emailClicked30d: 1,
          lastEmailOpenedAtDaysAgo: 5,
        },
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
        engagementOverride: {
          emailOpened30d: 2,
          emailClicked30d: 1,
          lastEmailOpenedAtDaysAgo: 5,
        },
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
    // Harborline Group - Growth, no FPs (dispute story instead). The
    // disputes seed attaches the won-dispute row to this customer id.
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

// ============================================================================
// Scripted customers - Bolt (built for parity, not seeded yet: the demo seeds
// one account, TASK-foxhound-demo-data-engine.md locked constraint #3)
// ============================================================================

function boltScripted(now: Date): DemoCustomer[] {
  return [
    // Hilltop Metrics - Pro, recovered $99 ~10 days ago. Bolt's "your save".
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
          supportingSignals: ["high_engagement_on_free_tier", "sustained_usage", "mature_hobby_tenure"],
          recommendedAction: "pro_upgrade_outreach",
        },
      },
    },
  ];
}

// ============================================================================
// Builders - Teamflow + Bolt
// ============================================================================

// Teamflow target: 200 customers total.
//   Tiers: 100 Starter (50%), 60 Growth (30%), 40 Scale (20%).
//   Scripted: 1 Starter (Sycamore), 3 Growth (Harborline, Northpoint,
//             Pinecrest), 3 Scale (Acme, Bluewave, Lakeside) = 7 total.
//   Anonymous slots: 99 Starter + 57 Growth + 37 Scale = 193.
const TEAMFLOW_ANON_PER_TIER: Record<DemoTier, number> = {
  starter: 99,
  growth: 57,
  scale: 37,
  pro: 0,
  hobby: 0,
};

export function buildTeamflowBase(now: Date = new Date()): DemoCustomer[] {
  const seedPrefix = "teamflow:v2";
  const scripted = teamflowScripted(now);
  const reservedNames = new Set(scripted.map((c) => c.customerName));
  const anonymous: DemoCustomer[] = [];
  let seq = 1;
  const tiers: DemoTier[] = ["starter", "growth", "scale"];
  for (const tier of tiers) {
    const count = TEAMFLOW_ANON_PER_TIER[tier];
    for (let i = 0; i < count; i++) {
      const customerId = `cus_teamflow_${String(seq).padStart(3, "0")}`;
      seq++;
      anonymous.push(
        buildAnonymousCustomer(
          seedPrefix,
          customerId,
          tier,
          50,
          TEAMFLOW_COMPANY_PREFIXES,
          TEAMFLOW_COMPANY_SUFFIXES,
          now,
          reservedNames,
        ),
      );
    }
  }
  return [...scripted, ...anonymous];
}

// Bolt target: 200 customers total (built for parity; NOT seeded yet).
//   Tiers: 120 Pro (60%), 80 Hobby (40%). No Starter/Growth/Scale.
//   Scripted: 3 Pro (Hilltop, Driftwave, Corepath), 1 Hobby (Stillwater) = 4.
//   Anonymous slots: 117 Pro + 79 Hobby = 196.
const BOLT_ANON_PER_TIER: Record<DemoTier, number> = {
  starter: 0,
  growth: 0,
  scale: 0,
  pro: 117,
  hobby: 79,
};

export function buildBoltBase(now: Date = new Date()): DemoCustomer[] {
  const seedPrefix = "bolt:v2";
  const scripted = boltScripted(now);
  const reservedNames = new Set(scripted.map((c) => c.customerName));
  const anonymous: DemoCustomer[] = [];
  let seq = 1;
  const tiers: DemoTier[] = ["pro", "hobby"];
  for (const tier of tiers) {
    const count = BOLT_ANON_PER_TIER[tier];
    for (let i = 0; i < count; i++) {
      const customerId = `cus_bolt_${String(seq).padStart(3, "0")}`;
      seq++;
      // Bolt is dev-tools - bias 60% toward company names.
      anonymous.push(
        buildAnonymousCustomer(
          seedPrefix,
          customerId,
          tier,
          60,
          BOLT_COMPANY_PREFIXES,
          BOLT_COMPANY_SUFFIXES,
          now,
          reservedNames,
        ),
      );
    }
  }
  return [...scripted, ...anonymous];
}
