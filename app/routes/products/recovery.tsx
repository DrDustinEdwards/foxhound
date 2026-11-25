import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";

import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections-cap";
import {
  CategorySequencePreview,
  DashboardPreview,
  PaymentsPreview,
} from "~/components/recovery-previews";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import {
  RECOVERY_BLOCKS,
  RECOVERY_BOTTOM_CTA,
  RECOVERY_FAQS,
  RECOVERY_HERO,
  RECOVERY_META_DESCRIPTION,
  RECOVERY_PRICING,
  RECOVERY_SECTION_LABEL,
  RECOVERY_STEPS,
} from "~/lib/marketing/recovery-copy";
import { recoveryPreviewFor } from "~/lib/marketing/recovery-preview.server";
import { siteUrl } from "~/lib/seo/jsonld";
import { productMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/recovery";
import "~/products.css";
// The payments preview (recovery-previews.tsx) draws Capsomer's table; /features uses that module too but
// draws no table, so the stylesheet loads here rather than with the module.
import "capsomer/table.css";

// The Recovery spoke, in order: the hero, How it works, three feature blocks (the category sequences; the dashboard, lifted; the payments table, tall), Pricing, Questions and the closing block (product-sections-cap.tsx). Every product fact is read from the engine (lib/marketing/recovery-copy.ts). The previews draw the demo account's seed, never a merchant's rows (lib/marketing/recovery-preview.server.ts). The path is /product/recovery.

const PATH = "/product/recovery";
const TITLE = "Recovery";
const AUDIT = { href: "/audit", label: "Run your free audit" };

export function meta({ loaderData }: Route.MetaArgs) {
  return productMeta(loaderData, {
    title: TITLE,
    description: RECOVERY_META_DESCRIPTION,
    path: PATH,
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env), preview: recoveryPreviewFor(Date.now()) };
}

export default function RecoveryProductPage({ loaderData }: Route.ComponentProps) {
  const { preview } = loaderData;
  const { categories, dashboard, payments } = RECOVERY_BLOCKS;

  return (
    // Capsomer's amber family with Foxhound's neutrals.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <ProductHero
        headline={RECOVERY_HERO.headline}
        sub={RECOVERY_HERO.sub}
        pricing={RECOVERY_HERO.pricing}
        primaryCTA={AUDIT}
        secondaryCTA={{ href: "/docs/recovery", label: "Read the guide" }}
      />
      <HowItWorks steps={RECOVERY_STEPS} />
      <FeatureBlocks
        sectionLabel={RECOVERY_SECTION_LABEL}
        blocks={[
          {
            title: categories.title,
            body: (
              <>
                {categories.bodyBefore}{" "}
                <a href={categories.linkHref} rel="external">
                  {categories.linkText}
                </a>{" "}
                {categories.bodyAfter}
              </>
            ),
            ui: <CategorySequencePreview />,
          },
          {
            title: dashboard.title,
            body: dashboard.body,
            ui: <DashboardPreview preview={preview} />,
            lifted: true,
          },
          {
            title: payments.title,
            body: payments.body,
            ui: <PaymentsPreview preview={preview} />,
            tallLabel: "Failed payments preview",
          },
        ]}
      />
      <ProductPricing
        price={RECOVERY_PRICING.price}
        priceLabel={RECOVERY_PRICING.priceLabel}
        points={RECOVERY_PRICING.points}
        cta={AUDIT}
      />
      <ProductFAQ name="recovery-faq" faqs={RECOVERY_FAQS} />
      <BottomCTA title={RECOVERY_BOTTOM_CTA.title} sub={RECOVERY_BOTTOM_CTA.sub} cta={AUDIT} />
    </div>
  );
}

export const headers = () => publicPageHeaders();
