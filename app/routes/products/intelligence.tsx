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
    path: "/products/intelligence",
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
    body: "MRR, movements, churn, and cohorts are computed from your Stripe subscription data the moment you connect Recovery. No separate signup, no trial that expires.",
  },
  {
    title: "The paid layer adds prediction",
    body: "For $199/mo, a predictive risk-scoring layer sits on top of the free analytics, surfacing which customers are trending toward churn before it happens.",
  },
  {
    title: "Signals feed back into Recovery and Disputes",
    body: "Risk signals from the paid layer can adjust Recovery sequence timing and Disputes triage for accounts that opt in.",
  },
];

const FAQS = [
  {
    q: "Is any of Intelligence free?",
    a: "Yes. MRR, movements, churn, and cohort analytics are free for every Recovery merchant, permanently, not a trial. The $199/mo layer adds predictive risk scoring on top.",
  },
  {
    q: "What is the difference between the free tier and the paid layer?",
    a: "The free tier reports what already happened: MRR, movements, churn, cohorts. The paid layer predicts what is about to happen: which customers are trending toward risk before they churn.",
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

// Honesty note (see product-page report): app/routes/app/intelligence/*.tsx
// are still RouteStub placeholders, there is no shipped predictive-scoring
// screen to mirror yet. This preview instead reuses the one real, already-
// built primitive DESIGN.md and app/components/charts.tsx name for exactly
// this future surface ("an Intelligence risk row", see the Meter doc comment
// in charts.tsx), rather than inventing a table layout with no basis in the
// codebase.
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
          "Risk signals can feed Recovery timing and Disputes triage",
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
              path: "/products/intelligence",
              selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
            }),
          ),
        }}
      />
    </>
  );
}
