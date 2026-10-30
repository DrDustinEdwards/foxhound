import { jsonLdText } from "@drdustinedwards/site-helpers/xml";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DOC_GUIDES, type DocGuide } from "~/lib/marketing/docs-content";
import { breadcrumbListJsonLd, docsItemListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// accent text and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";

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
  return marketingMeta({
    title: "Docs - Foxhound",
    description: "User guides for Foxhound: platform setup, recovery, disputes, and intelligence.",
    path: "/docs",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function DocsIndexPage({ loaderData }: Route.ComponentProps) {
  const url = loaderData.siteUrl;
  const platform = DOC_GUIDES.find((g) => g.slug === "platform")!;
  const productGuides = DOC_GUIDES.filter((g) => g.slug !== "platform");

  return (
    <>
      <MarketingPageHeader eyebrow="User guides" title="Documentation" subtext="Documentation for the Foxhound platform." />

      {/* div, not main: marketing.tsx already renders this page's one main landmark.
          Recova's 720px column, in Capsomer's amber family with Foxhound's own
          neutrals (.fh-cap, as the site header and the /products hub); the focus
          ring reads the family's amber ring here, as in Capsomer's own parts. */}
      <div className="fh-cap mx-auto max-w-[720px] px-6 pb-16 [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
        <div className="flex flex-col gap-4">
          {/* Platform: full width, the same card as the product guides below. */}
          <GuideCard guide={platform} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {productGuides.map((g) => (
              <GuideCard key={g.slug} guide={g} />
            ))}
          </div>
        </div>

        {/* Recova's cross-links. leading-6 makes each link a 24px target, as
            the /pricing Learn more links. */}
        <div className="mt-12 flex flex-wrap items-center gap-6 text-label">
          <Link to="/features" className={CROSS_LINK}>
            See all features <Arrow />
          </Link>
          <Link to="/pricing" className={CROSS_LINK}>
            View pricing <Arrow />
          </Link>
        </div>
      </div>

      {/* The hub as a LIST, so a crawler reading /docs gets the set rather than
          five pages it has to discover by link-following. Derived from
          DOC_GUIDES in render order, so a sixth guide joins it by construction. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdText([
            docsItemListJsonLd(url, DOC_GUIDES),
            breadcrumbListJsonLd(url, [{ name: "Docs", path: "/docs" }]),
          ]),
        }}
      />
    </>
  );
}

const CROSS_LINK = "group leading-6 text-accent-text no-underline transition-opacity duration-150 hover:opacity-80";

/** Recova's 13px arrow, nudged on the link's hover. Decorative. */
function Arrow() {
  return (
    <ArrowRight
      className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
      size={13}
      strokeWidth={1.5}
      aria-hidden
    />
  );
}

/**
 * One guide card: Capsomer's linked panel, the whole-card link Recova draws,
 * at its p-5 and 8px corners. Recova's guide cards take the amber edge under
 * the pointer without the lift, so the lift is off here. "group" carries no
 * style; it drives the arrow's nudge.
 */
function GuideCard({ guide }: { guide: DocGuide }) {
  return (
    <Link to={`/docs/${guide.slug}`} className="cap-panel group rounded-lg [--card-lift:0px] [--gap:1.25rem] [--pad-card:1.25rem]">
      <div className="cap-panel-body">
        {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
        <div>
          <div className="mb-2 text-item-title font-medium text-text">{guide.title}</div>
          <div className="mb-4 text-label leading-relaxed text-text-secondary">{guide.description}</div>
          <div className="text-label text-accent-text">
            Read guide <Arrow />
          </div>
        </div>
      </div>
    </Link>
  );
}
