import { ArrowRight, RefreshCw, ScanSearch, Shield, TrendingUp } from "lucide-react";
import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
// Capsomer's tokens and the teal family (capbase layer), which the panel, the
// accent text and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";

// Ported from legacy app/(marketing)/products/page.tsx (Phase 6 Pass 1),
// treatment restored to legacy by the M5 parity walk (2026-07-29).
//
// The Phase 6 note that used to sit here, that this is "the single /products/*
// index" collapsing legacy's three trees, is REVOKED: ruling 55 reverts the
// spoke URLs to legacy's /product/*, and the hrefs in lib/marketing/products.ts
// change in that commit, not this one.
//
// Card descriptions, prices and the meta description all diverge from legacy
// and all carry product-capability or pricing claims, so they are FROZEN for
// ruling 20d's copy-accuracy pass and are deliberately untouched here. The
// price/priceLabel split is the same: legacy renders one accent mono string,
// Foxhound splits the claim across two elements. Only the price element's
// COLOR is a treatment item, and that is what this walk fixed.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Products - Foxhound",
    description:
      "Audit, Recovery, Disputes, and Intelligence. Four products that recover failed Stripe payments, resolve disputes with a human sign-off, and surface churn risk.",
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
          Recova's 720px column, in Capsomer's teal family with Foxhound's own
          neutrals (.fh-cap, as the site header and the legal pages); the focus
          ring reads the family's teal ring here, as in Capsomer's own parts. */}
      <div
        className="fh-cap mx-auto max-w-[720px] px-5 pb-16 sm:px-8 [--border-focus:var(--ring)]"
        data-family="teal"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PRODUCT_ORDER.map((key) => {
            const p = PRODUCTS[key];
            const Icon = ICONS[key];
            return (
              // Capsomer's panel, body only, as the whole-card link Recova draws.
              // Capsomer has no link card yet: no hover lift or hover border,
              // which Recova has (see the PR notes, a Capsomer job to post).
              // "group" carries no style; it drives the arrow's nudge below.
              <Link key={key} to={p.href} className="cap-panel group">
                <div className="cap-panel-body">
                  {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
                  <div>
                    <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface2">
                      <Icon className="h-[18px] w-[18px] text-accent-text" strokeWidth={1.8} aria-hidden />
                    </div>
                    <div className="mb-2 text-body font-medium text-text">{p.name}</div>
                    <div className="mb-3 text-label leading-relaxed text-text-secondary">{p.description}</div>
                    <div className="mb-4 font-mono text-label text-accent-text">
                      {p.price}
                      {p.priceLabel ? <span className="text-text-tertiary"> {p.priceLabel}</span> : null}
                    </div>
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
