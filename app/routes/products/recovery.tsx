import { RefreshCw } from "lucide-react";

import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections-cap";
import { CategorySequencePreview, DashboardPreview, PaymentsPreview } from "~/components/recovery-previews";
import { cloudflareContext } from "~/lib/cloudflare-context";
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
import { siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/recovery";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// The Recovery spoke (J56, row M7). Recova's spec, read whole at HEAD:
// app/(marketing)/product/recovery/page.tsx (blob ec4aded8) and the files it
// draws from, ProductSections.tsx (ba3aed7c), ProductFAQ.tsx (7c08a5a2),
// RecoveryDashboardPreview.tsx (565b772c), RecoveryPaymentsPreview.tsx
// (da19edf0), CategoryPill.tsx (c7dc96f1) and SequenceTimeline.tsx (aa6a85fc).
//
// Recova's sections, in Recova's order: the hero, How it works, three feature
// blocks (the category sequences; the dashboard, lifted; the payments table,
// tall), Pricing, Questions and the closing block. Parts are Capsomer's, amber,
// on the five text sizes (product-sections-cap.tsx). Copy is Recova's with
// every product fact read from the engine (lib/marketing/recovery-copy.ts).
// The previews draw the demo account's seed, never a merchant's rows
// (lib/marketing/recovery-preview.server.ts).
//
// The path is Recova's own /product/recovery since J09 (rulings 55 and 56).

const PATH = "/product/recovery";
const TITLE = "Recovery - Foxhound";
const AUDIT = { href: "/audit", label: "Run your free audit" };

export function meta({ loaderData }: Route.MetaArgs) {
  // SpeakableSpecification, as Recova emits it: the selectors point at
  // the classes product-sections-cap.tsx puts on the sections.
  return [
    ...marketingMeta({
      title: TITLE,
      description: RECOVERY_META_DESCRIPTION,
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
  return { siteUrl: siteUrl(env), preview: recoveryPreviewFor(Date.now()) };
}

export default function RecoveryProductPage({ loaderData }: Route.ComponentProps) {
  const { preview } = loaderData;
  const { categories, dashboard, payments } = RECOVERY_BLOCKS;

  return (
    // Capsomer's amber family with Foxhound's neutrals. Foxhound's global focus
    // ring reads --border-focus (app.css); inside this page it reads the
    // family's --ring, so a keyboard user sees amber as in Capsomer's own parts.
    <div className="fh-cap [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      <ProductHero
        productName="Recovery"
        Icon={RefreshCw}
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
            eyebrow: categories.eyebrow,
            title: categories.title,
            body: (
              <>
                {categories.bodyBefore}{" "}
                <a
                  href={categories.linkHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-text underline underline-offset-2 transition-opacity duration-150 hover:opacity-80"
                >
                  {categories.linkText}
                </a>{" "}
                {categories.bodyAfter}
              </>
            ),
            ui: <CategorySequencePreview />,
          },
          {
            eyebrow: dashboard.eyebrow,
            title: dashboard.title,
            body: dashboard.body,
            ui: <DashboardPreview preview={preview} />,
            lifted: true,
          },
          {
            eyebrow: payments.eyebrow,
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
      <BottomCTA
        title={RECOVERY_BOTTOM_CTA.title}
        sub={RECOVERY_BOTTOM_CTA.sub}
        cta={AUDIT}
        note={RECOVERY_BOTTOM_CTA.note}
      />
    </div>
  );
}
