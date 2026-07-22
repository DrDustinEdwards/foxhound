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
import dmSansVariable from "./assets/fonts/dm-sans-variable.woff2?url";
import dmMono400 from "./assets/fonts/dm-mono-400.woff2?url";
import dmMono500 from "./assets/fonts/dm-mono-500.woff2?url";
import { DEFAULT_THEME } from "./lib/theme";
import { getThemeFromRequest } from "./lib/theme.server";

export function meta() {
  return [{ title: "Foxhound" }];
}

// Cookie-persisted theme, read once at the root so <html data-theme> is
// correct on the very first byte (no flash of the wrong mode).
export function loader({ request }: Route.LoaderArgs) {
  return { theme: getThemeFromRequest(request) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // useRouteLoaderData (not useLoaderData) so an error boundary rendered
  // before the root loader resolves still gets a safe default instead of
  // throwing.
  const data = useRouteLoaderData<typeof loader>("root");
  const theme = data?.theme ?? DEFAULT_THEME;

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
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main>
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre>
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
