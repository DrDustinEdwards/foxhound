import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteLoaderData,
} from "react-router";

import { iconLinks } from "@drdustinedwards/site-helpers/icons";
import type { Route } from "./+types/root";
import { ErrorPage } from "capsomer/react/error-page";
import { LinkPrefetch } from "capsomer/react/link";
import "./app.css";
import { ErrorBar, ErrorFooter, ErrorLinks, HOME_LABEL, recovaWords, WithdrawnView } from "./components/error-view";
import { cloudflareContext } from "./lib/cloudflare-context";
import { PRELOADS } from "./lib/preloads";
import { DEFAULT_THEME } from "./lib/theme";
import type { loader as marketingLoader } from "./layouts/marketing";
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
// nonce comes
// from workers/app.ts's per-request generateNonce() (site-runtime; TASK-foxhound-csp-
// nonce-hydration.md), threaded via cloudflareContext so <Scripts>/
// <ScrollRestoration> below can carry the SAME value applySecurityHeaders
// puts in the Content-Security-Policy header - a mismatch would make the
// browser reject its own hydration scripts.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, nonce } = context.get(cloudflareContext);
  return { theme: await resolveThemeForRequest(env, request), nonce };
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
  const nonce = data?.nonce;

  // HYDRATION IS OPT-IN BY ROUTE (`handle = { hydrate: true }`), as on dustinedwards.info. The public
  // marketing pages send no React: their few widgets (the theme button and menus, the reveals, the FAQ,
  // the calculator, the email generator) run from /site.js and its islands (app/site.ts, app/islands/).
  // The signed-in app, the admin, the sign-in pages, /connect, the audit flow and the token pages
  // opt in. A signed-in visitor on a marketing page also hydrates: their header carries the business
  // switcher and Sign out, which are React's, and their pages are private and never edge-cached.
  const matches = useMatches();
  const signedIn = useRouteLoaderData<typeof marketingLoader>("layouts/marketing")?.isAuthenticated === true;
  const hydrates =
    signedIn || matches.some((match) => (match.handle as { hydrate?: boolean } | undefined)?.hydrate === true);

  return (
    <html lang="en" data-theme={theme} className="h-full antialiased">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
// with Recova's dashboard and demo links under its message. The 410 withdrawal keeps its own view.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const routeError = isRouteErrorResponse(error) ? error : null;
  if (routeError?.status === 410) return <WithdrawnView />;
  const { title, text } = recovaWords(error, import.meta.env.DEV);
  return (
    <div className="fh-cap fh-error-page flex min-h-screen flex-col bg-bg" data-cap-site="foxhound" data-family="amber">
      <ErrorPage
        error={error}
        home="/"
        title={title}
        text={text}
        homeLabel={HOME_LABEL}
        className="flex-1"
        siteHeader={<ErrorBar />}
        siteFooter={<ErrorFooter />}
        dev={import.meta.env.DEV}
      >
        <ErrorLinks notFound={routeError?.status === 404} />
      </ErrorPage>
    </div>
  );
}
