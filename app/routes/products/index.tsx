import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { PRODUCT_ICONS } from "~/components/home-parts";
import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import { HUB_COPY } from "~/lib/marketing/products-hub";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the accent text and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";
import "~/products.css";

// The /products hub: the shared page header, the 720px column, the two-column grid at sm, and the four cards. Each card is Capsomer's linked panel in the amber family (p-5, 8px corners, the 4px lift and amber edge under the pointer). Every number is read from Foxhound's pricing constants (lib/marketing/products-hub.ts). Spoke hrefs come from lib/marketing/products.ts (/product/*).

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Recovery, disputes and churn tools for Stripe",
    description:
      "Audit, Recovery, Disputes, and Intelligence. Four products that recover failed Stripe payments, fight chargebacks, and predict customer churn.",
    path: "/products",
    pageType: "CollectionPage",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export const loader = siteUrlLoader;

export default function ProductsIndexPage() {
  return (
    <>
      <MarketingPageHeader title="Four products" />

      <div className="fh-products-wrap fh-cap" data-cap-site="foxhound" data-family="amber">
        <div className="fh-mk-cards-2">
          {PRODUCT_ORDER.map((key) => {
            const p = PRODUCTS[key];
            const copy = HUB_COPY[key];
            const icon = PRODUCT_ICONS[key];
            return (
              // Capsomer's linked panel, the whole-card link. "group" carries no style; it drives the arrow's nudge below.
              <Link key={key} to={p.href} className="fh-mk-card cap-panel fh-hover-group">
                <div className="cap-panel-body">
                  <div>
                    <div className="fh-mk-tile-icon">
                      <Icon d={icon} className="fh-icon-18 fh-icon-180 fh-brand" />
                    </div>
                    <div className="fh-products-block fh-item-title fh-medium fh-text">
                      {p.name}
                    </div>
                    <div className="fh-mb-4 fh-small fh-relaxed fh-soft">{copy.description}</div>
                    <div className="fh-mb-5 fh-mono fh-small fh-brand">{copy.price}</div>
                    <div className="fh-small fh-brand">
                      Learn more{" "}
                      <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}

export const headers = () => publicPageHeaders();
