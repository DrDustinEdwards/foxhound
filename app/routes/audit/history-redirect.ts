import { redirect } from "react-router";

import type { Route } from "./+types/history-redirect";

// J43: the signed-in audit history moved to Recova's own path, /audit/dashboard.
// The old path was linked from the public /docs and /features pages and from
// the account menu while it lived, so it answers one 301 to the new one rather
// than a 404. The target is fixed, so this cannot become an open redirect; only
// the query string is carried.
export function loader({ request }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`/audit/dashboard${search}`, 301);
}
