import { isRouteErrorResponse } from "react-router";

import { WITHDRAWN_BLOG_HEADING, WITHDRAWN_BLOG_REASON } from "~/lib/blog/withdrawn";
import { resolveErrorBoundaryDetails } from "~/lib/errors/boundary-message";
import "~/error-page.css";

import { headerLogo } from "./header-logo";

// The pieces of the root ErrorBoundary that Capsomer's ErrorPage (capsomer/react/error-page) does
// not draw: Foxhound's wordmark bar and footer, which it takes as its header and footer slots,
// Recova's extra ways out under its message, and the 410 withdrawal, which keeps this view (the
// exception error-page.md names: its own heading, reason and link to the blog).
//
// WHY IT LIVES HERE: root.tsx cannot be imported in the test environment. It pulls app.css, two
// `?url` font assets and lib/theme.server, which reaches D1, so an import of it hangs.

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

// THE BAR carries only the wordmark linking home, as Recova's did. It is drawn here rather than by
// Capsomer's SiteHeader (J10): with no sections, switchers or account, SiteHeader still renders its
// phone Menu button, which would open a sheet with nothing in it, a control that does nothing. So the
// bar takes the J10 header's look by tokens instead: Foxhound's dark chrome band in both themes, 56px,
// 24px sides, and the header's own wordmark (headerLogo) with the x in the band's amber. It reads no
// loader data, so ErrorPage can take it as siteHeader.
export function ErrorBar({ overlay = false }: { overlay?: boolean }) {
  const logo = headerLogo("/");
  return (
    <header
      className={`fh-error-bar flex h-14 items-center border-b bg-chrome px-6${overlay ? " absolute left-0 right-0 top-0" : ""}`}
    >
      <a href={logo.href} aria-label={logo.label} className="no-underline">
        {logo.wordmark}
      </a>
    </header>
  );
}

export function ErrorFooter({ overlay = false }: { overlay?: boolean }) {
  return (
    <footer className={`w-full p-6 text-center text-label text-text-tertiary${overlay ? " absolute bottom-0" : ""}`}>
      &copy; 2026 Foxhound
    </footer>
  );
}

// Recova's words (its not-found.tsx and error.tsx), passed to ErrorPage in place of Capsomer's: a 404
// is "Page not found" with Recova's sentence, anything else "Something went wrong" with the message a
// route threw with data() (the demo's read-only 405, DEMO_READ_ONLY_MESSAGE), else the status text,
// else "An unexpected error occurred." (lib/errors/boundary-message). The home link is "Go home".
export const HOME_LABEL = "Go home";
export function recovaWords(error: unknown, isDev: boolean): { title: string; text: string } {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return { title: "Page not found", text: "The page you're looking for doesn't exist or has been moved." };
  }
  return { title: "Something went wrong", text: resolveErrorBoundaryDetails(error, isDev).details };
}

// Recova's ways out beyond home (its not-found.tsx and error.tsx): the dashboard, and on a 404 the
// demo. ErrorPage draws Go home (and Try again on a server error) itself.
export function ErrorLinks({ notFound }: { notFound: boolean }) {
  return (
    <div className="flex flex-wrap justify-center gap-3" data-density="comfortable">
      <a href="/recovery/dashboard" {...SECONDARY}>
        Go to dashboard
      </a>
      {notFound ? (
        <a href="/demos/recovery" {...SECONDARY}>
          View demo
        </a>
      ) : null}
    </div>
  );
}

// 410 IS THE WITHDRAWAL STATUS IN THIS APP, and the only thrower is the blog post route (391). It is
// a deliberate editorial act, so it gets neither the error heading nor the error affordances: nothing
// went wrong, there is nothing to retry, and the page is not coming back at this URL.
//
// Recova runs ONE chrome kit across not-found.tsx and error.tsx: the same absolute nav, the same
// centered block, the same footer. The withdrawal keeps that kit. Text sizes are Foxhound's five
// (RULES 5.2): the numeral is display, smaller than Recova's 5rem, the approved difference "Text uses
// five standard sizes everywhere". The numeral takes the expected tone (app/error-page.css).
export function WithdrawnView() {
  return (
    <div className="fh-cap fh-error-page relative flex min-h-screen flex-col bg-bg" data-cap-site="foxhound" data-family="amber">
      <ErrorBar overlay />
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <meta name="robots" content="noindex" />
        <p
          className="fh-error-numeral m-0 mb-4 font-mono text-display font-bold leading-none"
          data-tone="expected"
          role="img"
          aria-label="410"
        >
          410
        </p>
        <h1 className="m-0 mb-2 text-title font-semibold text-text">{WITHDRAWN_BLOG_HEADING}</h1>
        <p className="m-0 mb-8 text-body text-text-tertiary">{WITHDRAWN_BLOG_REASON}</p>
        <div className="flex flex-wrap justify-center gap-3" data-density="comfortable">
          {/* ONE destination, and it is the blog. Not "try again", which offers a retry of a URL that
              will never answer, and not "go to dashboard", an app link on an anonymous marketing page. */}
          <a href="/blog" {...PRIMARY}>
            Read the blog
          </a>
        </div>
      </main>
      <ErrorFooter overlay />
    </div>
  );
}
