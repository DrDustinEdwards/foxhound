import { marketingMeta } from "~/lib/seo/meta";
import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { CtaBand } from "capsomer/react/cta-band";
import { Hero } from "capsomer/react/hero";
import { Link } from "capsomer/react/link";
import { PriceCard, PriceGrid } from "capsomer/react/price-card";
import "capsomer/cta-band.css";
import "capsomer/hero.css";

import { CARD, ConnectStripeAction } from "~/components/marketing-card";
import { AUDIT_GRANT_MINUTES, AUDIT_SCOPE_WORDS } from "~/lib/marketing/audit-access";
import {
  PRICING_CARDS,
  PRICING_FAQS,
  PRICING_META_DESCRIPTION,
} from "~/lib/marketing/pricing-copy";
import { PRODUCTS } from "~/lib/marketing/products";
import { speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";

import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/price-card.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the button, the accent text and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/pricing";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import "~/pricing.css";

// /pricing: the shared page header, the 1200px card container on a 1/2/4 column grid with gap-4, each card's order (name, price, price label or a blank line, description, check list, Learn more), the 760px FAQ under its "Questions" h2, and the 760px closing block with its 560px line. The page sits in Capsomer's amber family with Foxhound's own neutrals (.fh-cap), each card and FAQ item is Capsomer's panel, and the closing link is Capsomer's primary button. Text: card name 1.125rem, price 2.5rem, price label and closing microcopy 0.75rem, description, bullets and Learn more 0.8125rem, the h2s 1.5rem to 1.75rem and 1.75rem to 2rem, FAQ question and closing line 0.9375rem, FAQ answer 0.875rem. Card names and FAQ questions are h2 and h3 (not plain divs), so a screen reader can move between the plans and the questions; the page keeps one h1 and never skips a level. Copy, and every number in it, read from the engine constants, are in lib/marketing/pricing-copy.ts.

export function meta({ loaderData }: Route.MetaArgs) {
  // JSON-LD: a WebPage whose SpeakableSpecification points at the cards and FAQ sections by the classes on them. Every URL comes from the loader's siteUrl.
  return [
    ...marketingMeta({
      title: "Pricing: pay only for payments Foxhound recovers",
      description: PRICING_META_DESCRIPTION,
      path: "/pricing",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData
      ? [
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
      <Hero className="fh-page-hero" title="Pricing" />

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
                  // The destination is products.ts's. The hidden words give each of the four links its own name; the visible "Learn more" leads it, so label-in-name holds.
                  <Link
                    to={PRODUCTS[card.id].href}
                    className="fh-pricing-link fh-hover-group fh-small fh-brand"
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

      <CtaBand
        quiet
        className="fh-closing-band fh-closing-pricing"
        title="See what your Stripe account is leaking"
        actions={<ConnectStripeAction />}
      >
        Connect Stripe for a free diagnostic. Failed invoices, expiring cards, open disputes, and
        business health. Results in <span className="fh-mono">30</span> seconds. The audit has
        Stripe grant {AUDIT_SCOPE_WORDS} access, which Foxhound only reads and drops after{" "}
        {AUDIT_GRANT_MINUTES} minutes.
      </CtaBand>
    </div>
  );
}

export const headers = () => publicPageHeaders();
