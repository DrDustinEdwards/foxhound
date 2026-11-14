import { Eyebrow } from "capsomer/react/eyebrow";
import { FeatureBlock, Features } from "capsomer/react/feature";
import { Icon, iconArrowRight } from "capsomer/react/icons";
import { PriceCard, PriceGrid } from "capsomer/react/price-card";
import { ProcessSteps } from "capsomer/react/process";
import { CtaBand } from "capsomer/react/cta-band";
import { Hero } from "capsomer/react/hero";
import { Pill } from "capsomer/react/status";
import { Link, ButtonLink } from "capsomer/react/link";
import { appLinkRel } from "~/lib/marketing/app-links";
import { FaqList } from "~/components/faq-list";

import "capsomer/eyebrow.css";
import "capsomer/feature.css";
import "capsomer/cta-band.css";
import "capsomer/hero.css";
import "capsomer/panel.css";
import "capsomer/price-card.css";
import "capsomer/process.css";
import "capsomer/button.css";
import "capsomer/status.css";
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
// eyebrow, the process steps and the feature blocks. Text is at
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
    <ButtonLink
      to={cta.href}
      rel={appLinkRel(cta.href)}
      className="fh-mk-big-button"
      variant="primary"
      size="lg"
    >
      {cta.label}
    </ButtonLink>
  );
}

/** A section's name: Capsomer's eyebrow as the section heading, centered, as Recova's. */
function SectionLabel({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <Eyebrow as="h2" className={`${className} fh-center`}>
      {children}
    </Eyebrow>
  );
}

export function ProductHero({
  productName,
  icon,
  headline,
  sub,
  pricing,
  primaryCTA,
  secondaryCTA,
}: {
  productName: string;
  icon: string;
  headline: string;
  sub: string;
  pricing: string;
  primaryCTA: CTA;
  secondaryCTA: CTA;
}) {
  return (
    <Hero
      className="speakable-hero fh-product-hero"
      align="center"
      eyebrow={
        <Pill variant="outline">
          <Icon d={icon} className="fh-product-icon fh-accent" />
          {productName}
        </Pill>
      }
      title={headline}
      lead={<span className="speakable-description">{sub}</span>}
      actions={
        <>
          <PrimaryLink cta={primaryCTA} />
          {/* leading-6 keeps the link a 24px target. */}
          <Link
            to={secondaryCTA.href}
            className="fh-mk-quiet-link fh-hover-group fh-subhead fh-soft"
          >
            {secondaryCTA.label}{" "}
            <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
          </Link>
        </>
      }
    >
      <p className="fh-mono fh-small fh-quiet">{pricing}</p>
    </Hero>
  );
}

export function HowItWorks({ steps }: { steps: { title: string; body: React.ReactNode }[] }) {
  return (
    <section className="fh-product-band-2">
      <div className="fh-mk-wrap-text">
        <SectionLabel className="fh-product-title-2">How it works</SectionLabel>
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
    <section className="fh-product-band speakable-features">
      <div className="fh-mk-wrap">
        <SectionLabel className="fh-product-block-3">{sectionLabel}</SectionLabel>
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
    <section className="fh-product-band-3">
      <div className="fh-mk-lede">
        <SectionLabel className="fh-product-text">Pricing</SectionLabel>
        {/* Recova's price card: the page ground on the surface band, p-8 (products.css). */}
        <PriceGrid>
          <PriceCard
            price={price}
            label={priceLabel}
            points={points}
            action={<PrimaryLink cta={cta} />}
          />
        </PriceGrid>
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
    <section className="fh-product-band-2">
      <div className="fh-product-wrap-4">
        <SectionLabel className="fh-product-text">Questions</SectionLabel>
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
    <CtaBand
      quiet
      className="fh-closing-band fh-closing-product"
      title={title}
      actions={<PrimaryLink cta={cta} />}
      note={note}
    >
      {sub}
    </CtaBand>
  );
}
