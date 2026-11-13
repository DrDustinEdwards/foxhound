import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Eyebrow } from "capsomer/react/eyebrow";
import { FeatureBlock, Features } from "capsomer/react/feature";
import { ProcessSteps } from "capsomer/react/process";
import { Pill } from "capsomer/react/status";
import { Link } from "capsomer/react/link";
import { appLinkRel } from "~/lib/marketing/app-links";
import { FaqList } from "~/components/faq-list";

import "capsomer/eyebrow.css";
import "capsomer/feature.css";
import "capsomer/panel.css";
import "capsomer/process.css";
import "capsomer/button.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family (capbase layer), which every part
// below reads. The site header loads the same file; importing it here keeps
// the page whole under any layout.
import "~/site-header.css";

// The /product spoke sections built from Capsomer's parts. Recova's
// spec is components/product/ProductSections.tsx (blob ba3aed7c) and
// components/product/ProductFAQ.tsx (blob 7c08a5a2), read whole: the same six
// sections, in the same order, at Recova's five container widths (680 hero,
// 760 how it works, 1100 feature blocks, 480 pricing and closing) and its
// 620px FAQ.
//
// All four spokes render from this file. It began as a second file beside the
// pre-Capsomer product-sections.tsx while each spoke's job moved it here; the
// audit spoke was the last, and the old file and its product-faq.tsx went
// with it.
//
// Look is Capsomer's: buttons, panels, badges, the FAQ's disclosure, the
// eyebrow, the process steps and the feature blocks (Capsomer 0.132.0). Text is at
// Recova's sizes, accents amber. Recova's card padding and button heights are
// set through Capsomer's own variables (--pad-card, --cap-btn-h), not by CSS
// laid over its parts.

interface CTA {
  href: string;
  label: string;
}

/** A Capsomer primary button that is a link, at the large size. */
function PrimaryLink({ cta }: { cta: CTA }) {
  return (
    <Link
      to={cta.href}
      rel={appLinkRel(cta.href)}
      className="cap-btn px-6 [--cap-btn-h:3rem]"
      data-variant="primary"
      data-size="lg"
    >
      {cta.label}
    </Link>
  );
}

/** A section's name: Capsomer's eyebrow as the section heading, centered, as Recova's. */
function SectionLabel({
  children,
  className = "mb-10",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-center ${className}`}>
      <Eyebrow as="h2">{children}</Eyebrow>
    </div>
  );
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
        <div className="mb-6">
          <Pill variant="outline">
            <Icon className="h-3 w-3 flex-shrink-0 text-accent-text" strokeWidth={2} aria-hidden />
            {productName}
          </Pill>
        </div>
        {/* Recova's mechanism: a literal newline in the string is a line break. */}
        <h1 className="mb-4 whitespace-pre-line text-product-hero font-medium leading-[1.1] tracking-tight text-text">
          {headline}
        </h1>
        <p className="speakable-description mx-auto mb-3 max-w-[520px] text-product-sub leading-relaxed text-text-secondary">
          {sub}
        </p>
        <p className="mb-8 font-mono text-label text-text-tertiary">{pricing}</p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <PrimaryLink cta={primaryCTA} />
          {/* leading-6 keeps the link a 24px target. */}
          <Link
            to={secondaryCTA.href}
            className="group text-subhead leading-6 text-text-secondary transition-colors hover:text-text"
          >
            {secondaryCTA.label}{" "}
            <ArrowRight
              className="inline-block motion-safe:transition-transform duration-150 group-hover:translate-x-0.5"
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
        <SectionLabel>How it works</SectionLabel>
        <ProcessSteps steps={steps.map((step) => ({ title: step.title, text: step.body }))} />
      </div>
    </section>
  );
}

export interface ProductFeatureBlock {
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  ui: React.ReactNode;
  /** Recova's middle block: the whole block on a lifted surface. */
  lifted?: boolean;
  /** Recova's tall UI (a table): a window that scrolls, named here. */
  tallLabel?: string;
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
        <SectionLabel className="mb-16">{sectionLabel}</SectionLabel>
        {/* Recova's 96px between blocks. */}
        <div className="[--cap-features-gap:6rem]">
          <Features>
            {blocks.map((block) => (
              <FeatureBlock
                key={block.title}
                eyebrow={block.eyebrow}
                title={block.title}
                body={block.body}
                media={block.ui}
                scrollLabel={block.tallLabel}
                lifted={block.lifted}
              />
            ))}
          </Features>
        </div>
      </div>
    </section>
  );
}

export function ProductPricing({
  price,
  priceLabel,
  points,
  cta,
}: {
  price: string;
  priceLabel: string;
  points: string[];
  cta: CTA;
}) {
  return (
    <section className="border-b border-border bg-surface px-5 py-16 sm:px-8">
      <div className="mx-auto max-w-[480px]">
        <SectionLabel className="mb-8">Pricing</SectionLabel>
        {/* Recova's price card: the page ground on the surface band, p-8. */}
        <div className="cap-panel [--gap:2rem] [--pad-card:2rem] [--surface:var(--bg)]">
          <div className="cap-panel-body">
            <div>
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
              {/* Recova's button runs the card's width. A grid cell stretches
                  the button without a class on it. */}
              <div className="grid">
                <PrimaryLink cta={cta} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Recova's per-product FAQ: one question open at a time. Capsomer's disclosure
 * is a native details element, so sections sharing a name open one at a time
 * with no script, and every answer is in the HTML (conventions-web.md 6).
 */
export function ProductFAQ({ name, faqs }: { name: string; faqs: { q: string; a: string }[] }) {
  return (
    <section className="border-b border-border px-5 py-16 sm:px-8">
      <div className="mx-auto max-w-[620px]">
        <SectionLabel className="mb-8">Questions</SectionLabel>
        <FaqList name={name} faqs={faqs} />
      </div>
    </section>
  );
}

export function BottomCTA({
  title,
  sub,
  cta,
  note,
}: {
  title: string;
  sub: string;
  cta: CTA;
  note: string;
}) {
  return (
    <section className="px-5 py-20 text-center sm:px-8">
      <div className="mx-auto max-w-[480px]">
        <h2 className="mb-3 text-subsection font-medium tracking-tight text-text">{title}</h2>
        <p className="mb-8 text-subhead leading-relaxed text-text-secondary">{sub}</p>
        <PrimaryLink cta={cta} />
        <p className="mt-3 text-caption text-text-tertiary">{note}</p>
      </div>
    </section>
  );
}
