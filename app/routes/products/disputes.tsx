import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";

import {
  DashboardPreview,
  DisputeTablePreview,
  NumbersPreview,
} from "~/components/disputes-previews";
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
import "~/products.css";

// The Disputes spoke, in order: the hero, How it works, three feature blocks (the disputes dashboard, tall; the numbers, lifted; the dispute table, tall), Pricing, Questions and the closing block (product-sections-cap.tsx). Every product fact is read from the engine (lib/marketing/disputes-copy.ts). The previews draw the demo account's seed, never a merchant's rows (lib/marketing/disputes-preview.server.ts). The path is /product/disputes.

const PATH = "/product/disputes";
const TITLE = "Disputes";
const CONNECT = { href: "/connect", label: "Connect Stripe" };

export function meta({ loaderData }: Route.MetaArgs) {
  // SpeakableSpecification: the selectors point at the classes product-sections-cap.tsx puts on the sections.
  return [
    ...marketingMeta({
      title: TITLE,
      description: DISPUTES_META_DESCRIPTION,
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

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env), preview: disputesPreviewFor(Date.now()) };
}

export default function DisputesProductPage({ loaderData }: Route.ComponentProps) {
  const { preview } = loaderData;
  const { dashboard, numbers, evidence } = DISPUTES_BLOCKS;

  return (
    // Capsomer's amber family with Foxhound's neutrals.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <ProductHero
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
            title: dashboard.title,
            body: dashboard.body,
            ui: <DashboardPreview preview={preview} />,
            tallLabel: "Disputes dashboard preview",
          },
          {
            title: numbers.title,
            body: numbers.body,
            ui: <NumbersPreview preview={preview} />,
            lifted: true,
          },
          {
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
      <BottomCTA title={DISPUTES_BOTTOM_CTA.title} sub={DISPUTES_BOTTOM_CTA.sub} cta={CONNECT} />
    </div>
  );
}

export const headers = () => publicPageHeaders();
