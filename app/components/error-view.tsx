import { isRouteErrorResponse } from "react-router";
import { ErrorPage } from "capsomer/react/error-page";
import { ButtonLink } from "capsomer/react/link";
import { copyright } from "capsomer/behavior/family-footer";

import { WITHDRAWN_BLOG_HEADING, WITHDRAWN_BLOG_REASON } from "~/lib/blog/withdrawn";
import { errorDetails } from "~/lib/errors/boundary-message";
import "~/error-page.css";

import { headerLogo } from "./header-logo";

// The pieces of the root ErrorBoundary that Capsomer's ErrorPage does not draw: Foxhound's wordmark bar and footer, its words and extra ways out (`actions`), and the 410 withdrawal's heading and reason (`gone`). It lives here because root.tsx cannot be imported in the test environment: it pulls app.css, two `?url` font assets and lib/theme.server, which reaches D1.

// The bar carries only the wordmark linking home. It is drawn here rather than by Capsomer's SiteHeader: with no sections, switchers or account, SiteHeader still renders its phone Menu button, a control that does nothing. So the bar takes the header's look by tokens: Foxhound's dark chrome band in both themes, 56px, 24px sides, and the header's wordmark (headerLogo) with the x in the band's amber. It reads no loader data, so ErrorPage can take it as siteHeader.
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

// A 404 is "Page not found"; anything else is "Something went wrong" with the message a route threw with data() (the demo's read-only 405, DEMO_READ_ONLY_MESSAGE), else the status text, else "An unexpected error occurred." (lib/errors/boundary-message). The home link is "Go home".
export const HOME_LABEL = "Go home";
export function recovaWords(error: unknown, isDev: boolean): { title: string; text: string } {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return {
      title: "Page not found",
      text: "Nothing is at this address.",
    };
  }
  return { title: "Something went wrong", text: errorDetails(error, isDev) };
}

// The way out beyond home on a server error: the dashboard, in ErrorPage's own row after Go home
// (its `actions`). A 404 is the family's: title, one line and Go home.
export function errorActions() {
  return <ButtonLink href="/recovery/dashboard">Go to dashboard</ButtonLink>;
}

// 410 is the withdrawal status in this app, and the only thrower is the blog post route. It is a deliberate editorial act, so ErrorPage draws it as its gone page: no alert and no retry, the withdrawal's heading and reason, and one destination, the blog. Not "try again", which offers a retry of a URL that will never answer, and not "go to dashboard", an app link on an anonymous marketing page.
const GONE = { href: "/blog", label: "Read the blog" };

// A missed address or a blog post's error, inside the marketing layout: its catch-all route (routes/not-found.tsx) and the blog post route use this as their ErrorBoundary, so the page keeps the site's own header, with the visitor's real signed-in state, and footer. The layout already renders the one main, so ErrorPage is a div. Anything thrown outside the marketing layout still reaches the root boundary's bar.
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
        actions={status === 410 || status === 404 ? undefined : errorActions()}
        dev={import.meta.env.DEV}
      />
    </div>
  );
}
