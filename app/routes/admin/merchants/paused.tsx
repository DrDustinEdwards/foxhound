// The Paused list at its own address: a filter of the Merchants page, using its loader with this list, and its action, writers, Undo and page.
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { loadMerchantsPage } from "~/lib/admin/merchants-page.server";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/paused";
import { NOINDEX } from "~/lib/seo/meta";

export { action, default } from "./index";

// Its own browser title naming the list. AdminShell does not set document.title itself yet; this is right for when it does.
export function meta() {
  return [{ title: "Paused merchants - Foxhound admin" }, NOINDEX];
}

// One page name: the menu's Merchants, as the list's tab says which list.
export const handle: AdminHandle = { page: "Merchants" };

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return loadMerchantsPage(env, request, "paused");
}
