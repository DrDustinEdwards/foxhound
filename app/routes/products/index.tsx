import { ArrowRight, RefreshCw, ScanSearch, Shield, TrendingUp } from "lucide-react";
import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { PRODUCTS } from "~/lib/marketing/products";

// Ported from legacy app/(marketing)/products/page.tsx (Phase 6 Pass 1).
// This is now the single /products/* index (task: collapse legacy's three
// duplicate trees, /product/*, /products, /features, onto one pattern).

export function meta() {
  return [
    { title: "Products - Foxhound" },
    {
      name: "description",
      content:
        "Audit, Recovery, Disputes, and Intelligence. Four products that recover failed Stripe payments, resolve disputes with a human sign-off, and surface churn risk.",
    },
  ];
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

      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Object.values(PRODUCTS).map((p) => {
            const Icon = ICONS[p.key];
            return (
              <Link
                key={p.key}
                to={p.href}
                className="group block rounded-lg border border-border bg-surface p-5 hover:border-border-i"
              >
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface2">
                  <Icon className="h-[18px] w-[18px] text-text-secondary" strokeWidth={1.8} aria-hidden />
                </div>
                <div className="mb-2 text-body font-medium text-text">{p.name}</div>
                <div className="mb-3 text-label leading-relaxed text-text-secondary">{p.description}</div>
                <div className="mb-4 font-mono text-label text-text">
                  {p.price}
                  {p.priceLabel ? <span className="text-text-tertiary"> {p.priceLabel}</span> : null}
                </div>
                <div className="text-label text-amber-text">
                  Learn more{" "}
                  <ArrowRight
                    className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </>
  );
}
