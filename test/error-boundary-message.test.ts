import { describe, expect, it } from "vitest";

import { resolveErrorBoundaryDetails } from "~/lib/errors/boundary-message";

// TASK-foxhound-demo-system-completion.md Phase 1: the root ErrorBoundary must
// show a thrown data(message, { status }) payload's message verbatim, not the
// generic HTTP reason phrase. This is the actual bug behind the "Method Not
// Allowed" crash a demo visitor used to see when a mutating control 405'd:
// appShellMiddleware already threw a friendly string as the response body,
// the boundary just never read it.
//
// isRouteErrorResponse (react-router) duck-types on {status, statusText,
// internal, data}, so a plain object with those four fields is a faithful
// stand-in for the ErrorResponse the router actually constructs from a
// thrown data()/Response, without needing a full router harness.
function routeErrorResponse(status: number, statusText: string, responseData: unknown) {
  return { status, statusText, internal: false, data: responseData };
}

describe("resolveErrorBoundaryDetails", () => {
  it("shows the thrown message verbatim instead of the generic HTTP reason phrase", () => {
    const error = routeErrorResponse(
      405,
      "Method Not Allowed",
      "Actions are disabled in this demo. Explore freely; nothing here can be changed.",
    );
    const { message, details } = resolveErrorBoundaryDetails(error, false);
    expect(message).toBe("Error");
    expect(details).toBe("Actions are disabled in this demo. Explore freely; nothing here can be changed.");
  });

  it("falls back to statusText when the thrown response has no string body", () => {
    const error = routeErrorResponse(500, "Internal Server Error", undefined);
    const { message, details } = resolveErrorBoundaryDetails(error, false);
    expect(message).toBe("Error");
    expect(details).toBe("Internal Server Error");
  });

  it("always shows the fixed not-found copy for 404, ignoring any body", () => {
    const error = routeErrorResponse(404, "Not Found", "some internal detail");
    const { message, details } = resolveErrorBoundaryDetails(error, false);
    expect(message).toBe("404");
    expect(details).toBe("The requested page could not be found.");
  });

  it("shows a real Error's message only in dev, never in production", () => {
    const err = new Error("a real stack trace detail");
    expect(resolveErrorBoundaryDetails(err, true).details).toBe("a real stack trace detail");
    expect(resolveErrorBoundaryDetails(err, false).details).toBe("An unexpected error occurred.");
  });
});
