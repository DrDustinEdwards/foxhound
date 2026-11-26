import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Pill } from "capsomer/react/status";
import "capsomer/status.css";
import { Link } from "capsomer/react/link";
import "capsomer/panel.css";

import { BADGE_PILL } from "~/lib/recovery/labels";
import { CARD_SM } from "~/components/marketing-card";
import { Arrow } from "~/components/home-parts";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  DECLINE_CODES_PATH,
  declineCodePath,
  listDeclineCodeViews,
} from "~/lib/decline-codes/codes";
import { CATEGORY_STATUS_LABEL, categoryBadgeTone } from "~/lib/decline-codes/presentation";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/index";
import "~/reference.css";

// The decline-code reference library hub. Cards are grouped by classification category (soft/network/expired/fraud), which mirrors what determines recovery behavior (app/lib/recovery/decline.ts), rather than alphabetically.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Stripe Decline Code Library",
      description:
        "What every major Stripe decline code means, why it happens, and how it gets recovered. Grouped by soft, network, expired, and fraud classifications.",
      path: DECLINE_CODES_PATH,
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
      <MarketingPageHeader title="Stripe decline code library" />

      {/* Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /blog):
          the cards' accent edge and the focus ring read the family. */}
      <div className="fh-mk-page fh-cap" data-cap-site="foxhound" data-family="amber">
        {byCategory.map((group) => (
          <section key={group.category} className="fh-codes-band">
            <div className="fh-codes-row">
              <h2 className="fh-title fh-medium fh-text">{CATEGORY_LABEL[group.category]}</h2>
              <Pill {...BADGE_PILL[categoryBadgeTone(group.category)]}>
                {CATEGORY_STATUS_LABEL[group.category]}
              </Pill>
            </div>
            <div className="fh-mk-cards-3">
              {group.codes.map((code) => (
                <Link key={code.code} to={declineCodePath(code.code)} className={`${CARD_SM}`}>
                  <div className="cap-panel-body">
                    <div>
                      <div className="fh-codes-block fh-mono fh-small fh-medium fh-text">
                        {code.displayName}
                      </div>
                      <div className="fh-codes-block-2 fh-mono fh-tiny fh-quiet">{code.code}</div>
                      <div className="fh-small fh-brand">
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
