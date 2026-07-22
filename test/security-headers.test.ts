import { describe, expect, it } from "vitest";

import { applySecurityHeaders } from "~/lib/http/security-headers";

// audit finding H-1 (foxhound-audit-security.md): the Worker shipped zero
// security headers on any route. Asserts the full set lands on a rendered
// response, and that pre-existing route headers are preserved, not clobbered.

describe("applySecurityHeaders", () => {
  it("sets the full security header set on a plain rendered response", () => {
    const rendered = new Response("<html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

    const result = applySecurityHeaders(rendered);

    expect(result.headers.get("Content-Type")).toBe("text/html");
    expect(result.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(result.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    const csp = result.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("checkout.stripe.com");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("preserves status, statusText, and body", async () => {
    const rendered = new Response("payload", { status: 503, statusText: "Service Unavailable" });

    const result = applySecurityHeaders(rendered);

    expect(result.status).toBe(503);
    expect(result.statusText).toBe("Service Unavailable");
    await expect(result.text()).resolves.toBe("payload");
  });

  it("preserves a redirect's Location header alongside the security headers", () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });

    const result = applySecurityHeaders(redirect);

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/login");
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("preserves multiple Set-Cookie headers on a response", () => {
    const withCookies = new Response(null, { status: 200 });
    withCookies.headers.append("Set-Cookie", "a=1; Path=/");
    withCookies.headers.append("Set-Cookie", "b=2; Path=/");

    const result = applySecurityHeaders(withCookies);

    expect(result.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("merges onto an existing header of the same name instead of overwriting it", () => {
    const withOwnHeader = new Response(null, {
      status: 200,
      headers: { "X-Frame-Options": "SAMEORIGIN" },
    });

    const result = applySecurityHeaders(withOwnHeader);

    expect(result.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});
