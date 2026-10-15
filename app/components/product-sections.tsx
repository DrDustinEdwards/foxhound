import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";

// Shared building blocks for the four /product/* pages, ported from legacy
// components/product/ProductSections.tsx. All four spokes delegate every pixel
// of chrome to this file, exactly as legacy's own header comment says they do,
// so a change here reaches M6 to M9 at once.
//
// Ruling 67 (Dustin, 2026-07-29): the accents legacy puts on the hero
// pill icon, the step numerals and the pricing checkmarks are RESTORED. This
// file previously recorded dropping them as deliberate, citing DESIGN.md's
// one-accent-per-card rule. That rule was itself ported from legacy's color
// system, so where legacy's shipped pages exceed it, legacy shipped the render,
// and the render is the spec.
//
// Ruling 60's fifth data point lives here too: legacy runs FIVE container
// widths inside this ONE component (680 hero, 760 how-it-works, 1100 feature
// blocks, 480 pricing, 480 bottom CTA). The width check is per-SECTION, not
// merely per-surface. Do not collapse these onto a shared value.
//
// ProductFAQ below is deliberately NOT ported: legacy components/product/
// ProductFAQ.tsx has not been read, and ruling 63 governs (match legacy per
// surface; a faithful component does not license applying it where legacy did
// not). It keeps its pre-walk treatment until that file is read.

interface CTA {
  href: string;
  label: string;
}

export function ProductHero({
  productName,
  Icon,
  headline,
  sub,
  pricing,
  primaryCTA,
  secondaryCTA,
}: {
  productName: string;
  Icon: LucideIcon;
  headline: string;
  sub: string;
  pricing: string;
  primaryCTA: CTA;
  secondaryCTA: CTA;
}) {
  return (
    <section className="speakable-hero border-b border-border px-5 py-20 text-center sm:px-8">
      <div className="mx-auto max-w-[680px]">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 font-mono text-micro font-medium text-text-tertiary">
          <Icon className="h-3 w-3 flex-shrink-0 text-brand-text" strokeWidth={2} aria-hidden />
          {productName}
        </div>
        {/* whitespace-pre-line is legacy's mechanism: a headline opts into a
            line break by embedding a literal newline in a plain string.
            Divergence 7 is NOT closed, and cannot be by reverting the prop
            type. Foxhound's recovery and intelligence spokes embed an inline
            <span className="font-mono"> inside the headline, which legacy's
            string contract cannot express, so tightening this to string would
            silently strip mono treatment from two pages this walk has not read.
            Whether legacy's own recovery and intelligence headlines carry those
            spans is an M7/M9 question. The class stays because a string
            headline (audit passes one) uses it exactly as legacy does. */}
        <h1 className="mb-4 whitespace-pre-line text-product-hero font-medium leading-[1.1] tracking-tight text-text">
          {headline}
        </h1>
        <p className="speakable-description mx-auto mb-3 max-w-[520px] text-product-sub leading-relaxed text-text-secondary">
          {sub}
        </p>
        <p className="mb-8 font-mono text-label text-text-tertiary">{pricing}</p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            to={primaryCTA.href}
            className="btn-primary inline-flex items-center gap-2 rounded-lg px-6 py-3 text-subhead font-medium text-on-brand"
          >
            {primaryCTA.label}
          </Link>
          <Link
            to={secondaryCTA.href}
            className="group text-subhead text-text-secondary transition-colors hover:text-text"
          >
            {secondaryCTA.label}{" "}
            <ArrowRight
              className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
              size={13}
              strokeWidth={1.5}
              aria-hidden
            />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks({ steps }: { steps: { title: string; body: React.ReactNode }[] }) {
  return (
    <section className="border-b border-border px-5 py-16 sm:px-8">
      <div className="mx-auto max-w-[760px]">
        <h2 className="mb-10 text-center text-micro font-medium uppercase tracking-widest text-text-tertiary">
          How it works
        </h2>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          {steps.map((step, i) => (
            <div key={step.title}>
              <div className="mb-3 font-mono text-micro text-brand-text">0{i + 1}</div>
              <h3 className="mb-2 text-item-title font-medium text-text">{step.title}</h3>
              <p className="text-copy leading-relaxed text-text-secondary">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export interface ProductFeatureBlock {
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  ui?: React.ReactNode;
  // Wraps the whole block (text + UI) in a lifted surface card. Legacy uses it
  // on the middle block of each spoke so the section reads as three beats with
  // the centre elevated.
  lifted?: boolean;
  // Tall UI (payments table, disputes table). Adds a fixed max-height with
  // vertical scroll so the page does not chase the table height, and pins
  // horizontal overflow off so the inner table cannot leak sideways.
  tall?: boolean;
}

export function FeatureBlocks({
  sectionLabel,
  blocks,
}: {
  sectionLabel: string;
  blocks: ProductFeatureBlock[];
}) {
  return (
    <section className="speakable-features border-b border-border px-5 py-20 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-16 text-center">
          <h2 className="text-micro font-medium uppercase tracking-widest text-text-tertiary">
            {sectionLabel}
          </h2>
        </div>
        <div className="space-y-24">
          {blocks.map((block) => {
            // overflow-hidden is the always-on clip for the inner card's
            // rounded corners; tall blocks also override the y-axis to auto so
            // they scroll instead of growing the page. Tailwind emits the
            // longhand after the shorthand, so the longhand wins.
            const uiClass = `bg-surface border border-border rounded-xl overflow-hidden${
              block.tall ? " max-h-[480px] overflow-y-auto overflow-x-hidden" : ""
            }`;
            const inner = (
              <div className="space-y-6">
                <div className="mx-auto max-w-[640px] text-center">
                  <div className="mb-3 text-micro font-medium uppercase tracking-widest text-brand-text">
                    {block.eyebrow}
                  </div>
                  <h3 className="mb-3 text-feature-title font-medium leading-snug text-text">
                    {block.title}
                  </h3>
                  <p className="text-subhead leading-relaxed text-text-secondary">{block.body}</p>
                </div>
                {block.ui ? <div className={uiClass}>{block.ui}</div> : null}
              </div>
            );

            if (block.lifted) {
              return (
                <div key={block.title} className="rounded-2xl border border-border bg-surface p-8">
                  {inner}
                </div>
              );
            }
            return <div key={block.title}>{inner}</div>;
          })}
        </div>
      </div>
    </section>
  );
}

export function ProductPricing({
  price,
  priceLabel,
  points,
  ctaHref,
  ctaLabel,
}: {
  price: string;
  priceLabel: string;
  points: string[];
  ctaHref: string;
  ctaLabel: string;
}) {
  return (
    <section className="border-b border-border bg-surface px-5 py-16 sm:px-8">
      <div className="mx-auto max-w-[480px]">
        <h2 className="mb-8 text-center text-micro font-medium uppercase tracking-widest text-text-tertiary">
          Pricing
        </h2>
        <div className="rounded-xl border border-border bg-bg p-8">
          <div className="mb-1 font-mono text-product-price font-medium leading-none text-text">
            {price}
          </div>
          <div className="mb-6 text-copy text-text-secondary">{priceLabel}</div>
          <ul className="m-0 mb-8 list-none space-y-3 p-0">
            {points.map((point) => (
              <li key={point} className="flex items-start gap-3 text-copy text-text-secondary">
                <span aria-hidden="true" className="mt-0.5 flex-shrink-0 text-green">
                  &#10003;
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <Link
            to={ctaHref}
            className="btn-primary block w-full rounded-lg px-6 py-3 text-center text-subhead font-medium text-on-brand"
          >
            {ctaLabel}
          </Link>
        </div>
      </div>
    </section>
  );
}

// Re-exported from ./product-faq, mirroring legacy's own barrel re-export of
// components/product/ProductFAQ.tsx. Divergence 38 CLOSED: legacy's per-product
// accordion is a different component from its home-page one, and the spokes now
// render the per-product one. See product-faq.tsx for why.
export { ProductFAQ } from "~/components/product-faq";

export function BottomCTA({
  title,
  sub,
  ctaHref,
  ctaLabel,
  note,
}: {
  title: string;
  sub: string;
  ctaHref: string;
  ctaLabel: string;
  note: string;
}) {
  return (
    <section className="px-5 py-20 text-center sm:px-8">
      <div className="mx-auto max-w-[480px]">
        <h2 className="mb-3 text-subsection font-medium tracking-tight text-text">{title}</h2>
        <p className="mb-8 text-subhead leading-relaxed text-text-secondary">{sub}</p>
        <Link
          to={ctaHref}
          className="btn-primary inline-flex items-center gap-2 rounded-lg px-6 py-3 text-subhead font-medium text-on-brand"
        >
          {ctaLabel}
        </Link>
        <p className="mt-3 text-caption text-text-tertiary">{note}</p>
      </div>
    </section>
  );
}
