import { isRouteErrorResponse } from "react-router";
import { ErrorPage } from "capsomer/react/error-page";
import { ButtonLink } from "capsomer/react/link";
import { copyright } from "capsomer/behavior/family-footer";

import { WITHDRAWN_BLOG_HEADING, WITHDRAWN_BLOG_REASON } from "~/lib/blog/withdrawn";
import { errorDetails } from "~/lib/errors/boundary-message";
import "~/error-page.css";

import { headerLogo } from "./header-logo";

// The pieces of the root ErrorBoundary that Capsomer's ErrorPage (capsomer/react/error-page) does
// not draw: Foxhound's wordmark bar and footer, which it takes as its header and footer slots,
// Recova's words and its extra ways out (ErrorPage's `actions`), and the 410 withdrawal's own
// heading and reason (ErrorPage's `gone`).
//
// WHY IT LIVES HERE: root.tsx cannot be imported in the test environment. It pulls app.css, two
// `?url` font assets and lib/theme.server, which reaches D1, so an import of it hangs.

// THE BAR carries only the wordmark linking home, as Recova's did. It is drawn here rather than by
// Capsomer's SiteHeader: with no sections, switchers or account, SiteHeader still renders its
// phone Menu button, which would open a sheet with nothing in it, a control that does nothing. So the
// bar takes the J10 header's look by tokens instead: Foxhound's dark chrome band in both themes, 56px,
// 24px sides, and the header's own wordmark (headerLogo) with the x in the band's amber. It reads no
// loader data, so ErrorPage can take it as siteHeader.
export function ErrorBar() {
  const logo = headerLogo("/");
  return (
    <header className="fh-error-view-row fh-error-bar">
      <a href={logo.href} aria-label={logo.label} className="fh-error-view-link">
        {logo.wordmark}
      </a>
    </header>
  );
}

export function ErrorFooter() {
  return (
    <footer className="fh-error-view-footer fh-center fh-small fh-quiet">
      {copyright("Foxhound")}
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
    return {
      title: "Page not found",
      text: "The page you're looking for doesn't exist or has been moved.",
    };
  }
  return { title: "Something went wrong", text: errorDetails(error, isDev) };
}

// Recova's ways out beyond home (its not-found.tsx and error.tsx): the dashboard, and on a 404 the
// demo, in ErrorPage's own row after Go home (its `actions`). ErrorPage draws Go home (and Try again
// on a server error) itself.
export function errorActions(notFound: boolean) {
  return (
    <>
      <ButtonLink href="/recovery/dashboard">Go to dashboard</ButtonLink>
      {notFound ? <ButtonLink href="/demos/recovery">View demo</ButtonLink> : null}
    </>
  );
}

// 410 IS THE WITHDRAWAL STATUS IN THIS APP, and the only thrower is the blog post route. It is a
// deliberate editorial act, so ErrorPage draws it as its gone page: no alert and no retry, the
// withdrawal's own heading and reason, and ONE destination, the blog. Not "try again", which offers
// a retry of a URL that will never answer, and not "go to dashboard", an app link on an anonymous
// marketing page.
const GONE = { href: "/blog", label: "Read the blog" };

// A MISSED ADDRESS OR A BLOG POST'S ERROR, INSIDE THE MARKETING LAYOUT. The marketing layout's
// catch-all route (routes/not-found.tsx) and the blog post route use this as their ErrorBoundary,
// so the page keeps the site's own header, with the visitor's real signed-in state, and footer
// (parity audit, 2026-11-10: the 404 had only a wordmark bar). The layout already renders the one
// main, so ErrorPage is a div. Anything thrown outside the marketing layout still reaches the root
// boundary's bar.
export function MarketingError({ error }: { error: unknown }) {
  const status = isRouteErrorResponse(error) ? error.status : null;
  const words =
    status === 410
      ? { title: WITHDRAWN_BLOG_HEADING, text: WITHDRAWN_BLOG_REASON }
      : recovaWords(error, import.meta.env.DEV);
  return (
    <div className="fh-cap fh-error-page" data-cap-site="foxhound" data-family="amber">
      <ErrorPage
        as="div"
        error={error}
        home="/"
        {...words}
        homeLabel={HOME_LABEL}
        gone={GONE}
        actions={status === 410 ? undefined : errorActions(status === 404)}
        dev={import.meta.env.DEV}
      />
    </div>
  );
}
