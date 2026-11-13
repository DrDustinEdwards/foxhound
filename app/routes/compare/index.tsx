import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Link } from "capsomer/react/link";
import "capsomer/panel.css";

import { CARD_MD } from "~/components/marketing-card";
import { Arrow } from "~/components/home-parts";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { COMPETITOR_ORDER, COMPETITORS } from "~/lib/compare/competitors";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/index";

// NEW in Phase 6 Pass 3 (net-new). /compare hub: a card grid linking to each
// of the six named competitor pages (ROUTES.md Rev 2). Honest by
// construction: card copy is each competitor's one-liner from the shared
// data module, not marketing spin written separately here.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Compare Foxhound",
      description:
        "How Foxhound compares to Stripe Smart Retries, Churnkey, Churn Buster, Paddle Retain, Baremetrics Recover and Stunning, with honest pros and cons.",
      path: "/compare",
      pageType: "CollectionPage",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

export const loader = siteUrlLoader;

export default function CompareIndex() {
  return (
    <div>
      <MarketingPageHeader
        eyebrow="Compare"
        title="How Foxhound compares"
        subtext="Honest tables, including where Foxhound is newer or narrower than the incumbents. No fabricated competitor numbers."
      />

      {/* Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /blog):
          the cards' accent edge and the focus ring read the family. */}
      <div
        className="fh-cap mx-auto max-w-5xl px-4 pb-16 sm:px-8"
        data-cap-site="foxhound"
        data-family="amber"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {COMPETITOR_ORDER.map((slug) => {
            const c = COMPETITORS[slug];
            return (
              <Link key={slug} to={`/compare/${slug}`} className={`${CARD_MD} group`}>
                <div className="cap-panel-body">
                  {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
                  <div>
                    <p className="mb-1 font-mono text-micro uppercase tracking-wide text-text-tertiary">
                      {c.category}
                    </p>
                    <p className="mb-2 text-body font-medium text-text">Foxhound vs {c.name}</p>
                    <p className="mb-4 text-label leading-relaxed text-text-secondary">
                      {c.oneLiner}
                    </p>
                    <div className="text-label text-brand-text">
                      See the comparison <Arrow />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
