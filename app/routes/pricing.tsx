import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Link } from "capsomer/react/link";
import { PriceCard, PriceGrid } from "capsomer/react/price-card";

import { CARD, CTA_BUTTON } from "~/components/marketing-card";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import {
  PRICING_CARDS,
  PRICING_FAQS,
  PRICING_META_DESCRIPTION,
} from "~/lib/marketing/pricing-copy";
import { PRODUCTS } from "~/lib/marketing/products";
import { speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/price-card.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// button, the accent text and the focus ring read. The site header loads the
// same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/pricing";
import { faqPage, jsonLd } from "@drdustinedwards/site-helpers/schema";
import "~/pricing.css";

// /pricing. Recova's spec is app/(marketing)/pricing/page.tsx
// (blob 8e91e160), read whole.
//
// Layout is Recova's: the shared page header, the 1200px card container on a
// 1/2/4 column grid with gap-4, each card's order (name, price, price label or
// a blank line, description, check list, Learn more), the 760px FAQ under its
// "Questions" h2, and the 760px closing block with its 560px line. Look is
// Capsomer's: the page sits in Capsomer's amber family with
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
  // JSON-LD, as Recova emits it: an array of the FAQPage, sourced from the
  // exact list rendered above, and a WebPage whose SpeakableSpecification
  // points at the cards and FAQ sections by the classes on them. Every URL
  // comes from the loader's siteUrl.
  return [
    ...marketingMeta({
      title: "Pricing",
      description: PRICING_META_DESCRIPTION,
      path: "/pricing",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData
      ? [
          jsonLd(faqPage(PRICING_FAQS)),
          jsonLd(
            speakableWebPageJsonLd(loaderData.siteUrl, {
              path: "/pricing",
              selectors: [".speakable-pricing-cards", ".speakable-pricing-faq"],
            }),
          ),
        ]
      : []),
  ];
}

export const loader = siteUrlLoader;

export default function PricingPage() {
  return (
    // Capsomer's amber family with Foxhound's neutrals.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <MarketingPageHeader
        eyebrow="Pricing"
        title="Pricing"
        subtext="Two outcome-based products. Intelligence and Audit are always free."
      />

      {/* Legacy's pricing card grid is max-w-[1200px], NOT the 1100px the home
          page uses. The container width is a per-page value, not a site-wide
          constant, which is why ruling 60 says check it per surface rather than
          bulk-replacing max-w-5xl everywhere.

          Each card is Capsomer's price card at Recova's p-6 and sizes (pricing.css
          sets them through the card's own variables). A card with no price label
          keeps a blank line there, as Recova's does, so the descriptions line up. */}
      <section className="fh-pricing-band speakable-pricing-cards">
        <div className="fh-pricing-wrap">
          <PriceGrid label="Plans">
            {PRICING_CARDS.map((card) => (
              <PriceCard
                key={card.id}
                id={card.id}
                headingLevel="h2"
                name={card.name}
                price={card.price}
                label={card.priceLabel || "\u00a0"}
                text={card.description}
                points={card.features}
                action={
                  // The destination is products.ts's, the one place J09 moves
                  // the spokes to Recova's /product/*. The hidden words give
                  // each of the four links its own name; the visible "Learn
                  // more" leads it, so label-in-name holds.
                  <Link
                    to={PRODUCTS[card.id].href}
                    className="fh-pricing-link fh-hover-group fh-small fh-accent"
                  >
                    Learn more<span className="cap-sr-only"> about {card.name}</span>{" "}
                    <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
                  </Link>
                }
              />
            ))}
          </PriceGrid>
        </div>
      </section>

      {/* Recova's note under the cards ("Annual plans: 10 months billed, 2
          months free. Multiple Stripe accounts supported at the same
          per-account rate."). Its multi-account clause is back: one login can
          hold several accounts, each with its own Stripe connection
          (/connect/additional, the header's account switcher), and each is
          billed on its own recoveries at the same rates. The annual term stays
          off: PRICING.md rev 3 item 3 keeps it off /pricing until a checkout can
          sell it (377(8), beside the Intelligence bullets in pricing-copy.ts). */}
      <p className="fh-pricing-text-2 fh-center fh-small fh-soft">
        Multiple Stripe accounts supported at the same per-account rate.
      </p>

      <section className="fh-mk-band-short speakable-pricing-faq">
        <div className="fh-mk-wrap-text">
          <h2 className="fh-pricing-title-2 fh-center fh-subsection fh-medium fh-text">
            Questions
          </h2>
          {/* Static list, not the shared FaqAccordion. Legacy makes this choice
              per surface: pricing/page.tsx:181-188 is a plain ul with every
              answer always visible, while its home page does use an accordion
              (components/FaqAccordion.tsx, imported at (marketing)/page.tsx:7).
              Foxhound had flattened both onto the accordion. Ruled 2026-07-28:
              match legacy per surface, so home keeps the accordion. Each item
              is Capsomer's panel, as the cards are. */}
          <ul className="cap-stack" data-gap="4">
            {PRICING_FAQS.map((faq) => (
              <li key={faq.question} className={CARD}>
                <div className="cap-panel-body">
                  <div>
                    <h3 className="fh-pricing-title-3 fh-item-title fh-medium fh-text">
                      {faq.question}
                    </h3>
                    <p className="fh-pricing-text-3 fh-copy fh-soft">{faq.answer}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="fh-mk-band">
        {/* Recova's 48px closing button at 1rem. */}
        <div className="fh-mk-wrap-text fh-center">
          <h2 className="fh-pricing-title-4 fh-section fh-medium fh-text">
            See what your Stripe account is leaking
          </h2>
          <p className="fh-mk-sub fh-subhead fh-soft">
            Connect Stripe for a free diagnostic. Failed invoices, expiring cards, open disputes,
            and business health. Results in <span className="fh-mono">30</span> seconds.
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
          <div className="fh-pricing-block-4 fh-mono fh-caption fh-faint">
            Estimator: no account, no Stripe connection &middot; Full audit: a Stripe connection
            that only reads and ends after {AUDIT_GRANT_MINUTES} minutes, no account, 30 seconds
          </div>
        </div>
      </section>
    </div>
  );
}

export const headers = () => publicPageHeaders();
