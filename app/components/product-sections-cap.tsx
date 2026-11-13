import { Icon, iconArrowRight } from "capsomer/react/icons";
import { CtaBand } from "capsomer/react/cta-band";
import { Hero } from "capsomer/react/hero";
import { Pill } from "capsomer/react/status";
import { Link, ButtonLink } from "capsomer/react/link";
import { appLinkRel } from "~/lib/marketing/app-links";
import { CTA_BUTTON } from "~/components/marketing-card";
import { FaqList } from "~/components/faq-list";

import "capsomer/cta-band.css";
import "capsomer/hero.css";
import "capsomer/panel.css";
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
// Look is Capsomer's: buttons, panels, badges, the FAQ's disclosure. Text is at
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
        <h2 className="fh-product-title-2 fh-center fh-tiny fh-medium fh-quiet fh-caps-wide">
          How it works
        </h2>
        <ol className="fh-product-grid">
          {steps.map((step, i) => (
            <li key={step.title}>
              <div className="fh-product-block-2 fh-mono fh-tiny fh-accent" aria-hidden="true">
                0{i + 1}
              </div>
              <h3 className="fh-product-title-3 fh-item-title fh-medium fh-text">{step.title}</h3>
              <p className="fh-copy fh-relaxed fh-soft">{step.body}</p>
            </li>
          ))}
        </ol>
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
  /** Recova's tall UI (a table): a 480px window that scrolls, named here. */
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
        <div className="fh-product-block-3 fh-center">
          <h2 className="fh-tiny fh-medium fh-quiet fh-caps-wide">{sectionLabel}</h2>
        </div>
        <div className="fh-product-block-4">
          {blocks.map((block) => {
            const kind = block.lifted ? "lifted" : block.tallLabel ? "tall" : "plain";
            const inner = (
              <div className="fh-product-block-5">
                <div className="fh-product-wrap-3 fh-center">
                  <div className="fh-product-block-2 fh-tiny fh-medium fh-accent fh-caps-wide">
                    {block.eyebrow}
                  </div>
                  <h3 className="fh-product-title-4 fh-feature-title fh-medium fh-text">
                    {block.title}
                  </h3>
                  <p className="fh-subhead fh-relaxed fh-soft">{block.body}</p>
                </div>
                {/* Recova's UI card: a bordered surface with no padding of its
                    own, so each preview sets its own, as Recova's do. */}
                <div className="cap-panel">
                  <div className="cap-panel-body" data-flush>
                    {block.tallLabel ? (
                      // A window that scrolls is a stop for the keyboard, named
                      // for what it holds (Recova's has neither).
                      <div
                        role="region"
                        aria-label={block.tallLabel}
                        tabIndex={0}
                        className="fh-product-block-6"
                      >
                        {block.ui}
                      </div>
                    ) : (
                      block.ui
                    )}
                  </div>
                </div>
              </div>
            );
            if (block.lifted) {
              return (
                // Recova's lifted block: p-8 and 16px corners.
                <div key={block.title} className="fh-product-block-7 cap-panel" data-block={kind}>
                  <div className="cap-panel-body">{inner}</div>
                </div>
              );
            }
            return (
              <div key={block.title} data-block={kind}>
                {inner}
              </div>
            );
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
        <h2 className="fh-product-text fh-center fh-tiny fh-medium fh-quiet fh-caps-wide">
          Pricing
        </h2>
        {/* Recova's price card: the page ground on the surface band, p-8. */}
        <div className="fh-product-block-8 cap-panel">
          <div className="cap-panel-body">
            <div>
              <div className="fh-product-block-9 fh-mono fh-product-price fh-medium fh-tight fh-text">
                {price}
              </div>
              <div className="fh-product-block fh-copy fh-soft">{priceLabel}</div>
              <ul className="fh-product-list">
                {points.map((point) => (
                  <li key={point} className="fh-mk-point-wide fh-copy fh-soft">
                    <span aria-hidden="true" className="fh-product-label fh-green">
                      &#10003;
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              {/* Recova's button runs the card's width. A grid cell stretches
                  the button without a class on it. */}
              <div className="fh-product-grid-2">
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
    <section className="fh-product-band-2">
      <div className="fh-product-wrap-4">
        <h2 className="fh-product-text fh-center fh-tiny fh-medium fh-quiet fh-caps-wide">
          Questions
        </h2>
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

/** The home and pricing pages' closing button: Recova's 48px "Connect Stripe" at 1rem, in the
 *  comfortable density. */
export function ConnectStripeAction() {
  return (
    <div className="fh-density" data-density="comfortable">
      <ButtonLink to="/audit" className={CTA_BUTTON} variant="primary" size="lg">
        Connect Stripe, it is free
      </ButtonLink>
    </div>
  );
}
