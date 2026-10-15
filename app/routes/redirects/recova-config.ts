import { redirect } from "react-router";

import { resolveRecovaConfigRedirect } from "~/lib/redirects/recova-config-redirects";

import type { Route } from "./+types/recova-config";

// Recova's config-level redirects (J23, ledger row F17), served at Recova's
// own paths: /recovery/audit and its two subpages, /user-guides and everything
// under it, and /sitemap_index.xml. The table and the matcher are in
// app/lib/redirects/recova-config-redirects.ts; this resource route only
// answers what it says, with Recova's status (Next.js's 308 for permanent) and
// the query string kept, as Next.js keeps it.
//
// Every Location is a fixed path on this site (see the matcher), so this
// cannot become an open redirect.
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const target = resolveRecovaConfigRedirect(url.pathname, url.search);
  if (!target) throw new Response("Not Found", { status: 404 });
  return redirect(target.location, target.status);
}
