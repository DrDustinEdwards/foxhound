import { Banner } from "capsomer/react/banner";
import "capsomer/banner.css";

import type { CustomerRecommendation } from "~/lib/intelligence/recommend";
import {
  atRiskText,
  bannerHeadline,
  bannerToneFor,
  type BannerSurface,
  engagementEvidence,
  historyEvidence,
  shouldRenderBanner,
  valueEvidence,
} from "~/lib/intelligence/recommendation-display";

/**
 * Recova's IntegrityLayerBanner (blob 1614dfaf), on Capsomer's Banner: the
 * headline and the year at risk, the rationale, the three bands' evidence, and
 * the confidence. Recova's footer also said "Phase 1 rules · live signal",
 * which named its build phase rather than anything about the customer, so the
 * footer keeps the confidence alone. Renders nothing when Recova's would not.
 */
export function RecommendationBanner({
  prediction,
  surface,
  nowMs,
  className = "mb-6",
}: {
  prediction: { result: CustomerRecommendation; currency: string } | null;
  surface: BannerSurface;
  nowMs: number;
  /** The wrapper's spacing; a page that spaces its cards with a gap passes "". */
  className?: string;
}) {
  const p = prediction?.result ?? null;
  if (!prediction || !shouldRenderBanner(p)) return null;
  const { action } = p.recommendation;
  const atRisk = atRiskText(p.recommendation, prediction.currency);
  return (
    <div className={className || undefined} data-testid="recommendation-banner">
      <Banner
        tone={bannerToneFor(action)}
        title={
          <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span>{bannerHeadline(action, surface)}</span>
            {atRisk ? <span className="whitespace-nowrap">{atRisk}</span> : null}
          </span>
        }
      >
        <p className="m-0 mb-2 text-label text-text">{p.recommendation.rationale}</p>
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-micro text-text-secondary">
          <span>{engagementEvidence(p.engagement, nowMs)}</span>
          <span>{historyEvidence(p.history)}</span>
          <span>{valueEvidence(p.value, prediction.currency)}</span>
        </p>
        <p className="m-0 mt-2 text-micro text-text-tertiary">Confidence: {p.recommendation.confidence}</p>
      </Banner>
    </div>
  );
}
