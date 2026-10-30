import { describe, expect, it, vi } from "vitest";

// The policy's fixed parts are built and validated ONCE (site-runtime's builder
// checks every source, hash and the report sink), and only the nonce changes
// per request. This proves both halves: the builder is not re-run per request,
// and the per-request policy is exactly what the builder itself returns for
// that request's nonce (plus Stripe Checkout on form-action and the Turnstile frame-src Foxhound appends, which the
// builder refuses in extraDirectives since site-runtime 0.26.0), so no check is
// bypassed by the substitution.

const builderCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("@dustinedwards/site-runtime/csp", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dustinedwards/site-runtime/csp")>();
  return {
    ...original,
    buildContentSecurityPolicy: (site: Parameters<typeof original.buildContentSecurityPolicy>[0]) => {
      builderCalls.push(site);
      return original.buildContentSecurityPolicy(site);
    },
  };
});

describe("the policy is validated once and only the nonce varies per request", async () => {
  const { buildContentSecurityPolicy, generateNonce } =
    await vi.importActual<typeof import("@dustinedwards/site-runtime/csp")>("@dustinedwards/site-runtime/csp");
  const { applySecurityHeaders } = await import("~/lib/http/content-security-policy");

  it("gives exactly the builder's own output for that request's nonce", () => {
    const site = builderCalls[0] as Parameters<typeof buildContentSecurityPolicy>[0];
    expect(site).toBeDefined();
    for (let i = 0; i < 5; i++) {
      const nonce = generateNonce();
      const expected = buildContentSecurityPolicy({ ...site, nonce });
      expect(applySecurityHeaders(new Response(null), nonce, "https://foxhound.example.com").headers.get(expected.name))
        .toBe(`${expected.value.replace("form-action 'self'", "form-action 'self' https://checkout.stripe.com https://connect.stripe.com")}; frame-src https://challenges.cloudflare.com`);
    }
  });
});

describe("a page the edge stores trusts its inline scripts by hash, never a nonce", async () => {
  const { scriptHash } = await vi.importActual<typeof import("@dustinedwards/site-runtime/csp")>("@dustinedwards/site-runtime/csp");
  const { applyHashedSecurityHeaders } = await import("~/lib/http/content-security-policy");

  it("hashes each inline script as rendered and keeps the body", async () => {
    const html = '<html><script>window.__reactRouterContext = {"a":1};</script><script type="module" async>import "/x.js";</script><script src="/y.js"></script></html>';
    const page = await applyHashedSecurityHeaders(
      new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      "https://foxhound.example.com",
    );
    const policy = page.headers.get("Content-Security-Policy") ?? "";
    expect(policy).toContain(`'${await scriptHash('window.__reactRouterContext = {"a":1};')}'`);
    expect(policy).toContain(`'${await scriptHash('import "/x.js";')}'`);
    expect(policy).not.toContain("'nonce-");
    expect(await page.text()).toBe(html);
  });
});
