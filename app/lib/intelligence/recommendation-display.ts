// How a customer's recommendation is shown outside /intelligence/recommendations: the chip after the name on the
// customers list and the banner on the payment, dispute and customer pages. Only the four actions recommend.ts
// produces are here. Client-safe by construction: nothing is imported from a `.server` file.

import { plural } from "@drdustinedwards/site-helpers/text";
import { formatMoney } from "@dustinedwards/site-runtime/money";

import type { CustomerRecommendation, RecommendedAction } from "./recommend";

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

/** Nothing to say when the case is automated and both read-only bands are green, or both are unknown and the customer is not high value. */
export function shouldRenderBanner(p: CustomerRecommendation | null): p is CustomerRecommendation {
  if (!p) return false;
  const automated = p.recommendation.action === "continue_automated";
  if (automated && p.engagement.band === "green" && p.history.band === "green") return false;
  if (
    automated &&
    p.engagement.band === "unknown" &&
    p.history.band === "unknown" &&
    p.value.band !== "high"
  ) {
    return false;
  }
  return true;
}

/** Red is crit, amber is warn. */
export function bannerToneFor(action: RecommendedAction): "crit" | "warn" {
  return action === "personal_outreach" ? "crit" : "warn";
}

/** "Intelligence" names the product. */
export function bannerHeadline(action: RecommendedAction, surface: BannerSurface): string {
  switch (action) {
    case "personal_outreach":
      if (surface === "customer") return "Personal outreach recommended this week";
      return surface === "dispute"
        ? "Intelligence recommends personal outreach to this customer"
        : "Intelligence recommends personal outreach this week";
    case "continue_automated_priority":
      return surface === "customer"
        ? "Continue automated: watch closely"
        : "Continue automated recovery: but watch closely";
    case "continue_automated_deprioritize":
      return surface === "customer"
        ? "Continue automated: low-yield case"
        : "Continue automated recovery: low-yield case";
    case "continue_automated":
      return surface === "customer"
        ? "Signals worth knowing"
        : "Continue automated recovery: signals worth knowing";
  }
}

const DAY_MS = 86_400_000;

export function engagementEvidence(e: CustomerRecommendation["engagement"], nowMs: number): string {
  if (e.band === "unknown") return "Engagement: unknown (fewer than 3 emails sent in last 30 days)";
  const { emailsSent30d: sent, emailsOpened30d: opened, lastOpenAtMs } = e.evidence;
  if (e.band === "green" && lastOpenAtMs !== null) {
    const days = Math.max(0, Math.round((nowMs - lastOpenAtMs) / DAY_MS));
    return `Engagement: green (${sent} sent, ${opened} opened, last open ${plural(days, "day")} ago)`;
  }
  return `Engagement: ${e.band} (${sent} sent, ${opened} opened in last 30 days)`;
}

export function historyEvidence(h: CustomerRecommendation["history"]): string {
  if (h.band === "unknown") return "Recovery history: unknown (fewer than 3 prior failures)";
  return `Recovery history: ${h.band} (${h.evidence.priorRecoveriesCount} of ${h.evidence.priorFailuresCount} prior failures recovered)`;
}

/** Value evidence, in the customer's own currency. */
export function valueEvidence(v: CustomerRecommendation["value"], currency: string): string {
  const amount = `${formatMoney(v.evidence.mrrContributionCents, currency)}/mo`;
  if (v.band === "high") return `Value: high (top 25%, ${amount})`;
  if (v.band === "medium") return `Value: medium (middle 50%, ${amount})`;
  return `Value: low (bottom 25%, ${amount})`;
}

/** The MRR-at-risk line; twelve months of MRR is named as a year, not a monthly figure. */
export function atRiskText(
  r: CustomerRecommendation["recommendation"],
  currency: string,
): string | null {
  if (r.annualizedMrrAtRiskCents === null) return null;
  return `${formatMoney(r.annualizedMrrAtRiskCents, currency)} a year at risk`;
}
