import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteLoaderData,
} from "react-router";

import { iconLinks } from "@drdustinedwards/site-helpers/icons";
import type { Route } from "./+types/root";
import { ErrorPage } from "capsomer/react/error-page";
import { LinkPrefetch } from "capsomer/react/link";
import "./app.css";
import {
  ErrorBar,
  ErrorFooter,
  errorActions,
  HOME_LABEL,
  recovaWords,
} from "./components/error-view";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { useNonce } from "@dustinedwards/site-runtime/nonce";
import { PRELOADS } from "./lib/preloads";
import { DEFAULT_THEME } from "./lib/theme";
import { usePageHydrates } from "./lib/page-hydrates";
import { resolveThemeForRequest } from "./lib/theme.server";

export function meta({ error }: Route.MetaArgs) {
  return [{ title: error ? `${recovaWords(error, false).title} | Foxhound` : "Foxhound" }];
}

// The font preloads, also sent as the Early Hints `Link` header (lib/preloads.ts).
export const links: Route.LinksFunction = () => [...iconLinks(), ...PRELOADS.links];

// Theme read once at the root so <html data-theme> is correct on the very
// first byte (no flash of the wrong mode). resolveThemeForRequest, not the
// cookie reader: an authenticated merchant's stored accounts.theme has to win
// HERE, because reading it only in a layout would leave them rendering the
// default on a new device and then correcting, which is the exact flash this
// loader exists to prevent. Anonymous requests still touch no DB.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { theme: await resolveThemeForRequest(env, request) };
}

// Paths that act on a GET, so a hovered link never prefetches them (a prefetch runs the loader),
// beyond the family's NEVER_PREFETCH that capsomer/react/link already skips: the demo entries
// seed the demo and set its cookie, /demo/exit clears it, the token routes unsubscribe, finish a
// card update, record an engagement or accept an invite, the OAuth returns exchange a code, and
// /connect/additional mints the state cookie. /admin/view-as/stop ends a view-as session.
const NO_PREFETCH = [
  "/demos/:product",
  "/demo/exit",
  "/u/:token",
  "/p/:token",
  "/e",
  "/invite/:token",
  "/connect/callback",
  "/connect/additional",
  "/audit/callback",
  "/admin/view-as",
];

export function Layout({ children }: { children: React.ReactNode }) {
  // useRouteLoaderData (not useLoaderData) so an error boundary rendered
  // before the root loader resolves still gets a safe default instead of
  // throwing.
  const data = useRouteLoaderData<typeof loader>("root");
  const theme = data?.theme ?? DEFAULT_THEME;
  // The render's nonce (site-runtime ./nonce, from ./react-entry), the one the policy names: never loader data, where a
  // stored page would hand every reader the value it was rendered with.
  const nonce = useNonce();

  const hydrates = usePageHydrates();
  const { pathname } = useLocation();

  // data-family="amber" and data-cap-site="foxhound" put Capsomer's Foxhound entry (the amber accents
  // and Recova's underlined links) in Capsomer's lowest layer (capbase) for the whole page, so a link
  // outside a .fh-cap wrapper is Foxhound's link. Foxhound's own unlayered :root tokens still win where
  // they share a name. The admin has its own look (app/admin.css), so it takes no site.
  const admin = pathname === "/admin" || pathname.startsWith("/admin/");
  return (
    <html
      lang="en"
      data-theme={theme}
      data-family="amber"
      data-cap-site={admin ? undefined : "foxhound"}
      className="h-full antialiased"
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="text-scale" content="scale" />
        {/* DEV ONLY. Since J22 style-src has no 'unsafe-inline' for elements,
            and Vite's dev client injects every stylesheet as an inline style
            element, which the policy then blocks (measured: an unstyled page
            under `npm run dev`). Vite's client copies the nonce from this meta
            onto each style element it injects. Production serves CSS as <link>
            files and never renders this element. */}
        {import.meta.env.DEV ? <meta property="csp-nonce" nonce={nonce} /> : null}
        {/* Legacy declares the feed site-wide from its root layout
            (app/layout.tsx, metadata.alternates.types), so every legacy page
            carries this link. Foxhound had the feed route but advertised it
            from nowhere: not here, not the sitemap, not robots.txt, not the
            llms pair, verified live. A feed nothing points at is shipped but
            dark, reachable only by guessing the URL. Row F5.
            The href is relative where legacy's is absolute: legacy hardcodes
            recovamrr.com, which Foxhound's site-URL discipline bars, and this
            element has no env access. Relative resolves identically for every
            feed reader and cannot go stale at the Phase 9 cutover. */}
        <link rel="alternate" type="application/rss+xml" href="/feed.rss" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-full">
        <LinkPrefetch exclude={NO_PREFETCH}>{children}</LinkPrefetch>
        {hydrates ? (
          <>
            <ScrollRestoration nonce={nonce} />
            <Scripts nonce={nonce} />
          </>
        ) : (
          // Same-origin, so script-src 'self' allows it; the nonce is renewed per reader like every other.
          <script src="/site.js" defer nonce={nonce} />
        )}
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Capsomer's error page under Foxhound's wordmark bar, in Recova's words (components/error-view.tsx),
// with Recova's dashboard and demo links under its message. A missed address and the blog's 410
// withdrawal never reach here: the marketing layout's catch-all and the blog post route answer them
// inside the site's own header and footer (MarketingError). This is for what breaks elsewhere.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const routeError = isRouteErrorResponse(error) ? error : null;
  const { title, text } = recovaWords(error, import.meta.env.DEV);
  return (
    <div
      className="fh-cap fh-error-page flex min-h-screen flex-col bg-bg"
      data-cap-site="foxhound"
      data-family="amber"
    >
      <ErrorPage
        error={error}
        home="/"
        title={title}
        text={text}
        homeLabel={HOME_LABEL}
        className="flex-1"
        siteHeader={<ErrorBar />}
        siteFooter={<ErrorFooter />}
        actions={errorActions(routeError?.status === 404)}
        dev={import.meta.env.DEV}
      />
    </div>
  );
}
