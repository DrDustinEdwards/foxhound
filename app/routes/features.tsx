import { useMemo, useState } from "react";
import { Link } from "react-router";

import { HealthScoreBadge } from "~/components/docs/health-score-badge";
import { SequenceTimeline } from "~/components/docs/sequence-timeline";
import { FeatureFilter } from "~/components/feature-filter";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { ProductTag } from "~/components/tone-pills";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { FEATURE_FILTER_CSS } from "~/lib/http/inline-styles";
import {
  FEATURES_META_DESCRIPTION,
  FEATURES_SUBTEXT,
  featureSections,
  healthBandExampleScores,
  healthBandSentence,
  type Feature,
  type FeatureFilterValue,
} from "~/lib/marketing/features-content";
import { readFeatureFacts } from "~/lib/marketing/features-facts.server";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/chips.css";
import "capsomer/status.css";
import "capsomer/button.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// chips, the badges, the button and the focus ring read. The site header loads
// the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/features";

// /features (J60, row M10). Recova's spec is app/(marketing)/features/page.tsx
// (blob 04aa91d8) with components/features/FeatureCard.tsx (dd6c9a87),
// FeatureFilter.tsx (4e2ef1fa) and FeatureFilterShell.tsx (707d79df), all read
// whole. The content is lib/marketing/features-content.ts: Recova's sections
// and entries, each one a capability Foxhound ships, every number read from
// the engine.
//
// Layout is Recova's: the shared page header, one 1100px column, the filter
// row, the 220px sticky section nav beside the sections at lg, each section's
// h2 and intro, the per-section inline example, the two-column card grid, and
// the closing line and audit link. Look is Capsomer's (Q12): the page sits in
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
// drawn (RULES.md 2.1, 2.3); which numbers, if any, Foxhound shows there is
// left open for a ruling.

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    // data-product is what FEATURE_FILTER_CSS reads to hide a card.
    // Recova's feature card: p-4 and 8px corners.
    <div className="cap-panel rounded-lg [--gap:1rem] [--pad-card:1rem]" data-product={feature.product}>
      <div className="cap-panel-body">
        <div>
          <div className="mb-2 flex items-start justify-between gap-3">
            <span className="text-copy font-medium text-text">{feature.name}</span>
            <ProductTag product={feature.product} />
          </div>
          <p className="m-0 text-label leading-relaxed text-text-secondary">{feature.description}</p>
        </div>
      </div>
    </div>
  );
}

// Recova's inline examples, keyed by section id. The automation timeline reads
// RECOVERY_SCHEDULES and the badges read healthScoreBand (rulings 78, 79); the
// sentence states the same bands, from the same constants.
function SectionInlineExample({ id }: { id: string }) {
  if (id === "automation") {
    return <SequenceTimeline category="soft" />;
  }
  if (id === "intelligence") {
    return (
      <div className="my-6 flex items-center gap-3 text-label text-text-secondary">
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
  return marketingMeta({
    title: "Features - Foxhound",
    description: FEATURES_META_DESCRIPTION,
    path: "/features",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env), facts: await readFeatureFacts() };
}

export default function FeaturesPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, facts } = loaderData;
  const sections = useMemo(() => featureSections(facts), [facts]);
  const [filter, setFilter] = useState<FeatureFilterValue>("All");
  const all = sections.flatMap((s) => s.features);
  const shown = filter === "All" ? all.length : all.filter((f) => f.product === filter).length;

  return (
    // Capsomer's amber family with Foxhound's neutrals. Foxhound's global focus
    // ring reads --border-focus (app.css); inside this page it reads the
    // family's --ring, so a keyboard user sees amber as in Capsomer's own parts.
    <div className="fh-cap fh-features [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      <style>{FEATURE_FILTER_CSS}</style>
      <MarketingPageHeader eyebrow="Platform" title="Features" subtext={FEATURES_SUBTEXT} />

      <div className="mx-auto max-w-[1100px] px-5 pb-16 sm:px-8">
        {/* Recova's FeatureFilterShell: the active value on the wrapper, which
            FEATURE_FILTER_CSS reads; no card re-renders on a press. */}
        <div data-feature-filter={filter}>
          <FeatureFilter active={filter} onChange={setFilter} shownCount={shown} totalCount={all.length} />

          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[220px_1fr]">
            {/* Recova's sticky section nav. Capsomer's anchor bar is a
                horizontal bar with an "On this page" label, so this stays
                Recova's vertical list in Foxhound utilities with the amber
                accent on hover; a vertical anchor bar is a Capsomer gap. */}
            <aside className="hidden lg:block">
              <nav aria-label="Sections" className="sticky top-20 space-y-1">
                {sections.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className="block border-l border-border py-1 pl-3 text-label text-text-secondary transition-colors hover:border-accent-text hover:text-text"
                  >
                    {s.label}
                  </a>
                ))}
              </nav>
            </aside>

            {/* Recova wraps this column in <main>; Foxhound renders one main
                landmark per document from the layout (approved 2026-07-29), so
                this is a plain div. */}
            <div className="space-y-16">
              {sections.map((s) => (
                <section key={s.id} id={s.id} className="scroll-mt-20">
                  <div className="mb-6">
                    <h2 className="mb-1 text-title font-medium text-text">{s.title}</h2>
                    <p className="m-0 text-copy leading-relaxed text-text-secondary">{s.intro}</p>
                  </div>
                  <SectionInlineExample id={s.id} />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {s.features.map((f) => (
                      <FeatureCard key={f.name} feature={f} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-24 border-t border-border pt-12 text-center">
          <p className="mx-auto mb-6 max-w-[400px] text-subhead text-text-secondary">
            See what your Stripe account is leaking. Free diagnostic, no account required.
          </p>
          {/* Comfortable density for Capsomer's lg button, as /pricing: 40px
              tall with a pointer, 44px on a touch screen. */}
          <div data-density="comfortable">
            <Link to="/audit" className="cap-btn px-6 [--cap-btn-h:3rem]" data-variant="primary" data-size="lg">
              Run your free audit
            </Link>
          </div>
        </div>
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Features", path: "/features" },
            ]),
          ),
        }}
      />
    </div>
  );
}
