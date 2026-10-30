import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { ErrorPage } from "capsomer/react/error-page";
import { LinkPrefetch } from "capsomer/react/link";
import "./app.css";
import { ErrorBar, ErrorFooter, ErrorLinks, HOME_LABEL, recovaWords, WithdrawnView } from "./components/error-view";
import { cloudflareContext } from "./lib/cloudflare-context";
import { PRELOADS } from "./lib/preloads";
import { DEFAULT_THEME } from "./lib/theme";
import { resolveThemeForRequest } from "./lib/theme.server";

export function meta({ error }: Route.MetaArgs) {
  return [{ title: error ? `${recovaWords(error, false).title} | Foxhound` : "Foxhound" }];
}

// The font preloads, also sent as the Early Hints `Link` header (lib/preloads.ts).
export const links: Route.LinksFunction = () => PRELOADS.links;

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
        {/* Legacy declares icon=/favicon.png and apple=/apple-touch-icon.png from
            its root layout, both resolving to one 512x512 PNG. Foxhound shipped
            only the SVG, so both raster paths 404'd and no apple-touch
            declaration existed at all: ledger row F21, and the blocker on F5's
            RSS channel image. The rasters are generated from this
            same SVG by scripts/build-icons.mjs.
            The SVG stays and is declared first: it is a Foxhound addition legacy
            has no counterpart for, browsers that understand it prefer it, and
            removing a working better icon to match legacy's item set exactly
            would be a parity point bought with a real regression. Recorded on
            row F21 rather than left as silent drift. */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
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
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
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
