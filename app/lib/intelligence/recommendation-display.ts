// How a customer's recommendation is shown outside /intelligence/recommendations:
// Recova's chip after the name on /intelligence/customers (customers/page.tsx,
// blob 0413f035, chipLabelFor) and its IntegrityLayerBanner on the payment, the
// dispute and the customer pages (components/intelligence/IntegrityLayerBanner.tsx,
// blob 1614dfaf), both read whole. Only the four actions Recova's table produces
// are here (recommend.ts says why the other three are not ported).
//
// CLIENT-SAFE BY CONSTRUCTION: the routes render these, so this module imports
// nothing from a `.server` file.

import { formatMoney } from "~/lib/money-format";

import type { CustomerRecommendation, RecommendedAction } from "./recommend";

/** Recova's chipLabelFor. */
export function chipLabelFor(action: string | null | undefined): string {
  switch (action) {
    case "personal_outreach":
      return "Outreach";
    case "continue_automated_priority":
      return "Watch closely";
    case "continue_automated_deprioritize":
      return "Low yield";
    case "continue_automated":
      return "Automated";
    default:
      return "";
  }
}

export type BannerSurface = "recovery" | "dispute" | "customer";

/** Recova's shouldRenderBanner: nothing to say when the case is automated and
 *  both read-only bands are green, or when both are unknown and the customer
 *  is not high value. */
export function shouldRenderBanner(p: CustomerRecommendation | null): p is CustomerRecommendation {
  if (!p) return false;
  const automated = p.recommendation.action === "continue_automated";
  if (automated && p.engagement.band === "green" && p.history.band === "green") return false;
  if (automated && p.engagement.band === "unknown" && p.history.band === "unknown" && p.value.band !== "high") {
    return false;
  }
  return true;
}

/** Recova's colorVariantFor, in Capsomer's tones: red is crit, amber is warn. */
export function bannerToneFor(action: RecommendedAction): "crit" | "warn" {
  return action === "personal_outreach" ? "crit" : "warn";
}

/** Recova's headlineFor. "Intelligence" names the product, as Recova's did. */
export function bannerHeadline(action: RecommendedAction, surface: BannerSurface): string {
  switch (action) {
    case "personal_outreach":
      if (surface === "customer") return "Personal outreach recommended this week";
      return surface === "dispute"
        ? "Intelligence recommends personal outreach to this customer"
        : "Intelligence recommends personal outreach this week";
    case "continue_automated_priority":
      return surface === "customer" ? "Continue automated: watch closely" : "Continue automated recovery: but watch closely";
    case "continue_automated_deprioritize":
      return surface === "customer" ? "Continue automated: low-yield case" : "Continue automated recovery: low-yield case";
    case "continue_automated":
      return surface === "customer" ? "Signals worth knowing" : "Continue automated recovery: signals worth knowing";
  }
}

const DAY_MS = 86_400_000;

/** Recova's engagementEvidence. */
export function engagementEvidence(e: CustomerRecommendation["engagement"], nowMs: number): string {
  if (e.band === "unknown") return "Engagement: unknown (fewer than 3 emails sent in last 30 days)";
  const { emailsSent30d: sent, emailsOpened30d: opened, lastOpenAtMs } = e.evidence;
  if (e.band === "green" && lastOpenAtMs !== null) {
    const days = Math.max(0, Math.round((nowMs - lastOpenAtMs) / DAY_MS));
    return `Engagement: green (${sent} sent, ${opened} opened, last open ${days} ${days === 1 ? "day" : "days"} ago)`;
  }
  return `Engagement: ${e.band} (${sent} sent, ${opened} opened in last 30 days)`;
}

/** Recova's historyEvidence. */
export function historyEvidence(h: CustomerRecommendation["history"]): string {
  if (h.band === "unknown") return "Recovery history: unknown (fewer than 3 prior failures)";
  return `Recovery history: ${h.band} (${h.evidence.priorRecoveriesCount} of ${h.evidence.priorFailuresCount} prior failures recovered)`;
}

/** Recova's valueEvidence, in the customer's own currency. */
export function valueEvidence(v: CustomerRecommendation["value"], currency: string): string {
  const amount = `${formatMoney(v.evidence.mrrContributionCents, currency)}/mo`;
  if (v.band === "high") return `Value: high (top 25%, ${amount})`;
  if (v.band === "medium") return `Value: medium (middle 50%, ${amount})`;
  return `Value: low (bottom 25%, ${amount})`;
}

/**
 * Recova's mrrAtRiskText. Recova printed twelve months of MRR as "$X MRR at
 * risk", which overstated it twelvefold as a monthly figure, so the line names
 * it as a year.
 */
export function atRiskText(r: CustomerRecommendation["recommendation"], currency: string): string | null {
  if (r.annualizedMrrAtRiskCents === null) return null;
  return `${formatMoney(r.annualizedMrrAtRiskCents, currency)} a year at risk`;
}
