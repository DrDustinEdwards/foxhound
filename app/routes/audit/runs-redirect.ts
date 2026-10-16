import { redirect } from "react-router";

import type { Route } from "./+types/runs-redirect";

// J63 (row U4): a saved audit run moved to Recova's own path,
// /audit/results/:id (app/audit/results/[id]/page.tsx). The old path was the
// link in every monthly audit email sent before the move, so it answers one 301
// to the new one rather than a 404. Only the id and the query string are
// carried, so this cannot become an open redirect.
export function loader({ request, params }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`/audit/results/${encodeURIComponent(params.id)}${search}`, 301);
}
