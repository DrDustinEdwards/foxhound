// The Merchants page's loader, for its three routes: every merchant
// (/admin/merchants) and Recova's Paused and Billing exempt lists (J50). Each
// route passes its own list. The list is never read from the request's
// address: a revalidation after a post asks for /admin/merchants/paused.data,
// which no address match would know.

import { getDb } from "~/db";
import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { merchantsInView, type MerchantView } from "~/lib/admin/merchants";
import { getMerchantFigures, listAdminMerchants } from "~/lib/admin/merchants.server";

export async function loadMerchantsPage(env: Env, request: Request, view: MerchantView) {
  const db = getDb(env);
  // The figures are the Merchants page's own; Recova's two lists had none.
  const [all, figures] = await Promise.all([
    listAdminMerchants(db),
    view === "all" ? getMerchantFigures(db, Date.now()) : Promise.resolve(null),
  ]);
  const merchants = merchantsInView(all, view);
  const paused = merchantsInView(all, "paused");
  const counts: Record<MerchantView, number> = {
    all: all.length,
    paused: paused.length,
    "billing-exempt": merchantsInView(all, "billing-exempt").length,
  };
  // The Paused list's share the brake holds: exactly what its Release resumes
  // (brakePausedCondition: paused and carrying the brake's marker).
  const brakePaused = paused.filter((m) => m.pauseReason === PAUSE_REASON_BRAKE).length;
  // ?cancel=<id> opens the confirm page for a merchant that can still be
  // canceled. An unknown or already canceled one opens nothing, so a stale
  // link lands on the table rather than on a confirmation of nothing.
  const asked = new URL(request.url).searchParams.get("cancel");
  const live = all.find((m) => m.id === asked && !m.cancelledAt);
  return { view, merchants, counts, brakePaused, figures, confirmCancel: live ? { id: live.id, name: live.name } : null };
}
