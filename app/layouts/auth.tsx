import { PRIVATE_PAGE_HEADERS } from "@dustinedwards/site-runtime/edge-cache";
import { Outlet } from "react-router";

import { Footer } from "~/components/footer";
import { noindexHeader } from "~/lib/seo/meta";

import type { Route } from "./+types/auth";

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

// The sign-in pages sit outside the marketing shell: no site navigation, then the footer's auth variant, which keeps its bottom row and adds Privacy and Terms so visitors can review the legal pages before creating an account. A full-height flex column, main at flex-1, the footer after it; each page centers its card in a full-height box of its own, so the footer sits below the fold. No home-linked logo here. No loader: an anonymous visitor costs no database read. The theme is the root loader's (<html data-theme>), and with no header there is no toggle.
// The sign-in pages are not for search results (each page's meta says so too). Drawn for one reader and kept out of Web Analytics (site-runtime PRIVATE_PAGE_HEADERS); the children inherit it.
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
