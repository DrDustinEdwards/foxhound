import type { DeclineCategory } from "~/lib/constants";
import { DAY_MS } from "~/lib/constants";

// Shared demo customer base: pure, deterministic 200-customer rosters for the
// two demo businesses, Teamflow (Starter/Growth/Scale) and Bolt Analytics
// (Pro/Hobby).

export type DemoTier = "starter" | "growth" | "scale" | "pro" | "hobby";
export type DemoLifecycleStatus = "active" | "at_risk" | "churned" | "paused";
export type DemoBillingCadence = "monthly" | "annual";
type DemoFpOutcome = "recovered" | "failed_unrecovered" | "active";

interface DemoScriptedFpEvent {
  detectedDaysAgo: number;
  declineCategory: DeclineCategory;
  outcome: DemoFpOutcome;
  daysToRecover?: number;
  // Routine card-renewal noise, excluded from headline dashboard aggregations
  // (failedPayments.isRenewalNoise).
  isRenewalNoise?: boolean;
}

interface DemoHealthPoint {
  daysAgo: number;
  healthScore: number;
  reason: string;
}

// Optional override for the Intelligence layer's
// customerContext.engagementSignals write. When present on a scripted customer,
// the intelligence seed uses these values instead of computing from the default
// formula, for narratives that need an opens/recency profile the formula would
// not otherwise produce.
export interface DemoEngagementOverride {
  emailOpened30d?: number;
  emailClicked30d?: number;
  lastEmailOpenedAtDaysAgo?: number | null; // null = no opens at all
}

interface DemoScripted {
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

  // A forever percent-off coupon on the subscription, as a Stripe discount
  // would carry it; what the customer pays, and so MRR, is after it.
  couponPercentOff?: number;
  // A change or cancellation a Stripe subscription schedule (or cancel_at) has
  // planned, this many days from the seed's now.
  scheduledChange?: { kind: "change" | "cancel"; daysFromNow: number };
}

export const TIER_BASE_CENTS: Record<DemoTier, number> = {
  starter: 2900,
  growth: 9900,
  scale: 29900,
  pro: 9900,
  hobby: 0,
};

export const SCALE_PER_SEAT_CENTS = 4900;
export const GROWTH_PER_SEAT_CENTS = 2500;
const ANNUAL_DISCOUNT = 0.9; // 10% off annual prepay

/**
 * The customer's total recurring monthly rate before any annual discount: base
 * covers the first seat, per-seat applies only to additional seats.
 */
export function monthlyTotalCents(c: DemoCustomer): number {
  if (c.tier === "hobby") return 0;
  return c.planBaseCents + Math.max(0, c.seats - 1) * c.perSeatCents + c.addonCents;
}

/** The share of the price a customer's coupon leaves them paying. */
function couponFactor(c: DemoCustomer): number {
  return 1 - (c.couponPercentOff ?? 0) / 100;
}

/**
 * Per-invoice amount given the customer's billing cadence. Annual prepay is
 * monthly_total * 12 * 0.9 (10% discount). Any coupon comes off after. Hobby is
 * always 0.
 */
export function invoiceAmountCents(c: DemoCustomer): number {
  const monthly = monthlyTotalCents(c) * couponFactor(c);
  if (c.billingCadence === "annual") {
    return Math.round(monthly * 12 * ANNUAL_DISCOUNT);
  }
  return Math.round(monthly);
}

/**
 * Monthly recurring contribution toward MRR: what the customer pays after any
 * coupon. Annual subscriptions normalize to (annual_amount / 12). Churned and
 * Hobby customers contribute 0.
 */
export function monthlyMrrCents(c: DemoCustomer): number {
  if (c.status === "churned") return 0;
  const monthly = monthlyTotalCents(c) * couponFactor(c);
  if (c.billingCadence === "annual") {
    return Math.round((monthly * 12 * ANNUAL_DISCOUNT) / 12);
  }
  return Math.round(monthly);
}

/**
 * Day-walk eligibility: scripted customers have hand-placed failure events
 * only, no random failures layered on top. Hobby tier has no invoices.
 */
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

/**
 * The failed_payments.plan_name label: tier + a variance suffix (seats, add-on,
 * annual), so a reader can tell a multi-seat/annual customer apart from the
 * base tier without opening the customer record.
 */
export function planNameFor(c: DemoCustomer): string {
  const parts: string[] = [];
  if (c.seats > 1) parts.push(`${c.seats} seats`);
  if (c.addonCents > 0) parts.push("with add-on");
  if (c.billingCadence === "annual") parts.push("annual");
  return parts.length ? `${TIER_LABEL[c.tier]} (${parts.join(", ")})` : TIER_LABEL[c.tier];
}

// Seeded helpers (FNV-1a, shared with recovery-seed.ts and intelligence-seed.ts
// so the whole demo engine hashes off one deterministic scheme)

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

export function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * DAY_MS);
}
