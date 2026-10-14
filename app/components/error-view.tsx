import { isRouteErrorResponse } from "react-router";

import { WITHDRAWN_BLOG_HEADING, WITHDRAWN_BLOG_REASON } from "~/lib/blog/withdrawn";
import { resolveErrorBoundaryDetails } from "~/lib/errors/boundary-message";

import { Wordmark } from "./wordmark";

// The root ErrorBoundary's view, lifted out of app/root.tsx unchanged apart
// from the withdrawal state added below.
//
// WHY IT MOVED: root.tsx cannot be imported in the test environment. It pulls
// app.css, two `?url` font assets and lib/theme.server, which reaches D1, so an
// import of it hangs. That left every user-visible string on this surface
// assertable only through a pure helper, which is how "Something went wrong"
// sat over a deliberate withdrawal without a test noticing. Extracting the view
// is ruling 215's sanctioned pattern applied to markup rather than to logic:
// the component renders in a plain node test under MemoryRouter, so the plants
// read what a reader reads.

const PRIMARY =
  "bg-brand text-on-brand px-6 py-3 rounded-lg text-sm font-semibold no-underline font-sans";
const SECONDARY =
  "bg-transparent text-text px-6 py-3 rounded-lg text-sm font-medium no-underline border border-border font-sans";

export function ErrorView({ error, isDev = false }: { error: unknown; isDev?: boolean }) {
  const { details } = resolveErrorBoundaryDetails(error, isDev);
  const stack = isDev && error instanceof Error ? error.stack : undefined;

  const routeError = isRouteErrorResponse(error) ? error : null;
  const isNotFound = routeError?.status === 404;

  // 410 IS THE WITHDRAWAL STATUS IN THIS APP, and the only thrower is the blog
  // post route (391). It is a deliberate editorial act, so it gets neither the
  // error heading nor the error affordances: nothing went wrong, there is
  // nothing to retry, and the page is not coming back at this URL.
  const isWithdrawn = routeError?.status === 410;

  // Legacy hardcodes "500" because Next's App Router does not expose a status to
  // error.tsx (its own global-error.tsx comment says so and passes statusCode={0}).
  // React Router does expose it, so a 503 reads 503 instead of claiming 500.
  // Treatment is legacy's, the figure is Foxhound's real state: rulings 78/79.
  const code = isNotFound ? "404" : routeError ? String(routeError.status) : "500";

  const heading = isNotFound
    ? "Page not found"
    : isWithdrawn
      ? WITHDRAWN_BLOG_HEADING
      : "Something went wrong";

  // The withdrawn body is the REASON alone. `details` here is the full served
  // sentence, whose first clause is already the heading above.
  const body = isNotFound
    ? "The page you're looking for doesn't exist or has been moved."
    : isWithdrawn
      ? WITHDRAWN_BLOG_REASON
      : details;

  // The numeral's colour is the kit's fault signal: the brand accent (teal) for an expected
  // condition (404), red for a fault. A withdrawal is expected, so it takes
  // the brand accent. Red here would be the same error framing the heading just stopped
  // doing, one element over.
  const numeralTone = isNotFound || isWithdrawn ? "text-brand-text" : "text-red";

  // Legacy runs ONE chrome kit across not-found.tsx and error.tsx: the same
  // absolute nav, the same centred block, the same footer, differing only in the
  // numeral, its colour, the copy and the CTA set. Ported as one boundary with
  // two states, the M20/M21 shared-legal-kit shape (ruling 82). The withdrawal
  // is a third state on the same kit.
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-bg">
      <nav className="absolute left-0 right-0 top-0 flex h-14 items-center border-b border-border bg-bg px-6">
        <a href="/" className="no-underline">
          <Wordmark />
        </a>
      </nav>

      <div className="px-6 text-center">
        <p
          className={`m-0 mb-4 font-mono text-[5rem] font-bold leading-none ${numeralTone}`}
          role="img"
          aria-label={code}
        >
          {code}
        </p>
        <h1 className="m-0 mb-2 text-2xl font-semibold text-text">{heading}</h1>
        <p className="m-0 mb-8 text-base text-text-tertiary">{body}</p>

        <div className="flex flex-wrap justify-center gap-3">
          {isWithdrawn ? (
            // ONE destination, and it is the blog. Not "try again", which offers
            // a retry of a URL that will never answer, and not "go to dashboard",
            // which is an app link on an anonymous marketing surface.
            <a href="/blog" className={PRIMARY}>
              Read the blog
            </a>
          ) : isNotFound ? (
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
              <button
                type="button"
                onClick={() => location.reload()}
                className={`${PRIMARY} border-0 cursor-pointer`}
              >
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
