import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { DOC_GUIDES, type DocGuide } from "~/lib/marketing/docs-content";
import { docsItemListJsonLd, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the accent text and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import "~/docs.css";

// The /docs index: the shared page header, the 720px column with px-6 and pb-16, Platform as a full-width card above a two-column grid at sm, the four product guides (Audit, Recovery, Disputes, Intelligence), then the two cross-links. Each card is Capsomer's panel in the amber family. Guide titles and descriptions come from app/lib/marketing/docs-content.ts.

export function meta({ loaderData }: Route.MetaArgs) {
  // The hub as a LIST, so a crawler reading /docs gets the set rather than five pages it has to discover by link-following. Derived from DOC_GUIDES in render order, so a sixth guide joins it by construction.
  return [
    ...marketingMeta({
      title: "User guides: setup, recovery and disputes",
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
      <MarketingPageHeader title="Documentation" />

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
        <p className="fh-mt-6 fh-small fh-soft">
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

const CROSS_LINK = "fh-hover-group fh-docs-cross fh-brand";

/** The 13px arrow, nudged on the link's hover. Decorative. */
function Arrow() {
  return <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />;
}

/** One guide card: Capsomer's linked panel, the whole-card link, at its p-5 and 8px corners. The card takes the amber edge under the pointer without the lift, so the lift is off. "group" carries no style; it drives the arrow's nudge. */
function GuideCard({ guide }: { guide: DocGuide }) {
  return (
    <Link to={`/docs/${guide.slug}`} className="fh-docs-link cap-panel fh-hover-group">
      <div className="cap-panel-body">
        <div>
          <div className="fh-mb-3 fh-item-title fh-medium fh-text">{guide.title}</div>
          <div className="fh-mb-5 fh-small fh-relaxed fh-soft">{guide.description}</div>
          <div className="fh-small fh-brand">
            Read guide <Arrow />
          </div>
        </div>
      </div>
    </Link>
  );
}

export const headers = () => publicPageHeaders();
