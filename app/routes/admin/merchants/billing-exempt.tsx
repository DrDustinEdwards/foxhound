// Recova's Billing exempt list (app/admin/merchants/billing-exempt/page.tsx,
// blob a0c4f9da) at its own address. On the family admin
// pattern it is a filter of the Merchants page (J50): the Merchants page's
// loader with this list, and its action, writers, Undo and page.
import { cloudflareContext } from "~/lib/cloudflare-context";
import { loadMerchantsPage } from "~/lib/admin/merchants-page.server";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/billing-exempt";

export { action, default } from "./index";

// Its own browser title, as Recova's heading named the list. AdminShell sets
// document.title itself today (job_490a6bc5b957, blocked); this is right for
// when that lands.
export function meta() {
  return [{ title: "Billing exempt merchants - Foxhound admin" }];
}

// One page name: the menu's Merchants, as the list's tab says which list.
export const handle: AdminHandle = { page: "Merchants" };

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return loadMerchantsPage(env, request, "billing-exempt");
}
