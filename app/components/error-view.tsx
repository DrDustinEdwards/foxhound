import { isRouteErrorResponse } from "react-router";

import { WITHDRAWN_BLOG_HEADING, WITHDRAWN_BLOG_REASON } from "~/lib/blog/withdrawn";
import { resolveErrorBoundaryDetails } from "~/lib/errors/boundary-message";
import "~/error-page.css";

import { headerLogo } from "./header-logo";

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

// THE LOOK (J21): Capsomer's button, amber, Foxhound's five text sizes. Amber
// throughout has since landed site-wide, so this page and the rest of
// the site share the one accent.
//
// Recova's buttons are 44px tall (px-6 py-3, text-sm). Capsomer's nearest is
// data-size="lg" in its comfortable density: 40px with a pointer, 44px on a
// touch screen (every size is), and a 1rem label, which is Foxhound's body
// size. Compact lg would be 36px with a 15px label, a size outside the five.
// The density sits on the button row, so nothing else on the page moves.
//
// Primary is Capsomer's primary; the secondaries are its default (outlined),
// shadcn's outline variant, which is what Recova's bordered transparent links
// were. No Foxhound class goes on a button: the component draws it whole.
const BUTTON = { className: "cap-btn", "data-size": "lg" } as const;
const PRIMARY = { ...BUTTON, "data-variant": "primary" } as const;
const SECONDARY = BUTTON;

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

  // The numeral's color is the kit's fault signal: the brand accent (amber) for
  // an expected condition (404), red for a fault. A withdrawal is expected, so it
  // takes the expected tone. Red here would be the same error framing the
  // heading just stopped doing, one element over. On the amber family the
  // expected tone is the accent text and the fault is --crit (app/error-page.css);
  // --crit holds AA on Foxhound's ground in both themes, as text-red did.
  const numeralTone = isNotFound || isWithdrawn ? "expected" : "fault";
  const logo = headerLogo("/");

  // Legacy runs ONE chrome kit across not-found.tsx and error.tsx: the same
  // absolute nav, the same centered block, the same footer, differing only in the
  // numeral, its color, the copy and the CTA set. Ported as one boundary with
  // two states, the M20/M21 shared-legal-kit shape (ruling 82). The withdrawal
  // is a third state on the same kit.
  //
  // THE BAR carries only the wordmark linking home, as Recova's did. It is
  // drawn here rather than by Capsomer's SiteHeader (J10): with no sections,
  // switchers or account, SiteHeader still renders its phone Menu button,
  // which would open a sheet with nothing in it, a control that does nothing.
  // So the bar takes the J10 header's look by tokens instead: Foxhound's dark
  // chrome band in both themes, 56px, 24px sides, and the header's own
  // wordmark (headerLogo) with the x in the band's amber. When Capsomer can
  // leave the Menu out, this becomes <SiteHeader logo={logo} theme={false} />.
  //
  // Text sizes are Foxhound's five (RULES 5.2): the numeral is display, which
  // is smaller than Recova's 5rem; that is the approved difference "Text uses
  // five standard sizes everywhere".
  return (
    <main
      className="fh-cap fh-error-page relative flex min-h-screen flex-col items-center justify-center bg-bg" data-cap-site="foxhound"
      data-family="amber"
    >
      <nav className="fh-error-bar absolute left-0 right-0 top-0 flex h-14 items-center border-b bg-chrome px-6">
        <a href={logo.href} aria-label={logo.label} className="no-underline">
          {logo.wordmark}
        </a>
      </nav>

      <div className="px-6 text-center">
        <p
          className="fh-error-numeral m-0 mb-4 font-mono text-display font-bold leading-none"
          data-tone={numeralTone}
          role="img"
          aria-label={code}
        >
          {code}
        </p>
        <h1 className="m-0 mb-2 text-title font-semibold text-text">{heading}</h1>
        <p className="m-0 mb-8 text-body text-text-tertiary">{body}</p>

        <div className="flex flex-wrap justify-center gap-3" data-density="comfortable">
          {isWithdrawn ? (
            // ONE destination, and it is the blog. Not "try again", which offers
            // a retry of a URL that will never answer, and not "go to dashboard",
            // which is an app link on an anonymous marketing surface.
            <a href="/blog" {...PRIMARY}>
              Read the blog
            </a>
          ) : isNotFound ? (
            <>
              <a href="/recovery/dashboard" {...PRIMARY}>
                Go to dashboard
              </a>
              <a href="/demos/recovery" {...SECONDARY}>
                View demo
              </a>
              <a href="/" {...SECONDARY}>
                Go home
              </a>
            </>
          ) : (
            <>
              {/* Legacy's first CTA calls Next's reset(). React Router gives an
                  ErrorBoundary no equivalent, so a reload is the closest honest
                  affordance for the same intent, retry this page. */}
              <button type="button" onClick={() => location.reload()} {...PRIMARY}>
                Try again
              </button>
              <a href="/recovery/dashboard" {...SECONDARY}>
                Go to dashboard
              </a>
              {/* Legacy's third is "Go to recovamrr.com", a cross-host link from
                  the app subdomain to the marketing site. Foxhound is one host,
                  so its counterpart is home rather than a dropped item. */}
              <a href="/" {...SECONDARY}>
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

      <div className="absolute bottom-0 w-full p-6 text-center text-label text-text-tertiary">
        &copy; 2026 Foxhound
      </div>
    </main>
  );
}
