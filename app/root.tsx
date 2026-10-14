import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { ErrorView } from "./components/error-view";
import dmSansVariable from "./assets/fonts/dm-sans-variable.woff2?url";
import dmMono400 from "./assets/fonts/dm-mono-400.woff2?url";
import dmMono500 from "./assets/fonts/dm-mono-500.woff2?url";
import { cloudflareContext } from "./lib/cloudflare-context";
import { DEFAULT_THEME } from "./lib/theme";
import { resolveThemeForRequest } from "./lib/theme.server";

export function meta() {
  return [{ title: "Foxhound" }];
}

// Theme read once at the root so <html data-theme> is correct on the very
// first byte (no flash of the wrong mode). resolveThemeForRequest, not the
// cookie reader: an authenticated merchant's stored accounts.theme has to win
// HERE, because reading it only in a layout would leave them rendering the
// default on a new device and then correcting, which is the exact flash this
// loader exists to prevent (ruling 59). Anonymous requests still touch no DB.
// nonce comes
// from workers/app.ts's per-request generateNonce() (TASK-foxhound-csp-
// nonce-hydration.md), threaded via cloudflareContext so <Scripts>/
// <ScrollRestoration> below can carry the SAME value applySecurityHeaders
// puts in the Content-Security-Policy header - a mismatch would make the
// browser reject its own hydration scripts.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, nonce } = context.get(cloudflareContext);
  return { theme: await resolveThemeForRequest(env, request), nonce };
}

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
        {/* Legacy declares icon=/favicon.png and apple=/apple-touch-icon.png from
            its root layout, both resolving to one 512x512 PNG. Foxhound shipped
            only the SVG, so both raster paths 404'd and no apple-touch
            declaration existed at all: ledger row F21, and the blocker on F5's
            RSS channel image (ruling 99). The rasters are generated from this
            same SVG by scripts/build-icons.mjs (ruling 108).
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
        <link rel="preload" href={dmSansVariable} as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href={dmMono400} as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href={dmMono500} as="font" type="font/woff2" crossOrigin="anonymous" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-full">
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // The view lives in components/error-view.tsx so it can be rendered in a
  // test; root.tsx itself cannot be imported there (app.css, the `?url` font
  // assets and lib/theme.server). error.data carries whatever a route threw via
  // data(), which the view resolves through resolveErrorBoundaryDetails.
  return <ErrorView error={error} isDev={import.meta.env.DEV} />;
}
