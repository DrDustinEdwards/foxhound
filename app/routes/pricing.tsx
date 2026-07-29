import { ArrowRight, Check } from "lucide-react";
import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { faqPageJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/pricing";

// Ported from legacy app/(marketing)/pricing/page.tsx (Phase 6 Pass 1).
// Structure kept: audit-first card order, 4-card grid, annual note, FAQ,
// closing CTA. Copy rewritten per corrections #1, #3, #5, #8 (baseline-free,
// review-and-sign disputes, free intelligence tier, maturity-window billing).

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Pricing - Foxhound",
    description:
      "Pay when Foxhound recovers. Baseline recoveries Stripe would have gotten anyway are free. Nothing billed until the recovery has matured for 30 days.",
    path: "/pricing",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

interface PricingCard {
  id: string;
  name: string;
  price: string;
  priceLabel?: string;
  description: string;
  features: string[];
}

const CARDS: PricingCard[] = [
  {
    id: "audit",
    name: "Audit",
    price: "Free",
    description:
      "Full Stripe diagnostic. Failed invoices, expiring cards, open disputes, and business health. No account required.",
    features: [
      "Failed invoice analysis",
      "Expiring cards timeline",
      "Open dispute summary",
      "Business health metrics",
      "No signup required",
    ],
  },
  {
    id: "recovery",
    name: "Recovery",
    price: "20%",
    priceLabel: "of Foxhound-attributed recoveries",
    description:
      "Silent retries first, then AI-drafted email sequences across 30 days. Four decline categories, four different sequences.",
    features: [
      "Silent retry before any customer email",
      "30-day sequences across 4 decline categories",
      "Baseline recoveries Stripe would have gotten anyway are free",
      "No fee until the recovery has matured 30 days",
      "Card-update link on every email",
      "Open and click tracking",
      "No monthly fee",
    ],
  },
  {
    id: "disputes",
    name: "Disputes",
    price: "20%",
    priceLabel: "of won disputes, capped at $500",
    description:
      "Evidence drafted from your Stripe data and recovery history. You review and sign every submission.",
    features: [
      "Evidence drafted from transaction history",
      "Recovery email history included",
      "Draft, review, approve, submit, every time",
      "No auto-submit toggle, there never has been one",
      "20% only when Foxhound wins, capped at $500",
    ],
  },
  {
    id: "intelligence",
    name: "Intelligence",
    price: "$199",
    priceLabel: "per month for predictive risk scoring",
    description:
      "MRR, movements, churn, and cohort analytics are free for every Recovery merchant. Predictive risk scoring is the paid layer.",
    features: [
      "MRR, movements, churn, cohorts: free for Recovery merchants",
      "Predictive risk scoring: the paid $199/mo layer",
      "Health signals feed Recovery timing and Disputes triage",
      "Account-wide, not per-customer",
      "Annual billing: 10 months paid, 2 months free",
    ],
  },
];

const FAQS = [
  {
    question: "Is there a free trial?",
    answer:
      "Audit is always free with no account required. Recovery and Disputes have no trial period because they only charge on outcomes, so there is no upfront cost. If Foxhound doesn't recover anything, you pay nothing.",
  },
  {
    question: 'What counts as a "recovered" payment?',
    answer:
      "A payment is recovered when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged, or a card was updated through a Foxhound page. Payments Stripe's own Smart Retries recover independently are recorded as free and never billed.",
  },
  {
    question: "When am I actually billed?",
    answer:
      "Each monthly run bills the prior month's matured recoveries, meaning recoveries you've held for 30 or more days. We never bill a recovery before then.",
  },
  {
    question: "Can I use multiple products together?",
    answer:
      "Yes. Each product works standalone and its pricing is independent. Used together, Recovery data improves Disputes evidence, and Intelligence signals improve Recovery timing.",
  },
];

export default function PricingPage() {
  return (
    <div>
      <MarketingPageHeader
        eyebrow="Pricing"
        title="Pricing"
        subtext="Two outcome-based products and one flat subscription with a free tier. Audit is always free."
      />

      {/* Legacy's pricing card grid is max-w-[1200px], NOT the 1100px the home
          page uses. The container width is a per-page value, not a site-wide
          constant, which is why ruling 60 says check it per surface rather than
          bulk-replacing max-w-5xl everywhere. */}
      <section className="px-5 pb-12 sm:px-8">
        <div className="mx-auto max-w-[1200px]">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CARDS.map((card) => (
              <div
                key={card.id}
                id={card.id}
                className="relative flex scroll-mt-[60px] flex-col rounded-[12px] border border-border bg-surface p-6"
              >
                <div className="mb-4 text-card-title font-medium text-text">{card.name}</div>
                <div className="mb-1">
                  <span className="font-mono text-price font-medium leading-none tracking-[-0.02em] text-amber-text">
                    {card.price}
                  </span>
                </div>
                <div className="mb-4 font-mono text-caption text-text-tertiary">
                  {card.priceLabel ?? <>&nbsp;</>}
                </div>
                <p className="m-0 mb-5 text-label leading-[1.55] text-text-secondary">{card.description}</p>
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-label leading-[1.45] text-text-secondary">
                  {card.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check width={14} height={14} strokeWidth={2.5} className="mt-[3px] flex-shrink-0 text-amber-text" aria-hidden />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to={`/products/${card.id}`}
                  className="group mt-5 text-label text-amber-text no-underline transition-opacity duration-150 hover:opacity-80"
                >
                  Learn more{" "}
                  <ArrowRight
                    className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border-sub px-5 py-16 sm:px-8">
        <div className="mx-auto max-w-[760px]">
          <h2 className="mb-10 text-center text-subsection font-medium tracking-[-0.01em] text-text sm:text-section">
            Questions
          </h2>
          {/* Static list, not the shared FaqAccordion. Legacy makes this choice
              per surface: pricing/page.tsx:181-188 is a plain ul with every
              answer always visible, while its home page does use an accordion
              (components/FaqAccordion.tsx, imported at (marketing)/page.tsx:7).
              Foxhound had flattened both onto the accordion. Ruled 2026-07-28:
              match legacy per surface, so home keeps the accordion. */}
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {FAQS.map((faq) => (
              <li key={faq.question} className="rounded-[12px] border border-border bg-surface p-6">
                <div className="mb-2 text-item-title font-medium text-text">{faq.question}</div>
                <p className="m-0 text-copy leading-[1.6] text-text-secondary">{faq.answer}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-border-sub px-5 py-20 sm:px-8">
        <div className="mx-auto max-w-[760px] text-center">
          <h2 className="mb-4 text-section font-medium tracking-[-0.01em] text-text sm:text-section-lg">
            See what your Stripe account is leaking
          </h2>
          <p className="mx-auto mb-7 max-w-[560px] text-subhead leading-[1.55] text-text-secondary">
            Connect Stripe for a free diagnostic. Failed invoices, expiring cards, open disputes, and
            business health. Results in <span className="font-mono">30</span> seconds.
          </p>
          <Link
            to="/audit"
            className="inline-flex items-center gap-2 rounded-md bg-amber px-6 py-3 text-body font-semibold text-on-amber hover:bg-amber-dark"
          >
            Connect Stripe, it is free
          </Link>
          <div className="mt-5 font-mono text-caption text-text-subtle">
            No account required &middot; No Stripe connection needed &middot; Results in 30 seconds
          </div>
        </div>
      </section>

      {/* FAQPage JSON-LD, same pairing pattern as home.tsx/decline-codes/code.tsx/
          blog/post.tsx: sourced from the exact FAQS array the accordion above
          renders, never a hand-duplicated copy. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqPageJsonLd(FAQS.map((f) => ({ question: f.question, answer: f.answer })))),
        }}
      />
    </div>
  );
}
