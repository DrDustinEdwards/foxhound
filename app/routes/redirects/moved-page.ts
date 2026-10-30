import { redirect } from "react-router";

import type { Route } from "./+types/moved-page";

// Pages combined into others (Dustin, 2026-10-29). Each old address answers a
// permanent redirect to the page that now holds it, so a bookmark or an old
// link still lands. Every Location is a fixed path from this table.
export const MOVED_PAGES: Record<string, string> = {
  "/settings/alerts": "/settings/notifications",
  "/settings/intelligence": "/settings/notifications",
  "/intelligence/alerts": "/settings/notifications",
  "/settings/features": "/settings/email",
  "/admin/mcps": "/admin/operations",
};

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const target = MOVED_PAGES[url.pathname.replace(/\/$/, "")];
  if (!target) throw new Response("Not Found", { status: 404 });
  return redirect(target + url.search, 301);
}
