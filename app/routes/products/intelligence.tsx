import { TrendingUp } from "lucide-react";

import { ChurnBandsPreview, CustomerTablePreview, DashboardPreview } from "~/components/intelligence-previews";
import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections-cap";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  INTELLIGENCE_BOTTOM_CTA,
  INTELLIGENCE_FAQS,
  INTELLIGENCE_HERO,
  INTELLIGENCE_META_DESCRIPTION,
  INTELLIGENCE_PRICING,
  INTELLIGENCE_SECTION_LABEL,
  INTELLIGENCE_STEPS,
  intelligenceBlocks,
} from "~/lib/marketing/intelligence-copy";
import { intelligencePreviewFor } from "~/lib/marketing/intelligence-preview.server";
import { siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/intelligence";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// The Intelligence spoke. Recova's spec, read whole at HEAD:
// app/(marketing)/product/intelligence/page.tsx (blob 4f258429) and the files
// it draws from, ProductSections.tsx (ba3aed7c), ProductFAQ.tsx (7c08a5a2),
// IntelligenceDashboardPreview.tsx (11972333) with the MRRStatCards (2920fa3b)
// and PlanBreakdown (65b5674f) it mounts, IntelligenceCustomerTable.tsx
// (6ae7c73f) with HealthScoreBadge (f25f29d8), and ChurnRiskSummary.tsx
// (ba1fbb51). IntegrityLayerBanner.tsx (1614dfaf) was read too: it is the
// source of Recova's recommended actions, and no part of it reaches this page.
//
// Recova's sections, in Recova's order: the hero, How it works, three feature
// blocks (the dashboard, plain; the customer table, lifted; the churn bands,
// plain), Pricing, Questions and the closing block. Parts are Capsomer's,
// amber, on the five text sizes (product-sections-cap.tsx), and the one chart
// is Enarratio's. Copy is Recova's with every product fact read from the
// engine and its truthfulness fixes named (lib/marketing/intelligence-copy.ts).
// The previews draw the demo account's seed, never a merchant's rows
// (lib/marketing/intelligence-preview.server.ts).
//
// This page does not claim Intelligence changes failed-payment Recovery timing
// or computes dispute triage (APPROVED-DIFFERENCES, the Intelligence entry).
// The FAQ says the one timing it does change: the first win-back email waits
// longer on an account with Intelligence (winback-copy.ts, process.ts).
//
// The path is Recova's own /product/intelligence since J09.

const PATH = "/product/intelligence";
const TITLE = "Intelligence";
const AUDIT = { href: "/audit", label: "Run your free audit" };

export function meta({ loaderData }: Route.MetaArgs) {
  // SpeakableSpecification, as Recova emits it: the selectors point at
  // the classes product-sections-cap.tsx puts on the sections.
  return [
    ...marketingMeta({
      title: TITLE,
      description: INTELLIGENCE_META_DESCRIPTION,
      path: PATH,
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData
      ? [
          jsonLd(speakableWebPageJsonLd(loaderData.siteUrl, {
            path: PATH,
            selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
          })),
        ]
      : []),
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env), preview: intelligencePreviewFor(Date.now()) };
}

export default function IntelligenceProductPage({ loaderData }: Route.ComponentProps) {
  const { preview } = loaderData;
  const { dashboard, score, churn } = intelligenceBlocks(preview.dashboard.activeCustomers);

  return (
    // Capsomer's amber family with Foxhound's neutrals. Foxhound's global focus
    // ring reads --border-focus (app.css); inside this page it reads the
    // family's --ring, so a keyboard user sees amber as in Capsomer's own parts.
    <div className="fh-cap [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      <ProductHero
        productName="Intelligence"
        Icon={TrendingUp}
        headline={INTELLIGENCE_HERO.headline}
        sub={INTELLIGENCE_HERO.sub}
        pricing={INTELLIGENCE_HERO.pricing}
        primaryCTA={AUDIT}
        secondaryCTA={{ href: "/docs/intelligence", label: "Read the guide" }}
      />
      <HowItWorks steps={INTELLIGENCE_STEPS} />
      <FeatureBlocks
        sectionLabel={INTELLIGENCE_SECTION_LABEL}
        blocks={[
          { ...dashboard, ui: <DashboardPreview preview={preview} /> },
          { ...score, ui: <CustomerTablePreview preview={preview} />, lifted: true },
          { ...churn, ui: <ChurnBandsPreview preview={preview} /> },
        ]}
      />
      <ProductPricing
        price={INTELLIGENCE_PRICING.price}
        priceLabel={INTELLIGENCE_PRICING.priceLabel}
        points={INTELLIGENCE_PRICING.points}
        cta={AUDIT}
      />
      <ProductFAQ name="intelligence-faq" faqs={INTELLIGENCE_FAQS} />
      <BottomCTA
        title={INTELLIGENCE_BOTTOM_CTA.title}
        sub={INTELLIGENCE_BOTTOM_CTA.sub}
        cta={AUDIT}
        note={INTELLIGENCE_BOTTOM_CTA.note}
      />
    </div>
  );
}
