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
import "./app.css";
import { Wordmark } from "./components/wordmark";
import dmSansVariable from "./assets/fonts/dm-sans-variable.woff2?url";
import dmMono400 from "./assets/fonts/dm-mono-400.woff2?url";
import dmMono500 from "./assets/fonts/dm-mono-500.woff2?url";
import { cloudflareContext } from "./lib/cloudflare-context";
import { resolveErrorBoundaryDetails } from "./lib/errors/boundary-message";
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
  // error.data carries whatever a route (or middleware, e.g. the demo
  // read-only guard in app/lib/auth/guards.ts) threw via data(), so a
  // deliberate rejection reads as its own message rather than the generic
  // HTTP reason phrase a bare thrown Response would otherwise leave it with.
  const { details } = resolveErrorBoundaryDetails(error, import.meta.env.DEV);
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  const routeError = isRouteErrorResponse(error) ? error : null;
  const isNotFound = routeError?.status === 404;
  // Legacy hardcodes "500" because Next's App Router does not expose a status to
  // error.tsx (its own global-error.tsx comment says so and passes statusCode={0}).
  // React Router does expose it, so a 503 reads 503 instead of claiming 500.
  // Treatment is legacy's, the figure is Foxhound's real state: rulings 78/79.
  const code = isNotFound ? "404" : routeError ? String(routeError.status) : "500";
  const heading = isNotFound ? "Page not found" : "Something went wrong";
  const body = isNotFound ? "The page you're looking for doesn't exist or has been moved." : details;

  const PRIMARY =
    "bg-amber text-on-amber px-6 py-3 rounded-lg text-sm font-semibold no-underline font-sans";
  const SECONDARY =
    "bg-transparent text-text px-6 py-3 rounded-lg text-sm font-medium no-underline border border-border font-sans";

  // Legacy runs ONE chrome kit across not-found.tsx and error.tsx: the same
  // absolute nav, the same centred block, the same footer, differing only in the
  // numeral, its colour, the copy and the CTA set. Ported as one boundary with
  // two states, the M20/M21 shared-legal-kit shape (ruling 82).
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-bg">
      <nav className="absolute left-0 right-0 top-0 flex h-14 items-center border-b border-border bg-bg px-6">
        <a href="/" className="no-underline">
          <Wordmark />
        </a>
      </nav>

      <div className="px-6 text-center">
        <p
          className={`m-0 mb-4 font-mono text-[5rem] font-bold leading-none ${
            isNotFound ? "text-amber-text" : "text-red"
          }`}
          role="img"
          aria-label={code}
        >
          {code}
        </p>
        <h1 className="m-0 mb-2 text-2xl font-semibold text-text">{heading}</h1>
        <p className="m-0 mb-8 text-base text-text-tertiary">{body}</p>

        <div className="flex flex-wrap justify-center gap-3">
          {isNotFound ? (
            <>
              <a href="/recovery" className={PRIMARY}>
                Go to dashboard
              </a>
              <a href="/demos/recovery" className={SECONDARY}>
                View demo
              </a>
              <a href="/" className={SECONDARY}>
                Go home
              </a>
            </>
          ) : (
            <>
              {/* Legacy's first CTA calls Next's reset(). React Router gives an
                  ErrorBoundary no equivalent, so a reload is the closest honest
                  affordance for the same intent, retry this page. */}
              <button type="button" onClick={() => location.reload()} className={`${PRIMARY} border-0 cursor-pointer`}>
                Try again
              </button>
              <a href="/recovery" className={SECONDARY}>
                Go to dashboard
              </a>
              {/* Legacy's third is "Go to recovamrr.com", a cross-host link from
                  the app subdomain to the marketing site. Foxhound is one host,
                  so its counterpart is home rather than a dropped item. */}
              <a href="/" className={SECONDARY}>
                Go home
              </a>
            </>
          )}
        </div>

        {stack && (
          <pre className="mt-8 max-w-full overflow-x-auto rounded-md border border-border bg-surface p-4 text-left text-label text-text-tertiary">
            <code>{stack}</code>
          </pre>
        )}
      </div>

      <div className="absolute bottom-0 w-full p-6 text-center text-sm text-text-tertiary">
        &copy; 2026 Foxhound
      </div>
    </main>
  );
}
