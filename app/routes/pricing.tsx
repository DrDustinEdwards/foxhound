import { ArrowRight, Check } from "lucide-react";
import { Link } from "react-router";

import { CARD, CTA_BUTTON } from "~/components/marketing-card";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { PRICING_CARDS, PRICING_FAQS, PRICING_META_DESCRIPTION } from "~/lib/marketing/pricing-copy";
import { PRODUCTS } from "~/lib/marketing/products";
import { faqPageJsonLd, siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/button.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// button, the accent text and the focus ring read. The site header loads the
// same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/pricing";

// /pricing (J54, row M4). Recova's spec is app/(marketing)/pricing/page.tsx
// (blob 8e91e160), read whole.
//
// Layout is Recova's: the shared page header, the 1200px card container on a
// 1/2/4 column grid with gap-4, each card's order (name, price, price label or
// a blank line, description, check list, Learn more), the 760px FAQ under its
// "Questions" h2, and the 760px closing block with its 560px line. Look is
// Capsomer's (RULES.md 1.1): the page sits in Capsomer's amber family with
// Foxhound's own neutrals (.fh-cap, as the site header, the legal pages and the
// /products hub), each card and FAQ item is Capsomer's panel, and the closing
// link is Capsomer's primary button.
//
// Text is at Recova's sizes: card name 1.125rem, price 2.5rem, price label and
// closing microcopy 0.75rem, description, bullets and Learn more 0.8125rem, the
// h2s 1.5rem to 1.75rem and 1.75rem to 2rem, FAQ question and closing line
// 0.9375rem, FAQ answer 0.875rem.
//
// Headings: Recova draws the card names and the FAQ questions as plain divs.
// Here they are h2 and h3, so a screen reader can move between the plans and
// the questions (RULES.md 1.5 allows an accessibility improvement); the page
// keeps one h1 and never skips a level. The look is unchanged.
//
// Copy, frozen for the claims pass, and every number in it, read from the
// engine constants, are in lib/marketing/pricing-copy.ts.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Pricing - Foxhound",
    description: PRICING_META_DESCRIPTION,
    path: "/pricing",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function PricingPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url } = loaderData;

  return (
    // Capsomer's amber family with Foxhound's neutrals. Foxhound's global focus
    // ring reads --border-focus (app.css); inside this page it reads the
    // family's --ring, so a keyboard user sees amber as in Capsomer's own parts.
    <div className="fh-cap [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      <MarketingPageHeader
        eyebrow="Pricing"
        title="Pricing"
        subtext="Two outcome-based products and one flat subscription with a free tier. Audit is always free."
      />

      {/* Legacy's pricing card grid is max-w-[1200px], NOT the 1100px the home
          page uses. The container width is a per-page value, not a site-wide
          constant, which is why ruling 60 says check it per surface rather than
          bulk-replacing max-w-5xl everywhere.

          Each card is Capsomer's panel at Recova's p-6 and 12px corners, with
          Recova's card shadow from Foxhound's site layer. The id and Recova's
          60px scroll margin sit on a wrapper so the panel carries no Foxhound
          class; the wrapper is a one-cell grid so the panel fills the row. */}
      <section className="speakable-pricing-cards px-5 pb-12 sm:px-8">
        <div className="mx-auto max-w-[1200px]">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRICING_CARDS.map((card) => (
              <div key={card.id} id={card.id} className="relative grid scroll-mt-[60px]">
                <div className={CARD}>
                  <div className="cap-panel-body">
                    {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
                    <div className="flex flex-col">
                      <h2 className="mb-4 text-card-title font-medium text-text">{card.name}</h2>
                      <div className="mb-1">
                        <span className="font-mono text-price font-medium leading-none tracking-[-0.02em] text-accent-text">
                          {card.price}
                        </span>
                      </div>
                      {card.priceLabel ? (
                        <div className="mb-4 font-mono text-caption text-text-tertiary">{card.priceLabel}</div>
                      ) : (
                        <div className="mb-4">&nbsp;</div>
                      )}
                      <p className="m-0 mb-5 text-label leading-[1.55] text-text-secondary">{card.description}</p>
                      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-label leading-[1.45] text-text-secondary">
                        {card.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-2">
                            <Check
                              width={14}
                              height={14}
                              strokeWidth={2.5}
                              className="mt-[3px] flex-shrink-0 text-accent-text"
                              aria-hidden
                            />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>
                      {/* The destination is products.ts's, the one place J09 moves
                          the spokes to Recova's /product/*. The hidden words give
                          each of the four links its own name; the visible "Learn
                          more" leads it, so label-in-name holds. leading-6 makes
                          the link a 24px target. */}
                      <Link
                        to={PRODUCTS[card.id].href}
                        className="group mt-5 text-label leading-6 text-accent-text no-underline transition-opacity duration-150 hover:opacity-80"
                      >
                        Learn more<span className="sr-only"> about {card.name}</span>{" "}
                        <ArrowRight
                          className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                          size={13}
                          strokeWidth={1.5}
                          aria-hidden
                        />
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Recova's annual note sits here ("Annual plans: 10 months billed, 2
          months free. Multiple Stripe accounts supported at the same
          per-account rate."). It stays off the page: PRICING.md rev 3 item 3
          keeps the annual term off /pricing until a checkout can sell it (377(8),
          beside the Intelligence bullets in pricing-copy.ts), and its
          multi-account clause is held by ruling 53. */}

      <section className="speakable-pricing-faq border-t border-border-sub px-5 py-16 sm:px-8">
        <div className="mx-auto max-w-[760px]">
          <h2 className="mb-10 text-center text-subsection font-medium tracking-[-0.01em] text-text sm:text-section">Questions</h2>
          {/* Static list, not the shared FaqAccordion. Legacy makes this choice
              per surface: pricing/page.tsx:181-188 is a plain ul with every
              answer always visible, while its home page does use an accordion
              (components/FaqAccordion.tsx, imported at (marketing)/page.tsx:7).
              Foxhound had flattened both onto the accordion. Ruled 2026-07-28:
              match legacy per surface, so home keeps the accordion. Each item
              is Capsomer's panel, as the cards are. */}
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {PRICING_FAQS.map((faq) => (
              <li key={faq.question} className={CARD}>
                <div className="cap-panel-body">
                  <div>
                    <h3 className="mb-2 text-item-title font-medium text-text">{faq.question}</h3>
                    <p className="m-0 text-copy leading-[1.6] text-text-secondary">{faq.answer}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-border-sub px-5 py-20 sm:px-8">
        {/* Recova's 48px closing button at 1rem. */}
        <div className="mx-auto max-w-[760px] text-center">
          <h2 className="mb-4 text-section font-medium tracking-[-0.01em] text-text sm:text-section-lg">
            See what your Stripe account is leaking
          </h2>
          <p className="mx-auto mb-7 max-w-[560px] text-subhead leading-[1.55] text-text-secondary">
            Connect Stripe for a free diagnostic. Failed invoices, expiring cards, open disputes, and
            business health. Results in <span className="font-mono">30</span> seconds.
          </p>
          <Link to="/audit" className={CTA_BUTTON} data-variant="primary" data-size="lg">
            Connect Stripe, it is free
          </Link>
          {/* 376 item 20: this line used to read "No account required . No Stripe
              connection needed . Results in 30 seconds" directly under a button
              that says Connect Stripe. Both halves were true of DIFFERENT
              products, which is what made the pair a contradiction: the
              estimator needs no connection, the full audit is a connection. The
              line now names which is which. Same element, same separators, same
              place: only the words changed. */}
          <div className="mt-5 font-mono text-caption text-text-subtle">
            Estimator: no account, no Stripe connection &middot; Full audit: read-only Stripe
            connection, no account, 30 seconds
          </div>
        </div>
      </section>

      {/* JSON-LD, as Recova emits it: an array of the FAQPage, sourced from the
          exact list rendered above, and a WebPage whose SpeakableSpecification
          points at the cards and FAQ sections by the classes on them. Every URL
          comes from the loader's siteUrl. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            faqPageJsonLd(PRICING_FAQS),
            speakableWebPageJsonLd(url, {
              name: "Pricing - Foxhound",
              path: "/pricing",
              selectors: [".speakable-pricing-cards", ".speakable-pricing-faq"],
            }),
          ]),
        }}
      />
    </div>
  );
}
