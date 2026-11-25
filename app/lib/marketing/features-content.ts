import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import { automationSection } from "~/lib/marketing/features-automation";
import { intelligenceSection } from "~/lib/marketing/features-intelligence";
import { emailSection } from "~/lib/marketing/features-email";
import { visibilitySection } from "~/lib/marketing/features-visibility";
import { controlSection } from "~/lib/marketing/features-control";
import { integrationSection } from "~/lib/marketing/features-integration";
import { securitySection } from "~/lib/marketing/features-security";
import { platformSection } from "~/lib/marketing/features-platform";
import { featureCadence } from "~/lib/marketing/features-cadence";

// /features content. Each feature is kept where Foxhound ships it and the words are true, rewritten to Foxhound's own fact where
// it ships the thing differently, and left out where it has not built it. Every number is read from the engine, never typed:
// cadences from the cron schedule constants, the fee and maturity from the pricing constants, the bands from the functions that
// color them. Two counts live only on the server (the cron registry and the MCP tool list); the route's loader passes them in
// as FeatureFacts.

const FEATURE_PRODUCTS = ["Platform", "Audit", "Recovery", "Disputes", "Intelligence"] as const;
type FeatureProduct = (typeof FEATURE_PRODUCTS)[number];

/** All first, then the five products. */
export const FEATURE_FILTERS = ["All", ...FEATURE_PRODUCTS] as const;
export type FeatureFilterValue = (typeof FEATURE_FILTERS)[number];

export interface Feature {
  name: string;
  description: string;
  product: FeatureProduct;
}

export interface FeatureSection {
  id: string;
  label: string;
  title: string;
  intro: string;
  features: Feature[];
}

/** Counts that only the server can read (the cron registry and the merchant MCP tool list). */
export interface FeatureFacts {
  cronJobCount: number;
  merchantMcpToolCount: number;
}

export const FEATURES_META_DESCRIPTION =
  "Features across automation, intelligence, email, visibility, control, integration, and security. Built for Stripe subscription businesses.";

/** The three example scores beside the health-band sentence, one per band. Each default (20, 50, 82) is kept while it lands in
 *  its band under Foxhound's thresholds, else becomes the band's midpoint, so a badge never shows a score in the wrong band. */
export function healthBandExampleScores(): [number, number, number] {
  const bands: [number, number, number][] = [
    [20, 0, HEALTH_SCORE_AT_RISK_THRESHOLD - 1],
    [50, HEALTH_SCORE_AT_RISK_THRESHOLD, WATCH_CEILING - 1],
    [82, WATCH_CEILING, 100],
  ];
  const [a, b, c] = bands.map(([recova, lo, hi]) =>
    recova >= lo && recova <= hi ? recova : Math.floor((lo + hi) / 2),
  );
  return [a, b, c];
}

/** Foxhound's health bands, as the intelligence section's example states them. */
export function healthBandSentence(): string {
  return `red below ${HEALTH_SCORE_AT_RISK_THRESHOLD}, orange ${HEALTH_SCORE_AT_RISK_THRESHOLD}-${WATCH_CEILING - 1}, green at or above ${WATCH_CEILING}.`;
}

export function featureSections(facts: FeatureFacts): FeatureSection[] {
  const c = featureCadence();
  return [
    automationSection(c),
    intelligenceSection(c),
    emailSection(c),
    visibilitySection(c, facts),
    controlSection(c),
    integrationSection(facts),
    securitySection(),
    platformSection(c, facts),
  ];
}
