import { isRouteErrorResponse } from "react-router";

// Message selection for the ErrorBoundaries (app/root.tsx, app/layouts/app-shell.tsx), split out so it is
// unit-testable. A route or middleware that throws data(MESSAGE, { status }) surfaces it as error.data, and
// the boundary shows MESSAGE verbatim rather than the generic HTTP reason phrase.

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
