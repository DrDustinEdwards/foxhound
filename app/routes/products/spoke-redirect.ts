import { redirect } from "react-router";

import type { Route } from "./+types/spoke-redirect";

// Foxhound's former product pages, /products/<name> (J09, rulings 55 and 56).
// Recova serves each product page at /product/<name>, singular, and Foxhound
// now does too. These four old addresses are the only retired Foxhound paths
// that were ever public: the sitemap listed them. So each answers ONE 301 to
// its new address, with the query string kept, and nothing else under
// /products/ redirects, because a redirect to a page that does not exist
// claims a replacement there is none of (RULES.md 2.5).
//
// The names are an allow-list, never interpolated from the request beyond a
// lookup, so this cannot become an open redirect.
const SPOKE_TARGETS: Readonly<Record<string, string>> = {
  audit: "/product/audit",
  recovery: "/product/recovery",
  disputes: "/product/disputes",
  intelligence: "/product/intelligence",
};

export function loader({ request, params }: Route.LoaderArgs) {
  const target = Object.hasOwn(SPOKE_TARGETS, params.spoke) ? SPOKE_TARGETS[params.spoke] : undefined;
  // A thrown 404 renders the site's own not-found page through the root
  // boundary, which is why this module has a component and is not a bare
  // resource route.
  if (!target) throw new Response("Not Found", { status: 404 });
  const { search } = new URL(request.url);
  return redirect(`${target}${search}`, 301);
}

export default function ProductSpokeRedirect() {
  return null;
}
