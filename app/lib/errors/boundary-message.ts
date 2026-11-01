import { isRouteErrorResponse } from "react-router";

// Pure message-selection logic for the ErrorBoundaries (app/root.tsx and app/layouts/app-shell.tsx), split out so
// it is unit-testable without a router/component harness. The one case this
// exists for (TASK-foxhound-demo-system-completion.md Phase 1): a route or
// middleware throws data(SOME_MESSAGE, { status }) - React Router surfaces
// that as error.data - and the boundary must show SOME_MESSAGE verbatim
// instead of falling back to the generic HTTP reason phrase a bare thrown
// Response would otherwise leave it with.

const DEFAULT_DETAILS = "An unexpected error occurred.";
const NOT_FOUND_DETAILS = "The requested page could not be found.";

/** The sentence under the error page's title. `isDev` gates showing a raw Error's message: never in production. */
export function errorDetails(error: unknown, isDev: boolean): string {
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) return NOT_FOUND_DETAILS;
    const bodyMessage = typeof error.data === "string" && error.data.length > 0 ? error.data : null;
    return bodyMessage || error.statusText || DEFAULT_DETAILS;
  }
  if (isDev && error instanceof Error) return error.message;
  return DEFAULT_DETAILS;
}
