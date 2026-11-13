import { PRIVATE_PAGE_HEADERS } from "@dustinedwards/site-runtime/edge-cache";
import { Outlet } from "react-router";

import { Footer } from "~/components/footer";
import { noindexHeader } from "~/lib/seo/meta";

import type { Route } from "./+types/auth";

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

// Recova's auth layout (app/(auth)/layout.tsx, blob 17a22006), row A1, ruled
// toward Recova by 403 (Dustin "yes", 2026-09-19): the four sign-in pages
// leave the marketing shell. No site navigation, then the footer's auth
// variant, which keeps its bottom row and adds Privacy and Terms "so visitors
// can review the legal pages before creating an account".
//
// Recova's own shape: a full-height flex column, main at flex-1, the footer
// after it. Each page centers its card in a full-height box of its own, so the
// footer sits below the fold, as Recova's comment accepts.
//
// No home-linked logo: Recova's layout has none, and its bottom-row mark is an
// image, not a link. Ruling 403 binding 2 says the seat asks Dustin rather than
// adding one, so none is added here.
//
// No loader: an anonymous visitor costs no database read. The theme is the
// root loader's (<html data-theme>), and with no header there is no toggle,
// as in Recova.
// The sign-in pages are not for search results (each page's meta says so too).
// Drawn for one reader and kept out of Web Analytics (site-runtime PRIVATE_PAGE_HEADERS); the children inherit it.
export const headers = () => PRIVATE_PAGE_HEADERS;

export const middleware: Route.MiddlewareFunction[] = [noindexHeader];

export default function AuthLayout() {
  return (
    <div className="fh-page-frame fh-text">
      <main className="fh-auth-block">
        <Outlet />
      </main>
      <Footer variant="auth" />
    </div>
  );
}
