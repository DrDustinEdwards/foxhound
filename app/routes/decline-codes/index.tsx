import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Pill } from "capsomer/react/status";
import "capsomer/status.css";
import { Link } from "capsomer/react/link";
import "capsomer/panel.css";

import { BADGE_PILL } from "~/lib/recovery/labels";
import { CARD_SM } from "~/components/marketing-card";
import { Arrow } from "~/components/home-parts";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { CATEGORY_LABEL, CATEGORY_ORDER, listDeclineCodeViews } from "~/lib/decline-codes/codes";
import { CATEGORY_STATUS_LABEL, categoryBadgeTone } from "~/lib/decline-codes/presentation";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/index";

// NEW in Phase 6 Pass 3 (net-new, no legacy equivalent): the decline-code
// reference library hub. Cards are grouped by classification category
// (soft/network/expired/fraud) rather than alphabetically, since that
// grouping mirrors what actually determines recovery behavior
// (app/lib/recovery/decline.ts) and is more useful to a merchant scanning
// the page than an alphabetical list would be.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Stripe Decline Code Library",
      description:
        "What every major Stripe decline code means, why it happens, and how it gets recovered. Grouped by soft, network, expired, and fraud classifications.",
      path: "/decline-codes",
      pageType: "CollectionPage",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

export const loader = siteUrlLoader;

export default function DeclineCodesIndex() {
  const views = listDeclineCodeViews();
  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    codes: views.filter((v) => v.category === category),
  })).filter((g) => g.codes.length > 0);

  return (
    <div>
      <MarketingPageHeader
        eyebrow="Reference"
        title="Stripe decline code library"
        subtext="What each code means, why it happens, and how it gets recovered. No invented recovery-rate numbers, no platform history exists yet to project one from."
      />

      {/* Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /blog):
          the cards' accent edge and the focus ring read the family. */}
      <div
        className="fh-cap mx-auto max-w-5xl px-4 pb-16 sm:px-8"
        data-cap-site="foxhound"
        data-family="amber"
      >
        {byCategory.map((group) => (
          <section key={group.category} className="border-b border-border-sub py-8 last:border-0">
            <div className="mb-4 flex items-center gap-2">
              <h2 className="text-title font-medium text-text">{CATEGORY_LABEL[group.category]}</h2>
              <Pill {...BADGE_PILL[categoryBadgeTone(group.category)]}>
                {CATEGORY_STATUS_LABEL[group.category]}
              </Pill>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.codes.map((code) => (
                <Link
                  key={code.code}
                  to={`/decline-codes/${code.code}`}
                  className={`${CARD_SM} group`}
                >
                  <div className="cap-panel-body">
                    <div>
                      <div className="mb-2 font-mono text-label font-medium text-text">
                        {code.displayName}
                      </div>
                      <div className="mb-3 font-mono text-micro text-text-tertiary">
                        {code.code}
                      </div>
                      <div className="text-label text-brand-text">
                        Read more <Arrow />
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
