import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";

import {
  ChurnBandsPreview,
  CustomerTablePreview,
  DashboardPreview,
} from "~/components/intelligence-previews";
import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections-cap";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
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
import { siteUrl } from "~/lib/seo/jsonld";
import { productMeta } from "~/lib/marketing/product-meta";

import type { Route } from "./+types/intelligence";
import "~/products.css";

// The Intelligence spoke, in order: the hero, How it works, three feature blocks (the dashboard, plain; the customer table, lifted; the churn bands, plain), Pricing, Questions and the closing block (product-sections-cap.tsx); the one chart is Enarratio's. Every product fact is read from the engine (lib/marketing/intelligence-copy.ts). The previews draw the demo account's seed, never a merchant's rows (lib/marketing/intelligence-preview.server.ts).
// This page does not claim Intelligence changes failed-payment Recovery timing or computes dispute triage. The FAQ says the one timing it does change: the first win-back email waits longer on an account with Intelligence (winback-copy.ts, process.ts). The path is /product/intelligence.

const PATH = "/product/intelligence";
const TITLE = "Intelligence";
const AUDIT = { href: "/audit", label: "Run your free audit" };

export function meta({ loaderData }: Route.MetaArgs) {
  return productMeta(loaderData, {
    title: TITLE,
    description: INTELLIGENCE_META_DESCRIPTION,
    path: PATH,
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env), preview: intelligencePreviewFor(Date.now()) };
}

export default function IntelligenceProductPage({ loaderData }: Route.ComponentProps) {
  const { preview } = loaderData;
  const { dashboard, score, churn } = intelligenceBlocks(preview.dashboard.activeCustomers);

  return (
    // Capsomer's amber family with Foxhound's neutrals.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <ProductHero
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
      />
    </div>
  );
}

export const headers = () => publicPageHeaders();
