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
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// accent text and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";
import "~/products.css";

// The /products hub. Recova's spec is app/(marketing)/products/page.tsx
// (blob 1349c46e) and lib/products.ts (blob 6be24574), read whole.
//
// Layout is Recova's: the shared page header, the 720px column, the two-column
// grid at sm, and the four cards in Recova's order. Look is Capsomer's:
// each card is Capsomer's linked panel in the amber family at Recova's sizes
// (p-5, 8px corners, the 4px lift and amber edge under the pointer), amber
// throughout.
//
// Copy is Recova's word for word, with every number read from Foxhound's
// pricing constants and one truthfulness fix; both are in
// lib/marketing/products-hub.ts. The copy was frozen here for ruling 20d (now
// RULES.md 2.2); the October build plan lists M5's card copy as J16's open
// work, no longer as frozen, so this job carries it and the seat's read of the
// diff decides whether it stands.
//
// Spoke hrefs come from lib/marketing/products.ts and are Recova's /product/*
// since J09.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Products",
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
      <MarketingPageHeader
        eyebrow="Products"
        title="Four products"
        subtext="Use them independently or together."
      />

      {/* div, not main: marketing.tsx already renders this page's one main landmark.
          Recova's 720px column, in Capsomer's amber family with Foxhound's own
          neutrals (.fh-cap, as the site header and the legal pages); the focus
          ring reads the family's amber ring here, as in Capsomer's own parts. */}
      <div className="fh-products-wrap fh-cap" data-cap-site="foxhound" data-family="amber">
        <div className="fh-mk-cards-2">
          {PRODUCT_ORDER.map((key) => {
            const p = PRODUCTS[key];
            const copy = HUB_COPY[key];
            const icon = PRODUCT_ICONS[key];
            return (
              // Capsomer's linked panel, the whole-card link Recova draws. "group"
              // carries no style; it drives the arrow's nudge below.
              <Link key={key} to={p.href} className="fh-mk-card cap-panel fh-hover-group">
                <div className="cap-panel-body">
                  {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
                  <div>
                    <div className="fh-mk-tile-icon">
                      <Icon d={icon} className="fh-icon-18 fh-icon-180 fh-accent" />
                    </div>
                    <div className="fh-products-block fh-item-title fh-medium fh-text">
                      {p.name}
                    </div>
                    <div className="fh-products-block-2 fh-small fh-relaxed fh-soft">
                      {copy.description}
                    </div>
                    <div className="fh-products-block-3 fh-mono fh-small fh-accent">
                      {copy.price}
                    </div>
                    <div className="fh-small fh-accent">
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
