import { isRouteErrorResponse } from "react-router";

// Pure message-selection logic for app/root.tsx's ErrorBoundary, split out so
// it is unit-testable without a router/component harness. The one case this
// exists for (TASK-foxhound-demo-system-completion.md Phase 1): a route or
// middleware throws data(SOME_MESSAGE, { status }) - React Router surfaces
// that as error.data - and the boundary must show SOME_MESSAGE verbatim
// instead of falling back to the generic HTTP reason phrase a bare thrown
// Response would otherwise leave it with.

export interface ErrorBoundaryDetails {
  message: string;
  details: string;
}

const DEFAULT_MESSAGE = "Oops!";
const DEFAULT_DETAILS = "An unexpected error occurred.";
const NOT_FOUND_DETAILS = "The requested page could not be found.";

/** `isDev` gates showing a raw Error's message: never in production, never a leak risk. */
export function resolveErrorBoundaryDetails(error: unknown, isDev: boolean): ErrorBoundaryDetails {
  if (isRouteErrorResponse(error)) {
    const message = error.status === 404 ? "404" : "Error";
    if (error.status === 404) return { message, details: NOT_FOUND_DETAILS };
    const bodyMessage = typeof error.data === "string" && error.data.length > 0 ? error.data : null;
    return { message, details: bodyMessage || error.statusText || DEFAULT_DETAILS };
  }
  if (isDev && error instanceof Error) {
    return { message: DEFAULT_MESSAGE, details: error.message };
  }
  return { message: DEFAULT_MESSAGE, details: DEFAULT_DETAILS };
}
