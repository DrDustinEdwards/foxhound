import { marketingMeta } from "~/lib/seo/meta";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { useMemo, useState } from "react";
import { AnchorBar } from "capsomer/react/anchor-bar";
import { FeatureGrid } from "capsomer/react/feature";
import { ButtonLink } from "capsomer/react/link";

import { HealthScoreBadge } from "~/components/docs/health-score-badge";
import { SequenceSteps } from "~/components/recovery-previews";
import { FeatureFilter } from "~/components/feature-filter";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { ProductTag } from "~/components/tone-pills";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { FEATURE_FILTER_CSS } from "~/lib/http/inline-styles";
import {
  FEATURES_META_DESCRIPTION,
  FEATURES_SUBTEXT,
  featureSections,
  healthBandExampleScores,
  healthBandSentence,
  type FeatureFilterValue,
} from "~/lib/marketing/features-content";
import { readFeatureFacts } from "~/lib/marketing/features-facts.server";
import { siteUrl } from "~/lib/seo/jsonld";

import "capsomer/anchor-bar.css";
import "capsomer/feature.css";
import "capsomer/panel.css";
import "capsomer/chips.css";
import "capsomer/status.css";
import "capsomer/button.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// chips, the badges, the button and the focus ring read. The site header loads
// the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/features";
import "~/features.css";

// /features. Recova's spec is app/(marketing)/features/page.tsx
// (blob 04aa91d8) with components/features/FeatureCard.tsx (dd6c9a87),
// FeatureFilter.tsx (4e2ef1fa) and FeatureFilterShell.tsx (707d79df), all read
// whole. The content is lib/marketing/features-content.ts: Recova's sections
// and entries, each one a capability Foxhound ships, every number read from
// the engine.
//
// Layout is Recova's: the shared page header, one 1100px column, the filter
// row, the 220px sticky section nav beside the sections at lg, each section's
// h2 and intro, the per-section inline example, the two-column card grid, and
// the closing line and audit link. Look is Capsomer's: the page sits in
// the amber family with Foxhound's neutrals (.fh-cap, as the site header, the
// legal pages and the /products hub), the filter is Capsomer's chips, each
// card is Capsomer's panel, each product tag a Capsomer badge, and the closing
// link Capsomer's primary button.
//
// Text is at Recova's sizes: the h2 1.25rem, the intro and card name 0.875rem,
// card description, nav links and the band line 0.8125rem, the closing line
// 0.9375rem.
//
// Recova renders a third inline example in Visibility, two stat tiles reading
// its own 26.6% and $6,884. Those are Recova's figures, so the tiles are not
// drawn; which numbers, if any, Foxhound shows there is
// left open for a ruling.

// Recova's inline examples, keyed by section id. The automation timeline reads
// RECOVERY_SCHEDULES and the badges read healthScoreBand; the
// sentence states the same bands, from the same constants.
function SectionInlineExample({ id }: { id: string }) {
  if (id === "automation") {
    return (
      <div className="fh-features-block-2">
        <SequenceSteps category="soft" />
      </div>
    );
  }
  if (id === "intelligence") {
    return (
      <div className="fh-features-row fh-small fh-soft">
        {healthBandExampleScores().map((score) => (
          <HealthScoreBadge key={score} score={score} />
        ))}
        <span>{healthBandSentence()}</span>
      </div>
    );
  }
  return null;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Features",
      description: FEATURES_META_DESCRIPTION,
      path: "/features",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env), facts: await readFeatureFacts() };
}

/** How many features each product has, for the filter's screen reader line. */
function productCounts(features: { product: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) counts[f.product] = (counts[f.product] ?? 0) + 1;
  return counts;
}

export default function FeaturesPage({ loaderData }: Route.ComponentProps) {
  const { facts } = loaderData;
  const sections = useMemo(() => featureSections(facts), [facts]);
  const [filter, setFilter] = useState<FeatureFilterValue>("All");
  const all = sections.flatMap((s) => s.features);
  const shown = filter === "All" ? all.length : all.filter((f) => f.product === filter).length;

  return (
    // Capsomer's amber family with Foxhound's neutrals.
    <div className="fh-cap fh-features" data-cap-site="foxhound" data-family="amber">
      <style>{FEATURE_FILTER_CSS}</style>
      <MarketingPageHeader eyebrow="Platform" title="Features" subtext={FEATURES_SUBTEXT} />

      <div className="fh-features-wrap">
        {/* Recova's FeatureFilterShell: the active value on the wrapper, which
            FEATURE_FILTER_CSS reads; no card re-renders on a press. */}
        <div
          data-feature-filter={filter}
          // On a page that does not hydrate, the feature-filter island (islands/feature-filter.ts) moves it.
          data-island="feature-filter"
          data-props={JSON.stringify({ total: all.length, counts: productCounts(all) })}
        >
          <FeatureFilter
            active={filter}
            onChange={setFilter}
            shownCount={shown}
            totalCount={all.length}
          />

          <div className="fh-features-grid">
            {/* Recova's sticky section nav: Capsomer's vertical anchor bar,
                listed on the server so it shows without a script. */}
            <aside className="fh-features-aside">
              <AnchorBar
                always
                orientation="vertical"
                label="Sections"
                sections={sections.map((s) => ({ id: s.id, label: s.label }))}
              />
            </aside>

            {/* Recova wraps this column in <main>; Foxhound renders one main
                landmark per document from the layout (approved 2026-07-29), so
                this is a plain div. */}
            <div className="fh-features-block-4">
              {sections.map((s) => (
                <section key={s.id} id={s.id} className="fh-features-band">
                  <div className="fh-features-block-5">
                    <h2 className="fh-features-title fh-title fh-medium fh-text">{s.title}</h2>
                    <p className="fh-copy fh-relaxed fh-soft">{s.intro}</p>
                  </div>
                  <SectionInlineExample id={s.id} />
                  {/* Capsomer's feature cards; data-product is what
                      FEATURE_FILTER_CSS reads to hide a card. */}
                  <FeatureGrid
                    items={s.features.map((f) => ({
                      id: f.name,
                      title: f.name,
                      text: f.description,
                      tag: <ProductTag product={f.product} />,
                      attributes: { "data-product": f.product },
                    }))}
                  />
                </section>
              ))}
            </div>
          </div>
        </div>

        <div className="fh-features-block-6 fh-center">
          <p className="fh-features-wrap-2 fh-subhead fh-soft">
            See what your Stripe account is leaking. Free diagnostic, no account required.
          </p>
          {/* Comfortable density for Capsomer's lg button, as /pricing: 40px
              tall with a pointer, 44px on a touch screen. */}
          <div data-density="comfortable">
            <ButtonLink to="/audit" className="fh-mk-big-button" variant="primary" size="lg">
              Run your free audit
            </ButtonLink>
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
