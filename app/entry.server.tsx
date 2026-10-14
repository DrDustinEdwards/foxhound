import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { recordPage404 } from "~/lib/errors/page-404.server";

export const streamTimeout = 5_000;

// Override of @react-router/dev's default entry.server.web.tsx
// (TASK-foxhound-csp-nonce-hydration.md, streaming check). The default
// template never passes a `nonce` prop to <ServerRouter>. root.tsx's
// <Scripts nonce={nonce}> only nonces the route-level bootstrap script it
// renders itself; React Router's OWN late inline <script> tags that flush
// streamed/deferred data outside of <Scripts>
// (window.__reactRouterContext.streamController.enqueue/close, rendered by
// react-router's internal <StreamTransfer> when a route streams a deferred
// value) get their nonce from <ServerRouter nonce={nonce}> instead - a
// SEPARATE prop from renderToReadableStream's own (unrelated) nonce render
// option, which does nothing for these specific scripts.
//
// Verified empirically, not assumed (per the task): the first attempt at
// this file passed `nonce` to renderToReadableStream's options instead of to
// <ServerRouter>, rebuilt, and re-checked every <script> tag in a real
// request through wrangler dev - the two streamController scripts still had
// no nonce attribute at all, while <Scripts>'s own bootstrap scripts did.
// Traced into node_modules/react-router/dist/development/lib/dom/ssr/
// server.js: ServerRouter takes `nonce` directly and threads it into both
// FrameworkContext.Provider (which <Scripts>/<Links> read via
// useFrameworkContext(), as a fallback when no explicit nonce prop is given)
// AND <StreamTransfer nonce={nonce}>. Passing it there is what actually
// fixed it - reverified after, same method, all script tags now match.
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const { env, ctx, nonce } = loadContext.get(cloudflareContext);

  // THE 404 COUNT (ruling 37, job J21): page_404_daily, read by the admin API's
  // /health top_404s_7d. Every document 404 passes through here with this
  // status, an unmatched URL and a route that throws a 404 alike, which is the
  // same pair Recova's not-found.tsx counted. GET only: HEAD returned above, and
  // a POST that 404s is a form aimed at a missing route, not a page someone
  // went looking for.
  //
  // waitUntil, so the write never holds or fails the page; the catch logs
  // rather than swallowing (capsid conventions-web rule 5), since a count that
  // silently stops is how this table sat empty. getDb runs inside the promise
  // so a missing binding is logged the same way instead of throwing here.
  if (responseStatusCode === 404 && request.method.toUpperCase() === "GET") {
    const url = new URL(request.url);
    ctx.waitUntil(
      Promise.resolve()
        .then(() => recordPage404(getDb(env), url, new Date()))
        .catch((error: unknown) => console.error("page_404_daily write failed", error)),
    );
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell. Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
