import { readFileSync } from "node:fs";

import { checkSecurityHeaders, failures } from "@dustinedwards/site-runtime/check";
import { generateNonce, scriptHash } from "@dustinedwards/site-runtime/csp";
import { STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
import { runOshpSuite } from "@dustinedwards/site-runtime/oshp";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  BLOG_COVER_FALLBACK_CSS,
  DIAGRAM_STYLE_HASHES,
  FEATURE_FILTER_CSS,
  INLINE_STYLE_HASHES,
} from "~/lib/http/inline-styles";
import {
  applySecurityHeaders,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
} from "~/lib/http/content-security-policy";
import { SECURITY_HEADER_OVERRIDES, SECURITY_HEADERS, withClipboardWriteSelf } from "~/lib/http/header-set";

// audit finding H-1 (foxhound-audit-security.md): the Worker shipped zero
// security headers on any route. Since J22 (F16, RULES.md 4.2, Q4) the set is
// site-runtime's OWASP standard with Foxhound's overrides, and the CSP comes from
// site-runtime's builder with the nonce still made in the Worker.
//
// CSP nonce (TASK-foxhound-csp-nonce-hydration.md): the original no-nonce
// script-src silently blocked React Router 8's own inline bootstrap/
// hydration scripts, killing every client handler on the site. Do not
// regress to a bare 'self' script-src; the nonce is load-bearing.

// OSHP's validator cases this set fails ON PURPOSE, named so a change to the
// set or to the suite shows up as a changed list: the four site-runtime skips
// (OWASP_SKIPPED) plus Foxhound's two overrides.
const OSHP_EXPECTED_FAILURES = [
  "Cache-Control", // skipped by site-runtime: set per route by cache-policy.ts
  "Clear-Site-Data", // skipped by site-runtime: logout responses only
  "Content-Security-Policy", // skipped by site-runtime: built per site, with the nonce
  "Cross-Origin-Embedder-Policy", // skipped by site-runtime: breaks cross-origin subresources
  "Permissions-Policy", // Foxhound override: clipboard-write=(self)
  "Referrer-Policy", // Foxhound override: strict-origin-when-cross-origin
];

const TEST_NONCE = "dGVzdC1ub25jZS12YWx1ZTAw";
const TEST_ORIGIN = "https://foxhound.example.com";

function directive(csp: string, name: string): string {
  return (
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d === name || d.startsWith(`${name} `)) ?? ""
  );
}

function applied(response: Response = new Response("<html></html>", { headers: { "Content-Type": "text/html" } })) {
  return applySecurityHeaders(response, TEST_NONCE, TEST_ORIGIN);
}

// FOXHOUND'S SET BEFORE J22, verbatim from the deleted
// app/lib/http/security-headers.ts. RULES.md 4.1: where Foxhound was stricter
// than a new default, it stays at least this strict. checkSecurityHeaders grades
// "at least as strict" per header (HSTS age, a strict Referrer-Policy, framing
// refused, every denied feature still denied, exact match otherwise).
const FOXHOUND_BEFORE_J22: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// RECOVA'S SIX, verbatim from next.config.ts (blob 8cf9b0c7, read through
// Capsid repo "legacy" on 2026-10-14), applied there to every path. Its
// Content-Security-Policy-Report-Only blocked nothing and allowed
// 'unsafe-inline' and 'unsafe-eval'; Foxhound's enforced nonce policy is the
// stricter one. X-DNS-Prefetch-Control is graded separately below: Recova sent
// "on", and "off" (no speculative DNS lookups of linked hosts) is stricter.
// Recova's HSTS carried `preload`; Foxhound's does not on purpose (header-set.ts):
// the token only consents to a preload-list submission and changes nothing in a
// browser until one is made.
const RECOVA_NEXT_CONFIG: Readonly<Record<string, string>> = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

describe("generateNonce (site-runtime/csp, the same algorithm Foxhound had)", () => {
  it("returns a base64 string at least 22 characters long", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(22);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("is different on every call (cryptographically random, not a fixed value)", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateNonce()));
    expect(seen.size).toBe(20);
  });
});

describe("the declared header set (site-runtime standard plus Foxhound's overrides)", () => {
  it("passes site-runtime's check against the set Foxhound declared, CSP included", () => {
    const result = failures(
      checkSecurityHeaders(applied().headers, { standard: SECURITY_HEADERS, cloudflareWebAnalytics: true }),
    );
    expect(result).toEqual([]);
  });

  it("is never weaker than Foxhound's own pre-J22 set (RULES.md 4.1)", () => {
    const result = failures(checkSecurityHeaders(applied().headers, { standard: FOXHOUND_BEFORE_J22, csp: false }));
    expect(result).toEqual([]);
  });

  it("is never weaker than Recova's next.config.ts set", () => {
    const headers = applied().headers;
    expect(failures(checkSecurityHeaders(headers, { standard: RECOVA_NEXT_CONFIG, csp: false }))).toEqual([]);
    expect(headers.get("X-DNS-Prefetch-Control")).toBe("off");
    expect(headers.get("X-Frame-Options")?.toLowerCase()).toBe("deny");
  });

  it("differs from the OWASP standard only where an override says why", () => {
    const differing = Object.keys({ ...STANDARD_SECURITY_HEADERS, ...SECURITY_HEADERS })
      .filter((name) => STANDARD_SECURITY_HEADERS[name] !== SECURITY_HEADERS[name])
      .sort();
    expect(differing).toEqual(Object.keys(SECURITY_HEADER_OVERRIDES).sort());
    for (const { reason } of Object.values(SECURITY_HEADER_OVERRIDES)) expect(reason.length).toBeGreaterThan(40);
  });

  it("keeps HSTS without preload and at least a year (no preload until the apex is verified HTTPS-only)", () => {
    const hsts = applied().headers.get("Strict-Transport-Security") ?? "";
    expect(hsts).toBe("max-age=63072000; includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("keeps Referrer-Policy at strict-origin-when-cross-origin, so same-origin POSTs keep their Origin", () => {
    expect(applied().headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("denies camera, microphone, geolocation and payment and the rest of OWASP's list, except clipboard-write for this origin", () => {
    const policy = applied().headers.get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "clipboard-read", "fullscreen"]) {
      expect(policy).toContain(`${feature}=()`);
    }
    expect(policy).toContain("clipboard-write=(self)");
    expect(policy).not.toContain("clipboard-write=()");
  });

  it("still finds clipboard-write in OWASP's upstream list (a change upstream fails CI, not the Worker's start)", () => {
    const features = (STANDARD_SECURITY_HEADERS["Permissions-Policy"] ?? "").split(",").map((d) => d.trim().split("=")[0]);
    expect(features).toContain("clipboard-write");
  });

  it("sets clipboard-write=(self) by parsing the list, whatever the upstream spelling", () => {
    const spaced = withClipboardWriteSelf("camera=(),clipboard-write=( ),  usb=()");
    expect(spaced.split(", ")).toEqual(["camera=()", "clipboard-write=(self)", "usb=()"]);
    const absent = withClipboardWriteSelf("camera=(), usb=()");
    expect(absent.split(", ")).toEqual(["camera=()", "usb=()", "clipboard-write=(self)"]);
    const listed = withClipboardWriteSelf(STANDARD_SECURITY_HEADERS["Permissions-Policy"] ?? "");
    expect(listed.match(/clipboard-write=/g)).toHaveLength(1);
    expect(listed).toBe(SECURITY_HEADERS["Permissions-Policy"]);
  });

  it("runs OWASP's own validator suite and fails exactly the cases Foxhound skips or overrides on purpose", () => {
    const suite = parseYaml(
      readFileSync("node_modules/@dustinedwards/site-runtime/oshp-tests-suite.yml", "utf8"),
    ) as Parameters<typeof runOshpSuite>[0];
    const page = applied();
    const results = runOshpSuite(suite, { page: { status: page.status, headers: page.headers } });
    // Control: a suite that ran nothing would also fail nothing.
    expect(results.filter((r) => r.pass).length).toBeGreaterThan(8);
    const failed = results.filter((r) => !r.pass).map((r) => r.name).sort();
    expect(failed).toEqual(OSHP_EXPECTED_FAILURES);
  });
});

describe("applySecurityHeaders", () => {
  it("sets the full set and the nonce CSP on a plain rendered response", () => {
    const result = applied();

    expect(result.headers.get("Content-Type")).toBe("text/html");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(result.headers.get(name)).toBe(value);
    expect(result.headers.get("X-Frame-Options")?.toLowerCase()).toBe("deny");
    const csp = result.headers.get("Content-Security-Policy") ?? "";
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "script-src")).toContain(`'nonce-${TEST_NONCE}'`);
    expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data:");
    expect(csp).not.toContain("checkout.stripe.com");
  });

  it("carries a distinct nonce per call, matching whatever value is passed in", () => {
    const a = applySecurityHeaders(new Response(null), generateNonce(), TEST_ORIGIN);
    const b = applySecurityHeaders(new Response(null), generateNonce(), TEST_ORIGIN);
    expect(a.headers.get("Content-Security-Policy")).not.toBe(b.headers.get("Content-Security-Policy"));
  });

  it("preserves status, statusText, and body", async () => {
    const result = applied(new Response("payload", { status: 503, statusText: "Service Unavailable" }));
    expect(result.status).toBe(503);
    expect(result.statusText).toBe("Service Unavailable");
    await expect(result.text()).resolves.toBe("payload");
  });

  it("preserves a redirect's Location header alongside the security headers", () => {
    const result = applied(new Response(null, { status: 302, headers: { Location: "/login" } }));
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/login");
    expect(result.headers.get("X-Frame-Options")).toBe(SECURITY_HEADERS["X-Frame-Options"]);
  });

  it("works on a Response whose headers are immutable (Response.redirect)", () => {
    const result = applied(Response.redirect("https://example.com/next", 301));
    expect(result.status).toBe(301);
    expect(result.headers.get("Location")).toBe("https://example.com/next");
    expect(result.headers.get("Content-Security-Policy")).toContain(`'nonce-${TEST_NONCE}'`);
  });

  it("preserves multiple Set-Cookie headers on a response", () => {
    const withCookies = new Response(null, { status: 200 });
    withCookies.headers.append("Set-Cookie", "a=1; Path=/");
    withCookies.headers.append("Set-Cookie", "b=2; Path=/");
    expect(applied(withCookies).headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("merges onto an existing header of the same name instead of overwriting it", () => {
    const result = applied(new Response(null, { status: 200, headers: { "X-Frame-Options": "SAMEORIGIN" } }));
    expect(result.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("leaves a route's own Content-Security-Policy alone", () => {
    const result = applied(new Response(null, { headers: { "Content-Security-Policy": "default-src 'none'" } }));
    expect(result.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });

  // Cloudflare Web Analytics injects its beacon at the edge; public sites allow it
  // (Dustin's ruling, 2026-10-03). It reports to this origin's /cdn-cgi/rum, so
  // connect-src must stay 'self'. Turnstile is the only other external host.
  it("allows exactly Turnstile and the Web Analytics beacon path as external script hosts", () => {
    const csp = applied().headers.get("Content-Security-Policy") ?? "";
    const hosts = directive(csp, "script-src")
      .split(" ")
      .filter((token) => token.startsWith("https://"));
    expect(hosts).toEqual([
      "https://challenges.cloudflare.com",
      "https://static.cloudflareinsights.com/beacon.min.js",
      "https://static.cloudflareinsights.com/beacon.min.js/",
    ]);
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
  });

  it("has exactly one frame-src, so a later sources.frame cannot shadow or be shadowed by the hand-written one", () => {
    const csp = applied().headers.get("Content-Security-Policy") ?? "";
    const frameSrc = csp.split(";").map((d) => d.trim()).filter((d) => d.split(/\s+/)[0]?.toLowerCase() === "frame-src");
    expect(frameSrc).toEqual(["frame-src https://challenges.cloudflare.com"]);
  });

  it("frames only Turnstile: frame-src is no wider than before J22 (no 'self')", () => {
    const csp = applied().headers.get("Content-Security-Policy") ?? "";
    expect(directive(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
  });

  it("styles: no 'unsafe-inline' element styles; attributes allowed; the nonce and the inline <style> hashes", () => {
    const csp = applied().headers.get("Content-Security-Policy") ?? "";
    const style = directive(csp, "style-src");
    expect(style).not.toContain("'unsafe-inline'");
    expect(style).toContain(`'nonce-${TEST_NONCE}'`);
    for (const hash of INLINE_STYLE_HASHES) expect(style).toContain(`'${hash}'`);
    expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });

  it("reports violations to this origin's endpoint, by report-uri and report-to", () => {
    const result = applied();
    const csp = result.headers.get("Content-Security-Policy") ?? "";
    expect(directive(csp, "report-uri")).toBe(`report-uri ${CSP_REPORT_PATH}`);
    expect(directive(csp, "report-to")).toBe(`report-to ${CSP_REPORT_GROUP}`);
    expect(result.headers.get("Reporting-Endpoints")).toBe(`${CSP_REPORT_GROUP}="${TEST_ORIGIN}${CSP_REPORT_PATH}"`);
  });
});

describe("inline <style> elements are trusted by hash, never by 'unsafe-inline'", () => {
  it("each hash is the SHA-256 of the exact CSS the page renders", async () => {
    const computed = await Promise.all([FEATURE_FILTER_CSS, BLOG_COVER_FALLBACK_CSS].map((css) => scriptHash(css)));
    // The diagram hashes are recomputed from public/diagrams/ by
    // test/blog-diagrams-j25.test.ts; here they are only set apart.
    const own = INLINE_STYLE_HASHES.filter((h) => !DIAGRAM_STYLE_HASHES.includes(h));
    expect(own.length + DIAGRAM_STYLE_HASHES.length).toBe(INLINE_STYLE_HASHES.length);
    expect([...own].sort()).toEqual(computed.sort());
  });

  it("every <style> element in app/ renders one of the hashed constants", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync("git grep -n '<style' -- 'app/*.tsx' || true", { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    // Control: the two known elements must be found, or the search proves nothing.
    expect(hits.length).toBe(2);
    for (const hit of hits) expect(hit).toMatch(/<style>\{(FEATURE_FILTER_CSS|BLOG_COVER_FALLBACK_CSS)\}<\/style>/);
  });
});
