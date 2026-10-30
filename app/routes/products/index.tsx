import { ArrowRight, RefreshCw, ScanSearch, Shield, TrendingUp } from "lucide-react";
import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import { HUB_COPY } from "~/lib/marketing/products-hub";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// accent text and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";

// The /products hub (J16, row M5). Recova's spec is app/(marketing)/products/page.tsx
// (blob 1349c46e) and lib/products.ts (blob 6be24574), read whole.
//
// Layout is Recova's: the shared page header, the 720px column, the two-column
// grid at sm, and the four cards in Recova's order. Look is Capsomer's (Q12):
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
// since J09 (rulings 55 and 56).

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Products - Foxhound",
    description:
      "Audit, Recovery, Disputes, and Intelligence. Four products that recover failed Stripe payments, fight chargebacks, and predict customer churn.",
    path: "/products",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

const ICONS = {
  audit: ScanSearch,
  recovery: RefreshCw,
  disputes: Shield,
  intelligence: TrendingUp,
} as const;

export default function ProductsIndexPage() {
  return (
    <>
      <MarketingPageHeader eyebrow="Products" title="Four products" subtext="Use them independently or together." />

      {/* div, not main: marketing.tsx already renders this page's one main landmark.
          Recova's 720px column, in Capsomer's amber family with Foxhound's own
          neutrals (.fh-cap, as the site header and the legal pages); the focus
          ring reads the family's amber ring here, as in Capsomer's own parts. */}
      <div
        className="fh-cap mx-auto max-w-[720px] px-5 pb-16 sm:px-8 [--border-focus:var(--ring)]" data-cap-site="foxhound"
        data-family="amber"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PRODUCT_ORDER.map((key) => {
            const p = PRODUCTS[key];
            const copy = HUB_COPY[key];
            const Icon = ICONS[key];
            return (
              // Capsomer's linked panel, the whole-card link Recova draws. "group"
              // carries no style; it drives the arrow's nudge below.
              <Link key={key} to={p.href} className="cap-panel group rounded-lg [--gap:1.25rem] [--pad-card:1.25rem]">
                <div className="cap-panel-body">
                  {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
                  <div>
                    <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface2">
                      <Icon className="h-[18px] w-[18px] text-accent-text" strokeWidth={1.8} aria-hidden />
                    </div>
                    <div className="mb-2 text-item-title font-medium text-text">{p.name}</div>
                    <div className="mb-3 text-label leading-relaxed text-text-secondary">{copy.description}</div>
                    <div className="mb-4 font-mono text-label text-accent-text">{copy.price}</div>
                    <div className="text-label text-accent-text">
                      Learn more{" "}
                      <ArrowRight
                        className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                        size={13}
                        strokeWidth={1.5}
                        aria-hidden
                      />
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
