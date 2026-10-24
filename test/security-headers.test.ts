
import { generateNonce, scriptHash } from "@dustinedwards/site-runtime/csp";
import { PASSKEY_OVERRIDES, STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
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

// RECOVA'S SIX, verbatim from next.config.ts (blob 8cf9b0c7, read through
// Capsid repo "legacy" on 2026-10-14), applied there to every path. Its
// Content-Security-Policy-Report-Only blocked nothing and allowed
// 'unsafe-inline' and 'unsafe-eval'; Foxhound's enforced nonce policy is the
// stricter one. X-DNS-Prefetch-Control is graded separately below: Recova sent
// "on", and "off" (no speculative DNS lookups of linked hosts) is stricter.
// Recova's HSTS carried `preload`; Foxhound's does not on purpose (header-set.ts):
// the token only consents to a preload-list submission and changes nothing in a
// browser until one is made.

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

  it("differs from the OWASP standard only where an override says why", () => {
    const differing = Object.keys({ ...STANDARD_SECURITY_HEADERS, ...SECURITY_HEADERS })
      .filter((name) => STANDARD_SECURITY_HEADERS[name] !== SECURITY_HEADERS[name])
      .sort();
    expect(differing).toEqual(Object.keys(SECURITY_HEADER_OVERRIDES).sort());
    for (const { reason } of Object.values(SECURITY_HEADER_OVERRIDES)) expect(reason.length).toBeGreaterThan(40);
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
    // The Worker's list is site-runtime's passkey list (publickey-credentials
    // allowed for the site's own pages) with clipboard-write added.
    const listed = withClipboardWriteSelf(PASSKEY_OVERRIDES["Permissions-Policy"]?.value ?? "");
    expect(listed.match(/clipboard-write=/g)).toHaveLength(1);
    expect(listed).toBe(SECURITY_HEADERS["Permissions-Policy"]);
    expect(listed).toContain("publickey-credentials-get=(self)");
  });
});

describe("applySecurityHeaders", () => {

  it("leaves a route's own Content-Security-Policy alone", () => {
    const result = applied(new Response(null, { headers: { "Content-Security-Policy": "default-src 'none'" } }));
    expect(result.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });

  it("has exactly one frame-src, so a later sources.frame cannot shadow or be shadowed by the hand-written one", () => {
    const csp = applied().headers.get("Content-Security-Policy") ?? "";
    const frameSrc = csp.split(";").map((d) => d.trim()).filter((d) => d.split(/\s+/)[0]?.toLowerCase() === "frame-src");
    expect(frameSrc).toEqual(["frame-src https://challenges.cloudflare.com"]);
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
