import { data } from "react-router";

import { MarketingError, recovaWords } from "~/components/error-view";

import type { Route } from "./+types/not-found";

// THE MARKETING LAYOUT'S CATCH-ALL. Every address no other route claims lands here and answers
// 404 inside the marketing layout, so the page keeps the site's header (with the visitor's real
// signed-in state) and footer instead of the root boundary's wordmark bar (parity audit,
// 2026-11-10). It never redirects: foxhoundapp.com has no internal redirects (Dustin, 2026-11-11).

export function loader(): never {
  throw data(null, { status: 404, statusText: "Not Found" });
}

/** A POST to an unknown address is a 404 too, not the 405 a route without an action answers. */
export function action(): never {
  throw data(null, { status: 404, statusText: "Not Found" });
}

export function meta({ error }: Route.MetaArgs) {
  return [{ title: `${recovaWords(error, false).title} | Foxhound` }];
}

export default function NotFound() {
  return null;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <MarketingError error={error} />;
}
