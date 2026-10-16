// Recova's Paused list (app/admin/merchants/paused/page.tsx, blob 43b1cf35) at its own address. On the family admin
// pattern it is a filter of the Merchants page (J50): the Merchants page's
// loader with this list, and its action, writers, Undo and page.
import { cloudflareContext } from "~/lib/cloudflare-context";
import { loadMerchantsPage } from "~/lib/admin/merchants-page.server";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/paused";

export { action, default, meta } from "./index";

// One page name: the menu's Merchants, as the list's tab says which list.
export const handle: AdminHandle = { page: "Merchants" };

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return loadMerchantsPage(env, request, "paused");
}
