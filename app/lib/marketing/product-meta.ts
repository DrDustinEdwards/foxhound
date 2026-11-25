import { jsonLd } from "@drdustinedwards/site-helpers/schema";

import { speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

/** A product spoke's head: its tags plus the speakable selectors product-sections-cap.tsx puts on the sections. */
export function productMeta(
  loaderData: { siteUrl: string } | undefined,
  page: { title: string; description: string; path: string },
) {
  return [
    ...marketingMeta({ ...page, siteUrl: loaderData?.siteUrl ?? "" }),
    ...(loaderData
      ? [
          jsonLd(
            speakableWebPageJsonLd(loaderData.siteUrl, {
              path: page.path,
              selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
            }),
          ),
        ]
      : []),
  ];
}
