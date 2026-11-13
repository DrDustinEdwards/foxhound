import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { DOC_GUIDES, type DocGuide } from "~/lib/marketing/docs-content";
import { docsItemListJsonLd, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// accent text and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import "~/docs.css";

// The /docs index. Recova's spec is app/(marketing)/docs/page.tsx
// (blob 4562a1ed) and components/MarketingPageHeader.tsx (blob 118a5104), read
// whole.
//
// Layout is Recova's: the shared page header, the 720px column with px-6 and
// pb-16, Platform as a full-width card above a two-column grid at sm, the four
// product guides in Recova's order (Audit, Recovery, Disputes, Intelligence),
// then the two cross-links. Look is Capsomer's: each card is Capsomer's
// panel in the amber family at Recova's sizes, amber throughout. Guide titles and descriptions come from
// app/lib/marketing/docs-content.ts and stay 20d-frozen.

export function meta({ loaderData }: Route.MetaArgs) {
  // The hub as a LIST, so a crawler reading /docs gets the set rather than
  // five pages it has to discover by link-following. Derived from
  // DOC_GUIDES in render order, so a sixth guide joins it by construction.
  return [
    ...marketingMeta({
      title: "Docs",
      description:
        "User guides for Foxhound: platform setup, recovery, disputes, and intelligence.",
      path: "/docs",
      pageType: "CollectionPage",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData ? [jsonLd(docsItemListJsonLd(loaderData.siteUrl, DOC_GUIDES))] : []),
  ];
}

export const loader = siteUrlLoader;

export default function DocsIndexPage() {
  const platform = DOC_GUIDES.find((g) => g.slug === "platform")!;
  const productGuides = DOC_GUIDES.filter((g) => g.slug !== "platform");

  return (
    <>
      <MarketingPageHeader
        eyebrow="User guides"
        title="Documentation"
        subtext="Documentation for the Foxhound platform."
      />

      {/* div, not main: marketing.tsx already renders this page's one main landmark.
          Recova's 720px column, in Capsomer's amber family with Foxhound's own
          neutrals (.fh-cap, as the site header and the /products hub); the focus
          ring reads the family's amber ring here, as in Capsomer's own parts. */}
      <div className="fh-mk-article fh-cap" data-cap-site="foxhound" data-family="amber">
        <div className="cap-stack" data-gap="5">
          {/* Platform: full width, the same card as the product guides below. */}
          <GuideCard guide={platform} />

          <div className="fh-mk-cards-2">
            {productGuides.map((g) => (
              <GuideCard key={g.slug} guide={g} />
            ))}
          </div>
        </div>

        {/* Recova's cross-links. leading-6 makes each link a 24px target, as
            the /pricing Learn more links. */}
        <div className="cap-cluster fh-docs-block fh-small" data-gap="6">
          <Link to="/features" className={CROSS_LINK}>
            See all features <Arrow />
          </Link>
          <Link to="/pricing" className={CROSS_LINK}>
            View pricing <Arrow />
          </Link>
        </div>

        {/* The support address, so a reader who did not find the answer here
            has the next step on the same page (parity audit, 2026-11-10). */}
        <p className="fh-docs-text fh-small fh-soft">
          Not covered here? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className={CROSS_LINK}>
            {SUPPORT_EMAIL}
          </a>{" "}
          with your account email and the Stripe invoice or payment ID.
        </p>
      </div>
    </>
  );
}

const CROSS_LINK = "fh-hover-group fh-docs-cross fh-accent";

/** Recova's 13px arrow, nudged on the link's hover. Decorative. */
function Arrow() {
  return <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />;
}

/**
 * One guide card: Capsomer's linked panel, the whole-card link Recova draws,
 * at its p-5 and 8px corners. Recova's guide cards take the amber edge under
 * the pointer without the lift, so the lift is off here. "group" carries no
 * style; it drives the arrow's nudge.
 */
function GuideCard({ guide }: { guide: DocGuide }) {
  return (
    <Link to={`/docs/${guide.slug}`} className="fh-docs-link cap-panel fh-hover-group">
      <div className="cap-panel-body">
        {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
        <div>
          <div className="fh-docs-block-2 fh-item-title fh-medium fh-text">{guide.title}</div>
          <div className="fh-docs-block-3 fh-small fh-relaxed fh-soft">{guide.description}</div>
          <div className="fh-small fh-accent">
            Read guide <Arrow />
          </div>
        </div>
      </div>
    </Link>
  );
}

export const headers = () => publicPageHeaders();
