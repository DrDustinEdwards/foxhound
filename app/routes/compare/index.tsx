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
import "~/reference.css";

// /compare hub: a card grid linking to each of the six competitor pages. Card copy is each competitor's one-liner from the shared data module, not separate marketing spin.

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
      <MarketingPageHeader title="How Foxhound compares" />

      {/* Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /blog):
          the cards' accent edge and the focus ring read the family. */}
      <div className="fh-mk-page fh-cap" data-cap-site="foxhound" data-family="amber">
        <div className="fh-mk-cards-3">
          {COMPETITOR_ORDER.map((slug) => {
            const c = COMPETITORS[slug];
            return (
              <Link key={slug} to={`/compare/${slug}`} className={`${CARD_MD}`}>
                <div className="cap-panel-body">
                  <div>
                    <p className="fh-compare-text fh-mono fh-tiny fh-quiet fh-caps">{c.category}</p>
                    <p className="fh-mb-3 fh-body fh-medium fh-text">Foxhound vs {c.name}</p>
                    <p className="fh-mb-5 fh-small fh-relaxed fh-soft">{c.oneLiner}</p>
                    <div className="fh-small fh-brand">
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
