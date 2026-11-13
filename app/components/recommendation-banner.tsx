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
  className = "fh-rec-gap",
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
          <span className="fh-rec-head">
            <span>{bannerHeadline(action, surface)}</span>
            {atRisk ? <span className="fh-nowrap">{atRisk}</span> : null}
          </span>
        }
        // body, not children: children sit inside Capsomer's p.cap-banner-text,
        // and these three paragraphs inside a p are invalid HTML the browser
        // splits apart, so hydration found a different tree (React error 418 on the
        // demo's payment and customer pages, parity audit 2026-11-10).
        body={
          <>
            <p className="fh-rec-why fh-small fh-text">{p.recommendation.rationale}</p>
            <p className="fh-rec-facts fh-tiny fh-soft">
              <span>{engagementEvidence(p.engagement, nowMs)}</span>
              <span>{historyEvidence(p.history)}</span>
              <span>{valueEvidence(p.value, prediction.currency)}</span>
            </p>
            <p className="fh-rec-note fh-tiny fh-quiet">
              Confidence: {p.recommendation.confidence}
            </p>
          </>
        }
      />
    </div>
  );
}
