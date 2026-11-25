import { describe, expect, it } from "vitest";

import { errorDetails } from "~/lib/errors/boundary-message";

// A plain object with the four fields isRouteErrorResponse duck-types on stands in for the router's ErrorResponse.
function routeErrorResponse(status: number, statusText: string, responseData: unknown) {
  return { status, statusText, internal: false, data: responseData };
}

describe("errorDetails", () => {
  it("shows the thrown message verbatim instead of the generic HTTP reason phrase", () => {
    const error = routeErrorResponse(
      405,
      "Method Not Allowed",
      "Actions are disabled in this demo. Explore freely; nothing here can be changed.",
    );
    expect(errorDetails(error, false)).toBe(
      "Actions are disabled in this demo. Explore freely; nothing here can be changed.",
    );
  });

  it("always shows the fixed not-found copy for 404, ignoring any body", () => {
    const error = routeErrorResponse(404, "Not Found", "some internal detail");
    expect(errorDetails(error, false)).toBe("The requested page could not be found.");
  });

  it("shows a real Error's message only in dev, never in production", () => {
    const err = new Error("a real stack trace detail");
    expect(errorDetails(err, true)).toBe("a real stack trace detail");
    expect(errorDetails(err, false)).toBe("An unexpected error occurred.");
  });
});
