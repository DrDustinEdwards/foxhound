import { useMatches, useRouteLoaderData } from "react-router";

import type { loader as marketingLoader } from "~/layouts/marketing";

/** Whether this page sends React to the browser. HYDRATION IS OPT-IN BY ROUTE (`handle = { hydrate: true }`),
 *  as on dustinedwards.info. The public marketing pages send no React: their few widgets (the theme button and
 *  menus, the reveals, the FAQ, the calculator, the email generator) run from /site.js and its islands
 *  (app/site.ts, app/islands/). The signed-in app, the admin, the sign-in pages, /connect, the audit flow and
 *  the token pages opt in. A signed-in visitor on a marketing page also hydrates: their header carries the
 *  business switcher and Sign out, which are React's, and their pages are private and never edge-cached. */
export function usePageHydrates(): boolean {
  const matches = useMatches();
  const signedIn =
    useRouteLoaderData<typeof marketingLoader>("layouts/marketing")?.isAuthenticated === true;
  return (
    signedIn ||
    matches.some((match) => (match.handle as { hydrate?: boolean } | undefined)?.hydrate === true)
  );
}
