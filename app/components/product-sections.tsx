import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";

import { FadeUp } from "~/components/fade-up";
import { FaqAccordion } from "~/components/faq-accordion";

// Shared building blocks for the four /products/* pages, ported from legacy
// components/product/ProductSections.tsx (Phase 6 Pass 1). Each block is
// deliberately limited to at most one amber accent (the primary CTA
// button), per DESIGN.md's one-amber-per-card rule; the legacy version put
// amber on the icon, the price, and the CTA at once.

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
  headline: React.ReactNode;
  sub: string;
  pricing: string;
  primaryCTA: CTA;
  secondaryCTA: CTA;
}) {
  return (
    <section className="border-b border-border-sub px-4 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface2">
          <Icon className="h-5 w-5 text-text-secondary" strokeWidth={1.8} aria-hidden />
        </div>
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">{productName}</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-text sm:text-4xl">{headline}</h1>
        <p className="mt-4 max-w-xl text-body text-text-secondary">{sub}</p>
        <p className="mt-4 font-mono text-micro text-text-subtle">{pricing}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            to={primaryCTA.href}
            className="rounded-md bg-amber px-5 py-2.5 text-label font-semibold text-on-amber hover:bg-amber-dark"
          >
            {primaryCTA.label}
          </Link>
          <Link
            to={secondaryCTA.href}
            className="rounded-md border border-border-i px-5 py-2.5 text-label font-medium text-text-secondary hover:text-text"
          >
            {secondaryCTA.label}
          </Link>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks({ steps }: { steps: { title: string; body: React.ReactNode }[] }) {
  return (
    <section className="border-b border-border-sub px-4 py-16 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <h2 className="mb-8 text-center text-title font-medium text-text">How it works</h2>
        <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-surface sm:grid-cols-3">
          {steps.map((step, i) => (
            <div
              key={step.title}
              className={`p-6 ${i < steps.length - 1 ? "border-b border-border sm:border-b-0 sm:border-r" : ""}`}
            >
              <p className="font-mono text-micro text-text-subtle">Step {i + 1}</p>
              <p className="mt-2 text-body font-medium text-text">{step.title}</p>
              <p className="mt-2 text-label leading-relaxed text-text-secondary">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FeatureBlocks({
  sectionLabel,
  blocks,
}: {
  sectionLabel: string;
  blocks: { eyebrow: string; title: string; body: React.ReactNode; ui?: React.ReactNode }[];
}) {
  return (
    <section className="border-b border-border-sub px-4 py-16 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <p className="mb-8 text-center font-mono text-micro uppercase tracking-wide text-text-tertiary">
          {sectionLabel}
        </p>
        <div className="flex flex-col gap-6">
          {blocks.map((block) => (
            <FadeUp
              key={block.title}
              className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-surface sm:grid-cols-2"
            >
              <div className="flex flex-col justify-center p-6 sm:p-8">
                <p className="font-mono text-micro uppercase tracking-wide text-amber-text">
                  {block.eyebrow}
                </p>
                <h3 className="mt-2 text-title font-medium text-text">{block.title}</h3>
                <div className="mt-3 text-label leading-relaxed text-text-secondary">{block.body}</div>
              </div>
              {block.ui ? (
                <div className="flex items-center justify-center border-t border-border-sub bg-bg p-4 sm:border-l sm:border-t-0">
                  {block.ui}
                </div>
              ) : null}
            </FadeUp>
          ))}
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
    <section className="border-b border-border-sub px-4 py-16 sm:px-8">
      <div className="mx-auto max-w-2xl rounded-lg border border-border bg-surface p-8 text-center">
        <p className="font-mono text-display font-semibold text-text">{price}</p>
        <p className="mt-1 font-mono text-micro text-text-tertiary">{priceLabel}</p>
        <ul className="mx-auto mt-6 flex max-w-md flex-col gap-2.5 text-left text-label text-text-secondary">
          {points.map((point) => (
            <li key={point} className="flex items-start gap-2">
              <span
                className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-text-tertiary"
                aria-hidden
              />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <Link
          to={ctaHref}
          className="mt-8 inline-block rounded-md bg-amber px-6 py-3 text-body font-semibold text-on-amber hover:bg-amber-dark"
        >
          {ctaLabel}
        </Link>
      </div>
    </section>
  );
}

export function ProductFAQ({ faqs }: { faqs: { q: string; a: React.ReactNode }[] }) {
  return (
    <section className="border-b border-border-sub px-4 py-16 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-8 text-center text-title font-medium text-text">Questions</h2>
        <FaqAccordion faqs={faqs.map((f) => ({ question: f.q, answer: f.a }))} />
      </div>
    </section>
  );
}

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
    <section className="px-4 py-20 sm:px-8">
      <div className="mx-auto max-w-xl text-center">
        <h2 className="text-title font-medium text-text">{title}</h2>
        <p className="mt-3 text-body text-text-secondary">{sub}</p>
        <Link
          to={ctaHref}
          className="mt-6 inline-block rounded-md bg-amber px-6 py-3 text-body font-semibold text-on-amber hover:bg-amber-dark"
        >
          {ctaLabel}
        </Link>
        <p className="mt-4 font-mono text-micro text-text-subtle">{note}</p>
      </div>
    </section>
  );
}
