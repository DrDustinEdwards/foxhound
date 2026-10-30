import { ScanSearch } from "lucide-react";

import { AISummaryPreview, AuditHistoryPreview, AuditScopeCard } from "~/components/audit-previews";
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
  AUDIT_BLOCKS,
  AUDIT_BOTTOM_CTA,
  AUDIT_FAQS,
  AUDIT_HERO,
  AUDIT_META_DESCRIPTION,
  AUDIT_PRICING,
  AUDIT_SECTION_LABEL,
  AUDIT_STEPS,
} from "~/lib/marketing/audit-copy";
import { siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/audit";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// The Audit spoke (J55, row M6). Recova's spec, read whole at HEAD:
// app/(marketing)/product/audit/page.tsx (blob 210ce79d) and the files it draws
// from, ProductSections.tsx (ba3aed7c), ProductFAQ.tsx (7c08a5a2) and
// components/docs/AuditScopeCard.tsx (dc1d18dd).
//
// Recova's sections, in Recova's order: the hero, How it works, three feature
// blocks (the scope card, plain; the AI summary, lifted; the audit history,
// plain), Pricing, Questions and the closing block. Parts are Capsomer's, amber,
// on the five text sizes (product-sections-cap.tsx, audit-previews.tsx). Copy
// is Recova's with every product fact read from the engine and its
// truthfulness fixes named (lib/marketing/audit-copy.ts). Recova draws no chart
// here, so neither does this page.
//
// The path is Recova's own /product/audit since J09 (rulings 55 and 56).

const PATH = "/product/audit";
const TITLE = "Audit - Foxhound";
const AUDIT = { href: "/audit", label: "Run your free audit" };

export function meta({ loaderData }: Route.MetaArgs) {
  // SpeakableSpecification, as Recova emits it: the selectors point at
  // the classes product-sections-cap.tsx puts on the sections.
  return [
    ...marketingMeta({
      title: TITLE,
      description: AUDIT_META_DESCRIPTION,
      path: PATH,
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData
      ? [
          jsonLd(speakableWebPageJsonLd(loaderData.siteUrl, {
            name: TITLE,
            path: PATH,
            selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
          })),
        ]
      : []),
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function AuditProductPage() {
  return (
    // Capsomer's amber family with Foxhound's neutrals, and the family's focus
    // ring inside the page, as on the other three spokes.
    <div className="fh-cap [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      <ProductHero
        productName="Audit"
        Icon={ScanSearch}
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
      <BottomCTA title={AUDIT_BOTTOM_CTA.title} sub={AUDIT_BOTTOM_CTA.sub} cta={AUDIT} note={AUDIT_BOTTOM_CTA.note} />
    </div>
  );
}
