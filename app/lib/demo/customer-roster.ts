import {
  type DemoBillingCadence,
  type DemoCustomer,
  type DemoLifecycleStatus,
  type DemoTier,
  GROWTH_PER_SEAT_CENTS,
  SCALE_PER_SEAT_CENTS,
  TIER_BASE_CENTS,
  daysAgo,
  seededInt,
} from "./customer-base";
import {
  BOLT_COMPANY_PREFIXES,
  BOLT_COMPANY_SUFFIXES,
  TEAMFLOW_COMPANY_PREFIXES,
  TEAMFLOW_COMPANY_SUFFIXES,
  emailFromName,
  generateNameNoCollision,
} from "./customer-names";
import { teamflowScripted } from "./customer-teamflow";
import { boltScripted } from "./customer-bolt";

/**
 * Customer signup date with growth-curve weighting: 40% in last 6 months, 35%
 * in months 6-12, 25% in months 12-18.
 */
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

/**
 * Billing anchor day-of-month, weighted toward 1 and 15: 30% on day 1, 25% on
 * day 15, 45% spread across 1-28.
 */
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

/**
 * churnedAt: 40% in last 14 days (active win-back candidates), 35% in 14-60
 * days, 25% in 60-180 days (long-gone).
 */
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

/** One paying customer in ten holds a 20% forever coupon. */
function sampleCoupon(seed: string, tier: DemoTier): number | null {
  if (tier === "hobby") return null;
  return seededInt(`${seed}:coupon`, 100) < 10 ? 20 : null;
}

/** Growth: 30% have an addon (15% $25, 15% $50). Else 0. */
function sampleAddon(seed: string, tier: DemoTier): number {
  if (tier !== "growth") return 0;
  const r = seededInt(`${seed}:addon`, 100);
  if (r < 15) return 2500;
  if (r < 30) return 5000;
  return 0;
}

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
  const customerName = generateNameNoCollision(
    seed,
    companyBiasPct,
    prefixes,
    suffixes,
    reservedNames,
  );
  const customerEmail = emailFromName(customerName, customerId);
  const customerSince = sampleCustomerSince(seed, now);
  const billingCadence = sampleBillingCadence(seed);
  const billingAnchorDay = sampleBillingAnchorDay(seed);
  const seats = sampleSeats(seed, tier);
  const perSeatCents = perSeatCentsForTier(tier, seats);
  const addonCents = sampleAddon(seed, tier);
  const status = sampleLifecycleStatus(seed);
  const churnedAt = status === "churned" ? sampleChurnedAt(seed, now) : null;
  const couponPercentOff = sampleCoupon(seed, tier);

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
    ...(couponPercentOff ? { couponPercentOff } : {}),
  };
}

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

// Bolt target: 200 customers total.
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
      // Bolt is dev tools: bias 60% toward company names.
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
