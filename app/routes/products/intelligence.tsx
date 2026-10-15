import { TrendingUp } from "lucide-react";

import { Meter } from "~/components/charts";
import { StatCard } from "~/components/stat-card";
import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/intelligence";

// Ported from legacy app/(marketing)/product/intelligence/page.tsx (Phase 6
// Pass 1). Copy correction #5: the free MRR analytics tier is front and
// center, legacy treated Intelligence as a single $199/mo product with no
// free layer.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Intelligence - Foxhound",
    description:
      "Free MRR, movements, churn, and cohort analytics for every Recovery merchant. Predictive risk scoring is the paid $199/mo layer.",
    path: "/product/intelligence",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

const STEPS = [
  {
    title: "Every Recovery merchant gets MRR analytics, free",
    body: "MRR, movements, churn, and cohorts are computed from your Stripe subscription data, with no manual entry and no separate signup. They refresh on a scheduled run, so the first set appears at the next run after you connect rather than instantly.",
  },
  {
    title: "The paid layer scores every customer",
    body: "For $199/mo, each customer gets a 0-100 health score built from named signals: payment-timing drift, billing volatility, refunds and disputes, recovery engagement, and tenure. Scores refresh daily and sort the customers who need attention to the top.",
  },
  {
    title: "The score is not a black box",
    body: "Every factor that moved a customer's score away from the baseline is listed on their page, with the reason in plain language. You can see why a customer is flagged, not just that they are.",
  },
];

const FAQS = [
  {
    q: "Is any of Intelligence free?",
    a: "Yes. MRR, movements, churn, and cohort analytics are free for every Recovery merchant, permanently, not a trial. The $199/mo layer adds predictive risk scoring on top.",
  },
  {
    q: "What is the difference between the free tier and the paid layer?",
    a: "The free tier reports account-level totals: MRR, movements, churn, cohorts. The paid layer works per customer, scoring each one 0-100 from their own payment timing, billing changes, refunds, disputes, recovery engagement, and tenure, so the customers carrying the most risk sort to the top before they cancel.",
  },
  {
    q: "Is the risk score a validated prediction?",
    a: "Not yet, and we will not claim otherwise. The score is a deterministic reading of the signals a customer has actually generated, and each score is logged with the horizon it was made for. Grading those logged scores against what really happened is not built yet, so no accuracy figure exists and none is advertised.",
  },
  {
    q: "What is the difference between Intelligence and the free Audit?",
    a: "The Audit is a one-time diagnostic snapshot. Intelligence's free tier is continuous MRR and churn tracking over time. The paid layer adds forward-looking risk scoring on top of both.",
  },
];

// Grounded in the real app/routes/app/dashboard.tsx "MRR analytics" section:
// the same free-tier chip (a bordered pill reading "Free", not the Badge
// component, matching dashboard.tsx's own inline markup) sitting over the
// same StatCard primitives used there. Sample data, explicitly labeled, not a
// platform-wide statistic.
function FreeTierPreview() {
  return (
    <div className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-micro text-text-subtle">Sample account, MRR analytics</p>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Free
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="MRR" value="$18,420" subtext="Free for Recovery merchants" />
        <StatCard label="Churn rate" value="2.1%" subtext="0.4% voluntary, 2.1% involuntary" />
      </div>
    </div>
  );
}

// CORRECTED 2026-08-14 under 281c, which named this comment as the stale
// artifact. It read "app/routes/app/intelligence/*.tsx are still RouteStub
// placeholders, there is no shipped predictive-scoring screen to mirror yet",
// and that is FALSE at HEAD: none of the six Intelligence routes uses
// RouteStub, and all of them render. Measured on the deployed demo, /intelligence
// returning 207 customers scored with a 155/49/3 healthy/watch/at-risk
// distribution, /intelligence/customers listing 207 sorted health-ascending, and
// /intelligence/churn rendering MRR at risk by band.
//
// The preview below still uses the Meter primitive DESIGN.md and
// app/components/charts.tsx name for this surface ("an Intelligence risk row",
// see the Meter doc comment in charts.tsx). That choice stands on its own: it
// mirrors the shipped bands rather than inventing a layout, and the sample
// values are labelled as a sample account.
function PaidLayerPreview() {
  const ROWS = [
    { name: "Acme Analytics", mrrAtRisk: "$1,240 MRR at risk", risk: 82, tone: "negative" as const },
    { name: "Bolt Analytics", mrrAtRisk: "$640 MRR at risk", risk: 54, tone: "neutral" as const },
    { name: "Northstar Inc", mrrAtRisk: "$210 MRR at risk", risk: 18, tone: "positive" as const },
  ];
  return (
    <div className="flex flex-col gap-3 p-5">
      <p className="font-mono text-micro text-text-subtle">Sample account, $199/mo layer</p>
      {ROWS.map((r) => (
        <div key={r.name} className="flex flex-col gap-1.5 rounded-lg border border-border-sub bg-surface px-4 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-label text-text">{r.name}</span>
            <span className="font-mono text-micro text-text-tertiary">{r.mrrAtRisk}</span>
          </div>
          <Meter value={r.risk} tone={r.tone} label={`${r.name} churn risk`} />
        </div>
      ))}
    </div>
  );
}

const BLOCKS = [
  {
    eyebrow: "Free for every Recovery merchant",
    title: "MRR, movements, churn, cohorts. No charge.",
    body: "This is not a trial. Every account running Recovery gets these analytics for as long as they use it, computed straight from Stripe subscription data with no manual entry.",
    ui: <FreeTierPreview />,
  },
  {
    eyebrow: "The paid layer",
    title: "$199/mo for predictive risk scoring.",
    body: "On top of the free analytics, the paid layer scores customers by churn risk before it happens, so outreach can happen ahead of the cancellation instead of after it.",
    ui: <PaidLayerPreview />,
  },
];

export default function IntelligenceProductPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url } = loaderData;

  return (
    <>
      <ProductHero
        productName="Intelligence"
        Icon={TrendingUp}
        headline={"MRR analytics, free.\nPredictive risk scoring, $199/mo."}
        sub="MRR, movements, churn, and cohort analytics come free with every Recovery account. The predictive risk layer that flags at-risk customers before they churn is the paid upgrade on top."
        pricing="Free MRR analytics for Recovery merchants · $199/mo for predictive risk scoring"
        primaryCTA={{ href: "/audit", label: "Run your free audit" }}
        secondaryCTA={{ href: "/docs/intelligence", label: "Read the guide" }}
      />
      <HowItWorks steps={STEPS} />
      <FeatureBlocks sectionLabel="What you see after connecting" blocks={BLOCKS} />
      <ProductPricing
        price="Free / $199"
        priceLabel="MRR analytics free, predictive risk scoring $199/mo"
        points={[
          "MRR, movements, churn, and cohorts: free for every Recovery merchant",
          "Predictive risk scoring: the paid account-wide layer",
          "A 0-100 health score per customer, refreshed daily, with every factor shown",
          "No manual data entry, computed from Stripe subscription data",
        ]}
        ctaHref="/audit"
        ctaLabel="Run your free audit"
      />
      <ProductFAQ faqs={FAQS} />
      <BottomCTA
        title="See your MRR and churn before you pay for anything."
        sub="The free audit shows your current MRR and involuntary churn rate."
        ctaHref="/audit"
        ctaLabel="Run your free audit"
        note="MRR analytics are free with Recovery, no separate signup"
      />
      {/* SpeakableSpecification. The selectors point at classes injected by
          product-sections.tsx. Legacy carries this on every spoke. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            speakableWebPageJsonLd(url, {
              name: "Intelligence - Foxhound",
              path: "/product/intelligence",
              selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
            }),
          ),
        }}
      />
    </>
  );
}
