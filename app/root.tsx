import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import dmSansVariable from "./assets/fonts/dm-sans-variable.woff2?url";
import dmMono400 from "./assets/fonts/dm-mono-400.woff2?url";
import dmMono500 from "./assets/fonts/dm-mono-500.woff2?url";
import { cloudflareContext } from "./lib/cloudflare-context";
import { resolveErrorBoundaryDetails } from "./lib/errors/boundary-message";
import { DEFAULT_THEME } from "./lib/theme";
import { getThemeFromRequest } from "./lib/theme.server";

export function meta() {
  return [{ title: "Foxhound" }];
}

// Cookie-persisted theme, read once at the root so <html data-theme> is
// correct on the very first byte (no flash of the wrong mode). nonce comes
// from workers/app.ts's per-request generateNonce() (TASK-foxhound-csp-
// nonce-hydration.md), threaded via cloudflareContext so <Scripts>/
// <ScrollRestoration> below can carry the SAME value applySecurityHeaders
// puts in the Content-Security-Policy header - a mismatch would make the
// browser reject its own hydration scripts.
export function loader({ request, context }: Route.LoaderArgs) {
  const { nonce } = context.get(cloudflareContext);
  return { theme: getThemeFromRequest(request), nonce };
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
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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
  const { message, details } = resolveErrorBoundaryDetails(error, import.meta.env.DEV);
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 bg-bg px-4 py-16 text-center">
      <h1 className="text-title font-medium text-text">{message}</h1>
      <p className="max-w-md text-body text-text-secondary">{details}</p>
      <a href="/" className="text-label text-amber-text hover:underline">
        Back to Foxhound
      </a>
      {stack && (
        <pre className="mt-4 max-w-full overflow-x-auto rounded-md border border-border bg-surface p-4 text-left text-label text-text-tertiary">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
