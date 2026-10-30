import { Shield } from "lucide-react";

import { DashboardPreview, DisputeTablePreview, NumbersPreview } from "~/components/disputes-previews";
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
  DISPUTES_BLOCKS,
  DISPUTES_BOTTOM_CTA,
  DISPUTES_FAQS,
  DISPUTES_HERO,
  DISPUTES_META_DESCRIPTION,
  DISPUTES_PRICING,
  DISPUTES_SECTION_LABEL,
  DISPUTES_STEPS,
} from "~/lib/marketing/disputes-copy";
import { disputesPreviewFor } from "~/lib/marketing/disputes-preview.server";
import { siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/disputes";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// The Disputes spoke (J57, row M8). Recova's spec, read whole at HEAD:
// app/(marketing)/product/disputes/page.tsx (blob c412d54f) and the files it
// draws from, ProductSections.tsx (ba3aed7c), ProductFAQ.tsx (7c08a5a2),
// DisputesDashboardPreview.tsx (dcde195e) with the DisputesDashboardView it
// renders (3c1b7a98), and DisputesTablePreview.tsx (ed33fa95) with
// DisputeStatusPill (8eb22d08) and TriagePill (1485726d).
//
// Recova's sections, in Recova's order: the hero, How it works, three feature
// blocks (the disputes dashboard, tall; the numbers, lifted; the dispute
// table, tall), Pricing, Questions and the closing block. Parts are
// Capsomer's, amber, on the five text sizes (product-sections-cap.tsx). Copy is
// Recova's with every product fact read from the engine and its truthfulness
// fixes named (lib/marketing/disputes-copy.ts). The previews draw the demo
// account's seed, never a merchant's rows
// (lib/marketing/disputes-preview.server.ts).
//
// The path is Recova's own /product/disputes since J09 (rulings 55 and 56).

const PATH = "/product/disputes";
const TITLE = "Disputes - Foxhound";
const CONNECT = { href: "/connect", label: "Connect Stripe" };

export function meta({ loaderData }: Route.MetaArgs) {
  // SpeakableSpecification, as Recova emits it: the selectors point at
  // the classes product-sections-cap.tsx puts on the sections.
  return [
    ...marketingMeta({
      title: TITLE,
      description: DISPUTES_META_DESCRIPTION,
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
  return { siteUrl: siteUrl(env), preview: disputesPreviewFor(Date.now()) };
}

export default function DisputesProductPage({ loaderData }: Route.ComponentProps) {
  const { preview } = loaderData;
  const { dashboard, numbers, evidence } = DISPUTES_BLOCKS;

  return (
    // Capsomer's amber family with Foxhound's neutrals. Foxhound's global focus
    // ring reads --border-focus (app.css); inside this page it reads the
    // family's --ring, so a keyboard user sees amber as in Capsomer's own parts.
    <div className="fh-cap [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      <ProductHero
        productName="Disputes"
        Icon={Shield}
        headline={DISPUTES_HERO.headline}
        sub={DISPUTES_HERO.sub}
        pricing={DISPUTES_HERO.pricing}
        primaryCTA={CONNECT}
        secondaryCTA={{ href: "/docs/disputes", label: "Read the guide" }}
      />
      <HowItWorks steps={DISPUTES_STEPS} />
      <FeatureBlocks
        sectionLabel={DISPUTES_SECTION_LABEL}
        blocks={[
          {
            eyebrow: dashboard.eyebrow,
            title: dashboard.title,
            body: dashboard.body,
            ui: <DashboardPreview preview={preview} />,
            tallLabel: "Disputes dashboard preview",
          },
          {
            eyebrow: numbers.eyebrow,
            title: numbers.title,
            body: numbers.body,
            ui: <NumbersPreview preview={preview} />,
            lifted: true,
          },
          {
            eyebrow: evidence.eyebrow,
            title: evidence.title,
            body: evidence.body,
            ui: <DisputeTablePreview preview={preview} />,
            tallLabel: "Dispute table preview",
          },
        ]}
      />
      <ProductPricing
        price={DISPUTES_PRICING.price}
        priceLabel={DISPUTES_PRICING.priceLabel}
        points={DISPUTES_PRICING.points}
        cta={CONNECT}
      />
      <ProductFAQ name="disputes-faq" faqs={DISPUTES_FAQS} />
      <BottomCTA
        title={DISPUTES_BOTTOM_CTA.title}
        sub={DISPUTES_BOTTOM_CTA.sub}
        cta={CONNECT}
        note={DISPUTES_BOTTOM_CTA.note}
      />
    </div>
  );
}
