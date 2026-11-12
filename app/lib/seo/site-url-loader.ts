import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import type { RouterContextProvider } from "react-router";

import { siteUrl } from "~/lib/seo/jsonld";

// Its own module, so the many modules that read only jsonld's constants do not load the context with it.
/** The loader of a public page whose only data is the site's origin, for its meta and JSON-LD:
 *  `export const loader = siteUrlLoader;`. */
export function siteUrlLoader({ context }: { context: Readonly<RouterContextProvider> }) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}
