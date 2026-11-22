import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";

import { AISummaryPreview, AuditHistoryPreview, AuditScopeCard } from "~/components/audit-previews";
import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections-cap";
import {
  AUDIT_BLOCKS,
  AUDIT_BOTTOM_CTA,
  AUDIT_FAQS,
  AUDIT_HERO,
  AUDIT_META_DESCRIPTION,
  AUDIT_PRICING,
  AUDIT_SECTION_LABEL,
  AUDIT_STEPS,
} from "~/lib/marketing/audit-copy";
import { speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/audit";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import "~/products.css";

// The Audit spoke, in order: the hero, How it works, three feature blocks (the scope card, plain; the AI summary, lifted; the audit history, plain), Pricing, Questions and the closing block (product-sections-cap.tsx, audit-previews.tsx). Every product fact is read from the engine (lib/marketing/audit-copy.ts). No chart here. The path is /product/audit.

const PATH = "/product/audit";
const TITLE = "Audit";
const AUDIT = { href: "/audit", label: "Run your free audit" };

export function meta({ loaderData }: Route.MetaArgs) {
  // SpeakableSpecification: the selectors point at the classes product-sections-cap.tsx puts on the sections.
  return [
    ...marketingMeta({
      title: TITLE,
      description: AUDIT_META_DESCRIPTION,
      path: PATH,
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData
      ? [
          jsonLd(
            speakableWebPageJsonLd(loaderData.siteUrl, {
              path: PATH,
              selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
            }),
          ),
        ]
      : []),
  ];
}

export const loader = siteUrlLoader;

export default function AuditProductPage() {
  return (
    // Capsomer's amber family with Foxhound's neutrals, and the family's focus
    // ring inside the page, as on the other three spokes.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <ProductHero
        headline={AUDIT_HERO.headline}
        sub={AUDIT_HERO.sub}
        pricing={AUDIT_HERO.pricing}
        primaryCTA={AUDIT}
        secondaryCTA={{ href: "/docs/audit", label: "Read the guide" }}
      />
      <HowItWorks steps={AUDIT_STEPS} />
      <FeatureBlocks
        sectionLabel={AUDIT_SECTION_LABEL}
        blocks={[
          { ...AUDIT_BLOCKS.scopes, ui: <AuditScopeCard /> },
          { ...AUDIT_BLOCKS.summary, ui: <AISummaryPreview />, lifted: true },
          { ...AUDIT_BLOCKS.history, ui: <AuditHistoryPreview /> },
        ]}
      />
      <ProductPricing
        price={AUDIT_PRICING.price}
        priceLabel={AUDIT_PRICING.priceLabel}
        points={AUDIT_PRICING.points}
        cta={AUDIT}
      />
      <ProductFAQ name="audit-faq" faqs={AUDIT_FAQS} />
      <BottomCTA title={AUDIT_BOTTOM_CTA.title} sub={AUDIT_BOTTOM_CTA.sub} cta={AUDIT} />
    </div>
  );
}

export const headers = () => publicPageHeaders();
